import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { watch as chokidarWatch } from 'chokidar';
import picomatch from 'picomatch';
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
  MAX_MATCH_TEXT_CHARS,
  MAX_SEARCH_RESULTS,
} from './limits.ts';
import {
  baseName,
  isMarkdownPath,
  normalizeVaultPath,
  parentDir,
  RESERVED_DIR,
  TRASH_DIR,
} from './path-policy.ts';
import { applyTextPatches, unifiedDiff } from './text-diff.ts';
import {
  type BatchReadResult,
  type BatchResult,
  type Caps,
  type ChangeEvent,
  type EditResult,
  type Entry,
  type FmUpdate,
  type ListOpts,
  type Match,
  type Note,
  type SearchOpts,
  type StorageAdapter,
  type TextPatch,
  type Unsubscribe,
  VaultError,
  type WriteOpts,
} from './types.ts';

const execFileAsync = promisify(execFile);
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

export interface LocalFSOptions {
  ripgrepPath?: string | null;
  watchPollMs?: number | null;
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

/** Best-effort normalization for error reporting: falls back to the raw input when it doesn't even normalize. */
function normalizedOrRaw(raw: unknown): string {
  try {
    return normalizeVaultPath(raw);
  } catch {
    return String(raw);
  }
}

/** Windows a search match's line text so one very long line cannot blow the result-size cap. */
function windowMatchText(text: string): string {
  return text.length > MAX_MATCH_TEXT_CHARS ? `${text.slice(0, MAX_MATCH_TEXT_CHARS)}…` : text;
}

export class LocalFSAdapter implements StorageAdapter {
  private static readonly TEXT_EXTENSIONS = new Set([
    '.md',
    '.markdown',
    '.txt',
    '.canvas',
    '.json',
    '.csv',
  ]);

  readonly root: string;
  private readonly rg: string | null;
  private readonly watchPollMs: number | null;

  private constructor(root: string, rg: string | null, watchPollMs: number | null) {
    this.root = root;
    this.rg = rg;
    this.watchPollMs = watchPollMs;
  }

