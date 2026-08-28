import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  applyFrontmatterUpdate,
  joinFrontmatter,
  mergeFrontmatter,
  splitFrontmatter,
} from './frontmatter.ts';
import {
  assertBatchSize,
  assertWithinSize,
  BINARY_MIME_ALLOWLIST,
  extensionAllowedFor,
} from './limits.ts';
import { isMarkdownPath, normalizeVaultPath } from './path-policy.ts';
import { applyTextPatches, unifiedDiff } from './text-diff.ts';
import {
  type BatchReadResult,
  type BatchResult,
  type Caps,
  type EditResult,
  type FmUpdate,
  type Note,
  type TextPatch,
  VaultError,
  type WriteOpts,
} from './types.ts';

const execFileAsync = promisify(execFile);
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

export interface LocalFSOptions {
  ripgrepPath?: string | null;
}

async function detectRipgrep(): Promise<string | null> {
  try {
    await execFileAsync('rg', ['--version']);
    return 'rg';
  } catch {
    return null;
  }
}

function requireFilePath(input: unknown): string {
  const p = normalizeVaultPath(input);
  if (p === '')
    throw new VaultError('INVALID_PATH', 'A file path is required (got the vault root).');
  return p;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
  );
}

export class LocalFSAdapter {
  readonly root: string;
  private readonly rg: string | null;

  private constructor(root: string, rg: string | null) {
    this.root = root;
    this.rg = rg;
  }

  static async create(rootDir: string, opts: LocalFSOptions = {}): Promise<LocalFSAdapter> {
    await fs.mkdir(rootDir, { recursive: true });
    const root = await fs.realpath(rootDir);
    const rg = opts.ripgrepPath === undefined ? await detectRipgrep() : opts.ripgrepPath;
    return new LocalFSAdapter(root, rg);
  }

  capabilities(): Caps {
    return { atomicWrites: true, nativeSearch: this.rg !== null, watch: true, revisions: false };
  }

  // ---- path resolution -------------------------------------------------

  protected abs(vaultPath: string): string {
    return vaultPath === '' ? this.root : path.join(this.root, ...vaultPath.split('/'));
  }

  protected rel(absPath: string): string {
    return path.relative(this.root, absPath).split(path.sep).join('/');
  }