  static async create(rootDir: string, opts: LocalFSOptions = {}): Promise<LocalFSAdapter> {
    await fs.mkdir(rootDir, { recursive: true });
    const root = await fs.realpath(rootDir);
    const rg = opts.ripgrepPath === undefined ? await detectRipgrep() : opts.ripgrepPath;
    return new LocalFSAdapter(root, rg, opts.watchPollMs ?? null);
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

  /**
   * Resolves symlinks of the deepest existing ancestor and asserts it stays inside the vault root.
   *
   * Accepted TOCTOU window: this is a check, not a lock. Between this check and the subsequent
   * mkdir/writeFile/rename, a directory in the path could in principle be swapped for a symlink
   * and redirect the write outside the root. In this single-user local-vault threat model (no
   * concurrent untrusted writers to the filesystem itself) that window is not considered
   * exploitable; revisit with real locking if this adapter is ever used multi-tenant on a shared
   * filesystem.
   */
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
          result.failed.push({ path: normalizedOrRaw(raw), error: error.message });
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
    const suffix = content.endsWith('\n') ? '' : '\n';
    const next = `${existing}${separator}${content}${suffix}`;
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
          result.failed.push({ path: normalizedOrRaw(update.path), error: error.message });
        } else {
          throw error;
        }
      }
    }
    return result;
  }

  // ---- navigation ----------------------------------------------------------

  async list(prefix = '', opts: ListOpts = {}): Promise<Entry[]> {
    const base = normalizeVaultPath(prefix);
    const depth = opts.depth ?? 1;
    const includeFiles = opts.includeFiles ?? true;
    const includeDirs = opts.includeDirs ?? true;
    const matcher = opts.glob ? picomatch(opts.glob, { dot: false }) : null;

    const baseAbs = this.abs(base);
    await this.assertInsideRoot(baseAbs);
    const baseStat = await this.statOrNull(baseAbs);
    if (!baseStat) throw new VaultError('NOT_FOUND', `${base || '/'} does not exist.`);
    if (!baseStat.isDirectory())
      throw new VaultError('INVALID_INPUT', `${base} is a file, not a folder.`);

    const out: Entry[] = [];
    const walk = async (dir: string, level: number): Promise<void> => {
      const dirents = await fs.readdir(this.abs(dir), { withFileTypes: true });
      dirents.sort((a, b) => a.name.localeCompare(b.name, 'en'));
      for (const dirent of dirents) {
        if (dirent.name.startsWith('.')) continue;
        if (dir === '' && dirent.name === RESERVED_DIR) continue;
        const rel = dir === '' ? dirent.name : `${dir}/${dirent.name}`;
        const relToBase = base === '' ? rel : rel.slice(base.length + 1);
        const matches = matcher === null || matcher(relToBase);
        if (dirent.isDirectory()) {
          if (includeDirs && matches) out.push({ path: rel, kind: 'dir' });
          if (level < depth) await walk(rel, level + 1);
        } else if (dirent.isFile() && includeFiles && matches) {
          const stat = await fs.stat(this.abs(rel));
          out.push({
            path: rel,
            kind: 'file',
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          });
        }
      }
    };
    await walk(base, 1);
    return out;
  }

  async move(fromInput: string, toInput: string): Promise<void> {
    const from = requireFilePath(fromInput);
    const to = requireFilePath(toInput);
    const fromAbs = this.abs(from);
    const toAbs = this.abs(to);
    await this.assertInsideRoot(fromAbs);
    await this.assertInsideRoot(toAbs);
    if (!(await this.statOrNull(fromAbs)))
      throw new VaultError('NOT_FOUND', `${from} does not exist.`);
    if (await this.statOrNull(toAbs))
      throw new VaultError('ALREADY_EXISTS', `${to} already exists.`);
    await fs.mkdir(path.dirname(toAbs), { recursive: true });
    try {
      await fs.rename(fromAbs, toAbs);
    } catch {
      throw new VaultError('IO', `Failed to move ${from} to ${to}.`);
    }
  }

  async softDelete(inputPath: string, confirm: boolean): Promise<void> {
    if (confirm !== true) {
      throw new VaultError(
        'CONFIRM_REQUIRED',
        'Deletion requires confirm=true. The file is moved to .trash/ (not erased) and can be restored manually.',
      );
    }
    const p = requireFilePath(inputPath);
    const fromAbs = this.abs(p);
    await this.assertInsideRoot(fromAbs);
    if (!(await this.statOrNull(fromAbs)))
      throw new VaultError('NOT_FOUND', `${p} does not exist.`);

    let target = normalizeVaultPath(`${TRASH_DIR}/${p}`, { allowInternal: true });
    if (await this.statOrNull(this.abs(target))) {
      const name = baseName(p);
      const dot = name.lastIndexOf('.');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const stamped =
        dot > 0 ? `${name.slice(0, dot)}.${stamp}${name.slice(dot)}` : `${name}.${stamp}`;
      const dir = parentDir(p);
      target = normalizeVaultPath(`${TRASH_DIR}/${dir === '' ? stamped : `${dir}/${stamped}`}`, {
        allowInternal: true,
      });
    }
    const toAbs = this.abs(target);
    await this.assertInsideRoot(toAbs);
    await fs.mkdir(path.dirname(toAbs), { recursive: true });
    try {
      await fs.rename(fromAbs, toAbs);
    } catch {
      throw new VaultError('IO', `Failed to move ${p} to trash.`);
    }
  }

  // ---- search --------------------------------------------------------------

  async search(query: string, opts: SearchOpts = {}): Promise<Match[]> {
    if (typeof query !== 'string' || query.trim() === '') {
      throw new VaultError('INVALID_INPUT', 'Search query must not be empty.');
    }
    const limit = Math.max(1, Math.min(opts.limit ?? MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS));
    const prefix = normalizeVaultPath(opts.pathPrefix ?? '');
    const caseSensitive = opts.caseSensitive ?? false;

    const prefixAbs = this.abs(prefix);
    await this.assertInsideRoot(prefixAbs);
    const st = await this.statOrNull(prefixAbs);
    if (!st) throw new VaultError('NOT_FOUND', `${prefix || '/'} does not exist.`);
    if (!st.isDirectory())
      throw new VaultError('INVALID_INPUT', `${prefix} is a file, not a folder.`);

    const matches = this.rg
      ? await this.searchRipgrep(query, prefix, limit, caseSensitive)
      : await this.searchJs(query, prefix, limit, caseSensitive);
    return matches.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
  }

  private async searchJs(
    query: string,
    prefix: string,
    limit: number,
    caseSensitive: boolean,
  ): Promise<Match[]> {
    const files = await this.list(prefix, { depth: Number.POSITIVE_INFINITY, includeDirs: false });
    const needle = caseSensitive ? query : query.toLowerCase();
    const out: Match[] = [];
    for (const file of files) {
      if (!LocalFSAdapter.TEXT_EXTENSIONS.has(path.extname(file.path).toLowerCase())) continue;
      let text: string;
      try {
        text = strictUtf8.decode(await fs.readFile(this.abs(file.path)));
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && out.length < limit; i += 1) {
        const line = lines[i] ?? '';
        const haystack = caseSensitive ? line : line.toLowerCase();
        if (haystack.includes(needle))
          out.push({ path: file.path, line: i + 1, text: windowMatchText(line.trimEnd()) });
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  private async searchRipgrep(
    query: string,
    prefix: string,
    limit: number,
    caseSensitive: boolean,
  ): Promise<Match[]> {
    if (!this.rg) return [];
    const args = [
      '--json',
      '--fixed-strings',
      '--no-messages',
      '--no-ignore',
      caseSensitive ? '--case-sensitive' : '--ignore-case',
      '--max-count',
      String(limit),
      ...[...LocalFSAdapter.TEXT_EXTENSIONS].flatMap((ext) => ['--glob', `*${ext}`]),
      // ripgrep applies "last matching glob wins", so these excludes must come after the
      // extension includes above — otherwise an unanchored include like `*.md` would re-include
      // everything under an excluded directory that happens to have an allowed extension.
      '--glob',
      '!.*',
      '--glob',
      '!**/.*/**',
      // A leading '/' anchors this glob to `cwd` (set below to the vault root) rather than to
      // wherever the server process happens to be running, and rather than matching the
      // `_brainstem` basename at any depth — so a legitimate nested look-alike such as
      // `notes/_brainstem/x.md` is still searchable.
      '--glob',
      `!/${RESERVED_DIR}/**`,
      '--',
      query,
      this.abs(prefix),
    ];
    const rg = this.rg;
    const out: Match[] = [];
    return await new Promise<Match[]>((resolve, reject) => {
      const child = spawn(rg, args, { cwd: this.root, stdio: ['ignore', 'pipe', 'pipe'] });
      let killedForLimit = false;
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };
      child.stderr?.resume(); // drain, never surfaced (may contain vault paths)
      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        if (killedForLimit || line === '') return;
        let event: {
          type: string;
          data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
        };
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type !== 'match' || !event.data?.path?.text) return;
        const text = (event.data.lines?.text ?? '').replace(/\r?\n$/, '');
        out.push({
          path: this.rel(event.data.path.text),
          line: event.data.line_number ?? 0,
          text: windowMatchText(text),
        });
        if (out.length >= limit) {
          killedForLimit = true;
          rl.close();
          child.kill();
        }
      });
      child.on('error', () => {
        finish(() => reject(new VaultError('IO', 'Search failed.')));
      });
      child.on('close', (exitCode) => {
        finish(() => {
          if (killedForLimit || exitCode === 0 || exitCode === 1) {
            resolve(out); // exit 1 == ripgrep found no matches
          } else {
            reject(new VaultError('IO', 'Search failed.'));
          }
        });
      });
    });
  }

  // ---- watch ---------------------------------------------------------------

  watch(onChange: (event: ChangeEvent) => void): Unsubscribe {
    const watcher = chokidarWatch(this.root, {
      ignoreInitial: true,
      ignored: (absPath: string) => {
        if (absPath === this.root) return false;
        if (path.basename(absPath).startsWith('.')) return true;
        return path.relative(this.root, absPath).split(path.sep)[0] === RESERVED_DIR;
      },
      awaitWriteFinish: false,
      ...(this.watchPollMs
        ? { usePolling: true, interval: this.watchPollMs, binaryInterval: this.watchPollMs }
        : {}),
    });
    watcher.on('add', (abs) => onChange({ type: 'create', path: this.rel(abs) }));
    watcher.on('change', (abs) => onChange({ type: 'update', path: this.rel(abs) }));
    watcher.on('unlink', (abs) => onChange({ type: 'delete', path: this.rel(abs) }));
    return () => {
      void watcher.close();
    };
  }
}