  /** Resolves symlinks of the deepest existing ancestor and asserts it stays inside the vault root. */
  protected async assertInsideRoot(absPath: string): Promise<void> {
    let probe = absPath;
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        if (real !== this.root && !real.startsWith(this.root + path.sep)) {
          throw new VaultError('INVALID_PATH', 'Path resolves outside the vault root.');
        }
        return;
      } catch (error) {
        if (error instanceof VaultError) throw error;
        if (!isEnoent(error)) throw new VaultError('IO', 'Could not resolve path.');
        const parent = path.dirname(probe);
        if (parent === probe) throw new VaultError('IO', 'Could not resolve vault root.');
        probe = parent;
      }
    }
  }

  protected async statOrNull(absPath: string): Promise<Stats | null> {
    try {
      return await fs.stat(absPath);
    } catch (error) {
      if (isEnoent(error)) return null;
      throw new VaultError('IO', `Could not stat ${this.rel(absPath)}.`);
    }
  }

  // ---- read ---------------------------------------------------------------

  async read(inputPath: string): Promise<Note> {
    const p = requireFilePath(inputPath);
    const abs = this.abs(p);
    await this.assertInsideRoot(abs);
    const stat = await this.statOrNull(abs);
    if (!stat) throw new VaultError('NOT_FOUND', `${p} does not exist.`);
    if (stat.isDirectory()) throw new VaultError('INVALID_INPUT', `${p} is a folder, not a file.`);
    const bytes = await fs.readFile(abs);
    return this.toNote(p, bytes, stat);
  }

  protected toNote(p: string, bytes: Buffer, stat: Stats): Note {
    let content: string;
    try {
      content = strictUtf8.decode(bytes);
    } catch {
      throw new VaultError('ENCODING', `${p} is not valid UTF-8 text.`);
    }
    let frontmatter: Record<string, unknown> = {};
    let body = content;
    let hasFrontmatter = false;
    if (isMarkdownPath(p)) {
      try {
        ({ frontmatter, body, hasFrontmatter } = splitFrontmatter(content));
      } catch (error) {
        // Invalid YAML must never block reading; the note is exposed as body-only.
        if (!(error instanceof VaultError)) throw error;
      }
    }
    return {
      path: p,
      content,
      frontmatter,
      body,
      hasFrontmatter,
      meta: { size: stat.size, modifiedAt: stat.mtime.toISOString() },
    };
  }

  async batchRead(paths: string[]): Promise<BatchReadResult> {
    assertBatchSize(paths.length);
    const result: BatchReadResult = { notes: [], missing: [], failed: [] };
    for (const raw of paths) {
      try {
        result.notes.push(await this.read(raw));
      } catch (error) {
        if (error instanceof VaultError && error.code === 'NOT_FOUND') {
          result.missing.push(normalizeVaultPath(raw));
        } else if (error instanceof VaultError) {
          result.failed.push({ path: String(raw), error: error.message });
        } else {
          throw error;
        }
      }
    }
    return result;
  }

  // ---- write --------------------------------------------------------------

  protected async atomicWrite(p: string, bytes: Uint8Array): Promise<void> {
    const abs = this.abs(p);
    await this.assertInsideRoot(abs);
    const dir = path.dirname(abs);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(abs)}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await fs.writeFile(tmp, bytes, { flag: 'wx' });
      await fs.rename(tmp, abs);
    } catch {
      await fs.rm(tmp, { force: true });
      throw new VaultError('IO', `Failed to write ${p}.`);
    }
  }

  async write(inputPath: string, content: string, opts: WriteOpts = {}): Promise<void> {
    const p = requireFilePath(inputPath);
    assertWithinSize(Buffer.byteLength(content, 'utf8'), 'Content');
    let finalContent = content;
    if (opts.mergeFrontmatter && isMarkdownPath(p)) {
      const incoming = splitFrontmatter(content);
      let existingFm: Record<string, unknown> = {};
      try {
        existingFm = (await this.read(p)).frontmatter;
      } catch (error) {
        if (!(error instanceof VaultError && error.code === 'NOT_FOUND')) throw error;
      }
      finalContent = joinFrontmatter(
        mergeFrontmatter(existingFm, incoming.frontmatter),
        incoming.body,
      );
      assertWithinSize(Buffer.byteLength(finalContent, 'utf8'), 'Merged content');
    }
    await this.atomicWrite(p, Buffer.from(finalContent, 'utf8'));
  }

  async writeBinary(inputPath: string, bytes: Uint8Array, mime: string): Promise<void> {
    const p = requireFilePath(inputPath);
    if (!BINARY_MIME_ALLOWLIST.has(mime.toLowerCase())) {
      throw new VaultError(
        'INVALID_INPUT',
        `Media type ${mime} is not allowed. Allowed: ${[...BINARY_MIME_ALLOWLIST.keys()].join(', ')}.`,
      );
    }
    if (!extensionAllowedFor(mime, p)) {
      throw new VaultError(
        'INVALID_INPUT',
        `File extension of ${p} does not match media type ${mime}.`,
      );
    }
    assertWithinSize(bytes.byteLength, 'Binary content');
    await this.atomicWrite(p, bytes);
  }

  async edit(inputPath: string, patches: TextPatch[], dryRun = false): Promise<EditResult> {
    const note = await this.read(inputPath);
    const { content, applied } = applyTextPatches(note.content, patches);
    const diff = unifiedDiff(note.path, note.content, content);
    if (!dryRun) {
      assertWithinSize(Buffer.byteLength(content, 'utf8'), 'Edited content');
      await this.atomicWrite(note.path, Buffer.from(content, 'utf8'));
    }
    return { path: note.path, applied, diff, dryRun };
  }

  async append(inputPath: string, content: string): Promise<void> {
    const p = requireFilePath(inputPath);
    let existing = '';
    try {
      existing = (await this.read(p)).content;
    } catch (error) {
      if (!(error instanceof VaultError && error.code === 'NOT_FOUND')) throw error;
    }
    const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    const next = `${existing}${separator}${content}`;
    assertWithinSize(Buffer.byteLength(next, 'utf8'), 'Appended content');
    await this.atomicWrite(p, Buffer.from(next, 'utf8'));
  }

  async batchFrontmatterUpdate(updates: FmUpdate[]): Promise<BatchResult> {
    assertBatchSize(updates.length);
    const result: BatchResult = { updated: [], failed: [] };
    for (const update of updates) {
      try {
        const p = requireFilePath(update.path);
        if (!isMarkdownPath(p)) {
          throw new VaultError('INVALID_INPUT', `${p} is not a markdown file.`);
        }
        const note = await this.read(p);
        const fm = applyFrontmatterUpdate(note.frontmatter, update.set, update.unset);
        const text = joinFrontmatter(fm, note.body);
        assertWithinSize(Buffer.byteLength(text, 'utf8'), 'Updated content');
        await this.atomicWrite(p, Buffer.from(text, 'utf8'));
        result.updated.push(p);
      } catch (error) {
        if (error instanceof VaultError) {
          result.failed.push({ path: String(update.path), error: error.message });
        } else {
          throw error;
        }
      }
    }
    return result;
  }
}
