import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  createReadStream,
  type Dirent,
  promises as fs,
  realpath as realpathCallback,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { watch as chokidarWatch } from 'chokidar';
import picomatch from 'picomatch';
import { sha256hex } from '../auth/hash.ts';
import { compileSafeSearch, type SafeSearchMatcher } from '../vault/safe-regex.ts';
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
  clampMatchText,
  extensionAllowedFor,
  MAX_BINARY_BYTES,
  MAX_SEARCH_PATHS,
  MAX_SEARCH_PATTERN_CHARS,
  MAX_SEARCH_RESULTS,
  MAX_SEARCH_SCAN,
} from './limits.ts';
import {
  baseName,
  isMarkdownPath,
  isReservedPath,
  normalizedOrRaw,
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
  failedEntryMessage,
  type ListOpts,
  type Match,
  type MutateOpts,
  type Note,
  type SearchOpts,
  type StorageAdapter,
  type TextPatch,
  type Unsubscribe,
  VaultError,
  type WriteOpts,
} from './types.ts';
import { assertExpectedHash } from './write-gate.ts';

const execFileAsync = promisify(execFile);
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
/** `fs.realpath.native` (not the JS-implemented `fs.promises.realpath`): on Windows and macOS it
 *  asks the OS for the true on-disk spelling of a path instead of relying on a cached lookup, so
 *  it is the one that can tell a caller-supplied case from the real one. */
const defaultRealpathNative = promisify(realpathCallback.native);

export interface LocalFSOptions {
  ripgrepPath?: string | null;
  watchPollMs?: number | null;
  /** Cap for `writeBinary`. Defaults to `MAX_BINARY_BYTES`; text writes are unaffected. */
  maxBinaryBytes?: number;
  /** Forces whether the vault's filesystem folds letter case, instead of the one-time detection
   *  `LocalFSAdapter.create` does by default. For tests only: it lets the case-mismatch check be
   *  exercised on a case-sensitive CI runner (together with `realpathNative`). */
  caseInsensitive?: boolean;
  /** Replaces the `fs.realpath.native` call the case-mismatch check makes to learn a path's true
   *  on-disk spelling. For tests only, together with `caseInsensitive: true`. */
  realpathNative?: (absPath: string) => Promise<string>;
}

async function detectRipgrep(): Promise<string | null> {
  try {
    await execFileAsync('rg', ['--version']);
    return 'rg';
  } catch {
    return null;
  }
}

/** Flips every letter's case; `null` when `name` has no letter to flip (nothing to compare). */
function flipCase(name: string): string | null {
  if (!/[a-zA-Z]/.test(name)) return null;
  const flipped = [...name]
    .map((ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()))
    .join('');
  return flipped === name ? null : flipped;
}

/**
 * Detects, once, and without writing anything (a read-only vault must stay read-only), whether
 * the filesystem holding the vault folds letter case. Stats a case-flipped spelling of a name
 * already known to exist and compares dev+ino with the original: the same file both times means
 * the OS folded the case. Tries the vault root's own last segment first, then — a root name with
 * no letter to flip, e.g. a hash or a number — the first directory entry that has one. Undecidable
 * (no letter anywhere, or the stat failed for an unrelated reason) assumes case-insensitive on
 * win32/darwin and case-sensitive elsewhere, the same default the real end-to-end proof (the
 * macOS/Windows CI legs) then either confirms or corrects.
 */
async function detectCaseInsensitive(root: string): Promise<boolean> {
  const probe = async (dir: string, name: string): Promise<boolean | null> => {
    const flipped = flipCase(name);
    if (flipped === null) return null;
    try {
      const [original, candidate] = await Promise.all([
        fs.stat(path.join(dir, name)),
        fs.stat(path.join(dir, flipped)),
      ]);
      return original.dev === candidate.dev && original.ino === candidate.ino;
    } catch {
      return null; // the flipped spelling doesn't exist (or another race) — not decidable this way
    }
  };
  const rootResult = await probe(path.dirname(root), path.basename(root));
  if (rootResult !== null) return rootResult;
  try {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      const result = await probe(root, entry.name);
      if (result !== null) return result;
    }
  } catch {
    // unreadable root — fall through to the platform default below
  }
  return process.platform === 'win32' || process.platform === 'darwin';
}

export type CaseComparison = 'exact' | 'case-only' | 'other';

/**
 * Compares a requested path spelling against what `fs.realpath.native` says is really on disk,
 * after folding both through Unicode NFC — so a precomposed and a combining form of the very same
 * name are never reported as a difference (macOS commonly stores the combining form, "e" +
 * U+0301 rather than "é", regardless of which one the caller typed or the filesystem returns).
 * What remains is either the exact same spelling ('exact'), a difference that disappears once
 * both sides are lower-cased ('case-only'), or something else entirely ('other') — most likely a
 * symlink resolving elsewhere, which the case check leaves alone, exactly as it does today.
 */
export function compareCaseSpelling(want: string, real: string): CaseComparison {
  const wantNFC = want.normalize('NFC');
  const realNFC = real.normalize('NFC');
  if (wantNFC === realNFC) return 'exact';
  return wantNFC.toLowerCase() === realNFC.toLowerCase() ? 'case-only' : 'other';
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

/** Windows can report any of these for a rename into (or over) a directory another process — the
 *  file watcher, most often — still holds a handle inside: none of them mean the rename is wrong,
 *  only that it needs a moment. Named platform-neutrally because nothing here is Windows-specific,
 *  even though only Windows is expected to ever actually hit it. */
function isRetryableRenameError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

const RENAME_RETRY_ATTEMPTS = 5;
const RENAME_RETRY_DELAY_MS = 40;

/** `fs.rename`, retried with a short backoff on `isRetryableRenameError` — the same rename, tried
 *  again instead of failing the caller's whole request over what is usually a held handle letting
 *  go within milliseconds. Any other error, or the last attempt, is thrown as-is. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (attempt >= RENAME_RETRY_ATTEMPTS || !isRetryableRenameError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAY_MS * attempt));
    }
  }
}

/** Every regular file under `dir`, keyed by its path relative to `dir`, valued by its size — cheap
 *  enough to call twice (source and copy) and specific enough to catch a copy that silently
 *  dropped or truncated a file, without hashing every byte of a folder that may hold attachments. */
/** Every file under `dir`, relative path → SHA-256 of its bytes. */
async function collectFileHashes(dir: string, base = dir): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [rel, hash] of await collectFileHashes(abs, base)) out.set(rel, hash);
    } else if (entry.isFile()) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(abs)) hash.update(chunk as Buffer);
      out.set(path.relative(base, abs), hash.digest('hex'));
    }
  }
  return out;
}

/** True when every file under `fromDir` has a same-named file with the same bytes under `toDir`:
 *  the "verify" of "copy everything, verify, then remove". Bytes, not sizes: this stands between
 *  a note and its deletion, and a same-sized wrong copy is exactly what a size check misses. */
async function verifyRecursiveCopy(fromDir: string, toDir: string): Promise<boolean> {
  const [source, copy] = await Promise.all([collectFileHashes(fromDir), collectFileHashes(toDir)]);
  if (source.size !== copy.size) return false;
  for (const [rel, hash] of source) {
    if (copy.get(rel) !== hash) return false;
  }
  return true;
}

/**
 * Fallback for a folder rename that `renameWithRetry` still could not complete (a handle held
 * open longer than the whole retry window): copies the tree instead of moving it, verifies the
 * copy, and only then removes the original — never the other order, so a copy that turns out
 * incomplete never costs the original data. Thrown errors leave the original untouched; a partial
 * copy at `toAbs` is cleaned up before throwing.
 */
async function copyThenRemoveDir(fromAbs: string, toAbs: string): Promise<void> {
  try {
    await fs.cp(fromAbs, toAbs, { recursive: true, errorOnExist: true });
    if (!(await verifyRecursiveCopy(fromAbs, toAbs))) {
      throw new Error('copy could not be verified against the original');
    }
  } catch (error) {
    await fs.rm(toAbs, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  await fs.rm(fromAbs, { recursive: true, force: true });
}

/** True when any path segment starts with '.' — mirrors the dot-entry skip in list()'s walk, so
 *  an explicit `search()` `paths` entry is held to exactly the same "never visible" rule as a
 *  path list() would ever produce. */
function hasDotSegment(p: string): boolean {
  return p.split('/').some((segment) => segment.startsWith('.'));
}

/**
 * A note whose leading `---` block failed to parse must not be "updated": `read()` exposes it
 * body-only, so writing `joinFrontmatter(newKeys, body)` would prepend a second block and bury
 * the broken one. Refuse with the parse error so the caller fixes the block first.
 */
function assertUsableFrontmatter(p: string, note: Note): void {
  if (note.frontmatterError !== undefined) {
    throw new VaultError(
      'INVALID_INPUT',
      `${p} has frontmatter that is not usable — ${note.frontmatterError} Fix the block with vault_edit or vault_write before changing keys.`,
    );
  }
}

export class LocalFSAdapter implements StorageAdapter {
  private static readonly TEXT_EXTENSIONS = new Set([
    '.md',
    '.markdown',
    '.txt',
    '.canvas',
    '.json',
    '.csv',
    // Obsidian Bases. Read/write/search/list as plain text only — the query syntax changed
    // incompatibly twice in 2025, so this server never parses or evaluates it.
    '.base',
  ]);

  readonly root: string;
  /** True when the filesystem holding the vault folds letter case (detected once at `create`, or
   *  forced by `LocalFSOptions.caseInsensitive` for tests) — a vault path is exact on every
   *  platform, so this gates the extra check that enforces it; zero cost when false. */
  readonly caseInsensitive: boolean;
  private readonly rg: string | null;
  private readonly watchPollMs: number | null;
  private readonly maxBinaryBytes: number;
  private readonly realpathNative: (absPath: string) => Promise<string>;

  private constructor(
    root: string,
    rg: string | null,
    watchPollMs: number | null,
    maxBinaryBytes: number,
    caseInsensitive: boolean,
    realpathNative: (absPath: string) => Promise<string>,
  ) {
    this.root = root;
    this.rg = rg;
    this.watchPollMs = watchPollMs;
    this.maxBinaryBytes = maxBinaryBytes;
    this.caseInsensitive = caseInsensitive;
    this.realpathNative = realpathNative;
  }

  static async create(rootDir: string, opts: LocalFSOptions = {}): Promise<LocalFSAdapter> {
    await fs.mkdir(rootDir, { recursive: true });
    const root = await fs.realpath(rootDir);
    const rg = opts.ripgrepPath === undefined ? await detectRipgrep() : opts.ripgrepPath;
    const caseInsensitive = opts.caseInsensitive ?? (await detectCaseInsensitive(root));
    return new LocalFSAdapter(
      root,
      rg,
      opts.watchPollMs ?? null,
      opts.maxBinaryBytes ?? MAX_BINARY_BYTES,
      caseInsensitive,
      opts.realpathNative ?? defaultRealpathNative,
    );
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
    // realpath OPENS what it resolves on macOS: on a FIFO it never returns (measured: the suite
    // hung there for hours, on the very test that guards reads against FIFOs — a guard that runs
    // after this check). A leaf that is neither a folder nor a symlink cannot change where the
    // path leads, so only its parent is resolved; the leaf's own name is appended unchanged.
    let leaf: string | null = null;
    try {
      const probed = await fs.lstat(absPath);
      if (!probed.isDirectory() && !probed.isSymbolicLink()) {
        leaf = path.basename(absPath);
        probe = path.dirname(absPath);
      }
    } catch {
      /* missing, or unreadable: the loop below says which */
    }
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        const resolved = leaf === null ? real : path.join(real, leaf);
        if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
          throw new VaultError('INVALID_PATH', 'Path resolves outside the vault root.');
        }
        return;
      } catch (error) {
        if (error instanceof VaultError) throw error;
        if (!isEnoent(error)) throw new VaultError('IO', 'Could not resolve path.');
        leaf = null;
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

  /**
   * On a case-insensitive filesystem, resolves the true on-disk spelling of the deepest existing
   * ancestor of `vaultPath` (which may be the full path itself) by asking `realpath.native` for
   * it, trying shorter prefixes on ENOENT exactly as `assertInsideRoot` already does for
   * containment — so `write`ing `Notes/x.md` when only `notes/` exists is caught here too, not
   * just an outright collision, and the whole walk is driven by that one injectable call (what
   * `tests/storage/local-fs-case.test.ts` fakes to exercise this on a case-sensitive CI runner).
   * When the resolved spelling differs from what was asked only by letter case, returns the
   * corrected vault-relative path: the real spelling for the matched prefix, the caller's own
   * spelling for whatever tail does not exist yet. `null` covers every case this check leaves
   * alone: a case-sensitive filesystem, an exact match, a path that doesn't exist at all yet
   * (nothing to compare), or a difference that isn't case (a symlink, most likely, or any other
   * failure to resolve) — accepted exactly as today.
   */
  private async findCaseMismatch(vaultPath: string): Promise<string | null> {
    if (!this.caseInsensitive || vaultPath === '') return null;
    const segments = vaultPath.split('/');
    let probeLen = segments.length;
    let real: string | null = null;
    let probeAbs = '';
    for (; probeLen > 0; probeLen -= 1) {
      probeAbs = path.join(this.root, ...segments.slice(0, probeLen));
      try {
        // Only a regular file or a folder is worth resolving. realpath on a FIFO OPENS it on
        // macOS and never returns (measured: the suite hung there, three and a half hours, on the
        // very test that guards reads against FIFOs) — that guard runs after this check, so this
        // check must refuse to touch anything else itself. Whatever such a path is, the operation
        // that follows answers for it; a case-only spelling of a FIFO is not worth telling apart.
        // stat (not lstat, not realpath) follows the OS's own case folding without opening
        // anything; a case-sensitive filesystem answers ENOENT here for a wrong spelling, and
        // then this check is not needed at all.
        const probed = await fs.stat(probeAbs).catch((error: unknown) => {
          if (isEnoent(error)) return null; // nothing there: realpath cannot open anything either
          throw error;
        });
        if (probed !== null && !probed.isFile() && !probed.isDirectory()) return null;
        real = await this.realpathNative(probeAbs);
        break;
      } catch (error) {
        if (!isEnoent(error)) return null; // not this check's job — the real operation will say why
      }
    }
    if (real === null) return null; // no ancestor of vaultPath exists at all — nothing to compare
    if (compareCaseSpelling(probeAbs, real) !== 'case-only') return null;
    const tail = segments.slice(probeLen);
    const realRel = this.rel(real);
    return tail.length === 0 ? realRel : `${realRel}/${tail.join('/')}`;
  }

  /** `NOT_FOUND`, worded exactly like a plain missing file — for an operation that only reads or
   *  identifies an existing path (near-miss suggestions then apply the same as for any other
   *  NOT_FOUND). Callers only invoke this once they already know something answers to `vaultPath`
   *  under case-insensitive resolution (a prior stat succeeded), so a mismatch here is always the
   *  whole path, never just an ancestor. */
  private async assertNoCaseNearMiss(vaultPath: string, notFoundMessage: string): Promise<void> {
    if ((await this.findCaseMismatch(vaultPath)) !== null) {
      throw new VaultError('NOT_FOUND', notFoundMessage);
    }
  }

  /** `CONFLICT` for an operation about to create or overwrite `vaultPath` — refuses a write that
   *  would land on an existing file, or inside an existing folder, spelled with different case
   *  than the index already knows it by. */
  private async assertNoCaseConflict(vaultPath: string): Promise<void> {
    const mismatch = await this.findCaseMismatch(vaultPath);
    if (mismatch !== null) {
      throw new VaultError(
        'CONFLICT',
        `${vaultPath} differs only by letter case from the existing "${mismatch}": use that path.`,
      );
    }
  }

  // ---- read ---------------------------------------------------------------

  async read(inputPath: string): Promise<Note> {
    const p = requireFilePath(inputPath);
    const abs = this.abs(p);
    await this.assertInsideRoot(abs);
    const stat = await this.statOrNull(abs);
    if (!stat) throw new VaultError('NOT_FOUND', `${p} does not exist.`);
    await this.assertNoCaseNearMiss(p, `${p} does not exist.`);
    if (stat.isDirectory()) throw new VaultError('INVALID_INPUT', `${p} is a folder, not a file.`);
    // A FIFO, a socket or a device has no end to read up to: readFile would hold a thread of
    // the pool for ever (measured: two such reads starved every other file read in the process).
    if (!stat.isFile()) throw new VaultError('INVALID_INPUT', `${p} is not a regular file.`);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(abs);
    } catch (error) {
      // Gone between the stat and the read is "not found"; anything else (no permission, a file
      // another program holds locked) is this one note's failure, never the whole batch's.
      if (isEnoent(error)) throw new VaultError('NOT_FOUND', `${p} does not exist.`);
      throw new VaultError('IO', `Could not read ${p}.`);
    }
    return this.toNote(p, bytes, stat);
  }

  /** Shared by `toNote` and `hashOf` so the two never compute a hash over different text. */
  private decodeText(p: string, bytes: Buffer | Uint8Array): string {
    try {
      return strictUtf8.decode(bytes);
    } catch {
      throw new VaultError('ENCODING', `${p} is not valid UTF-8 text.`);
    }
  }

  protected toNote(p: string, bytes: Buffer, stat: Stats): Note {
    return this.noteFrom(p, this.decodeText(p, bytes), stat);
  }

  /** Builds a Note for text this adapter just wrote to `p` — fresh stat, no content re-read. */
  private async noteForWritten(p: string, content: string): Promise<Note> {
    const stat = await this.statOrNull(this.abs(p));
    if (!stat) throw new VaultError('IO', `Failed to stat ${p} after writing it.`);
    return this.noteFrom(p, content, stat);
  }

  private noteFrom(p: string, content: string, stat: Stats): Note {
    let frontmatter: Record<string, unknown> = {};
    let body = content;
    let hasFrontmatter = false;
    let frontmatterError: string | undefined;
    if (isMarkdownPath(p)) {
      try {
        ({ frontmatter, body, hasFrontmatter } = splitFrontmatter(content));
      } catch (error) {
        // Invalid YAML must never block reading; the note is exposed as body-only, and the
        // reason is kept so writers can refuse to build a new block on top of the broken one.
        if (!(error instanceof VaultError)) throw error;
        frontmatterError = error.message;
      }
    }
    return {
      path: p,
      content,
      frontmatter,
      body,
      hasFrontmatter,
      ...(frontmatterError === undefined ? {} : { frontmatterError }),
      meta: { size: stat.size, modifiedAt: stat.mtime.toISOString() },
      hash: sha256hex(content),
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

  /** True when a file (not a folder) is at the path: a stat, no read. */
  async exists(inputPath: string): Promise<boolean> {
    const p = requireFilePath(inputPath);
    const abs = this.abs(p);
    await this.assertInsideRoot(abs); // the same containment check every other path goes through
    const stat = await this.statOrNull(abs);
    if (stat?.isFile() !== true) return false;
    if ((await this.findCaseMismatch(p)) !== null) return false; // case-only near-miss: not this file
    return true;
  }

  /**
   * sha256hex of the file's content, or `null` when it does not exist or is a directory —
   * those are the only cases with no comparable "content hash". Text (valid UTF-8, matching
   * `Note.hash`) is hashed as decoded text; content that fails to decode (e.g. a binary
   * attachment written via vault_write_binary) is hashed over its raw bytes instead, so every
   * existing file gets a real, round-trippable hash for expectedHash.
   */
  async hashOf(inputPath: string): Promise<string | null> {
    const p = requireFilePath(inputPath);
    const abs = this.abs(p);
    await this.assertInsideRoot(abs);
    const stat = await this.statOrNull(abs);
    if (!stat?.isFile()) return null; // a folder, or a FIFO/socket/device that would never end
    if ((await this.findCaseMismatch(p)) !== null) return null; // case-only near-miss: not this file
    const bytes = await fs.readFile(abs);
    return this.hashForBytes(p, bytes);
  }

  /** Same rule `hashOf` documents: decoded text when the bytes are valid UTF-8, raw bytes otherwise. */
  private hashForBytes(p: string, bytes: Uint8Array): string {
    try {
      return sha256hex(this.decodeText(p, bytes));
    } catch {
      return createHash('sha256').update(bytes).digest('hex');
    }
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
      // Every write goes through this rename — the same transient EPERM/EBUSY/EACCES a folder
      // delete can hit on Windows (a held handle, most often the watcher's) can just as well land
      // on an ordinary write's tmp-to-real rename; observed on CI as an occasional `IO` on a plain
      // vault_write/canvas update with nothing else wrong.
      await renameWithRetry(tmp, abs);
    } catch {
      await fs.rm(tmp, { force: true });
      throw new VaultError('IO', `Failed to write ${p}.`);
    }
  }

  async write(inputPath: string, content: string, opts: WriteOpts = {}): Promise<Note> {
    const p = requireFilePath(inputPath);
    await this.assertNoCaseConflict(p);
    assertWithinSize(Buffer.byteLength(content, 'utf8'), 'Content');
    if (opts.expectedHash !== undefined) {
      assertExpectedHash(p, await this.hashOf(p), opts.expectedHash);
    }
    let finalContent = content;
    if (opts.mergeFrontmatter && isMarkdownPath(p)) {
      const incoming = splitFrontmatter(content);
      let existingFm: Record<string, unknown> = {};
      try {
        const existing = await this.read(p);
        assertUsableFrontmatter(p, existing);
        existingFm = existing.frontmatter;
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
    return this.noteForWritten(p, finalContent);
  }

  async writeBinary(
    inputPath: string,
    bytes: Uint8Array,
    mime: string,
    opts: MutateOpts = {},
  ): Promise<string> {
    const p = requireFilePath(inputPath);
    await this.assertNoCaseConflict(p);
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
    assertWithinSize(bytes.byteLength, 'Binary content', this.maxBinaryBytes);
    if (opts.expectedHash !== undefined) {
      assertExpectedHash(p, await this.hashOf(p), opts.expectedHash);
    }
    await this.atomicWrite(p, bytes);
    return this.hashForBytes(p, bytes);
  }

  async edit(
    inputPath: string,
    patches: TextPatch[],
    dryRun = false,
    opts: MutateOpts = {},
  ): Promise<EditResult> {
    const note = await this.read(inputPath);
    if (opts.expectedHash !== undefined) {
      assertExpectedHash(note.path, note.hash, opts.expectedHash);
    }
    const { content, applied } = applyTextPatches(note.content, patches);
    const diff = unifiedDiff(note.path, note.content, content);
    if (dryRun) return { path: note.path, applied, diff, dryRun, note };
    assertWithinSize(Buffer.byteLength(content, 'utf8'), 'Edited content');
    await this.atomicWrite(note.path, Buffer.from(content, 'utf8'));
    return {
      path: note.path,
      applied,
      diff,
      dryRun,
      note: await this.noteForWritten(note.path, content),
    };
  }

  async append(inputPath: string, content: string, opts: MutateOpts = {}): Promise<Note> {
    const p = requireFilePath(inputPath);
    // Must run before the read below: read() throwing NOT_FOUND for a case-only near-miss would
    // otherwise be swallowed right here as "no existing content" and silently create a second file.
    await this.assertNoCaseConflict(p);
    let existing = '';
    let currentHash: string | null = null;
    try {
      const note = await this.read(p);
      existing = note.content;
      currentHash = note.hash;
    } catch (error) {
      if (!(error instanceof VaultError && error.code === 'NOT_FOUND')) throw error;
    }
    if (opts.expectedHash !== undefined) {
      assertExpectedHash(p, currentHash, opts.expectedHash);
    }
    const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    const suffix = content.endsWith('\n') ? '' : '\n';
    const next = `${existing}${separator}${content}${suffix}`;
    assertWithinSize(Buffer.byteLength(next, 'utf8'), 'Appended content');
    await this.atomicWrite(p, Buffer.from(next, 'utf8'));
    return this.noteForWritten(p, next);
  }

  async batchFrontmatterUpdate(updates: FmUpdate[]): Promise<BatchResult> {
    assertBatchSize(updates.length);
    const result: BatchResult = { updated: [], updatedNotes: [], failed: [] };
    for (const update of updates) {
      try {
        const p = requireFilePath(update.path);
        if (!isMarkdownPath(p)) {
          throw new VaultError('INVALID_INPUT', `${p} is not a markdown file.`);
        }
        const note = await this.read(p);
        if (update.expectedHash !== undefined) {
          assertExpectedHash(p, note.hash, update.expectedHash);
        }
        assertUsableFrontmatter(p, note);
        const fm = applyFrontmatterUpdate(note.frontmatter, update.set, update.unset);
        const text = joinFrontmatter(fm, note.body);
        assertWithinSize(Buffer.byteLength(text, 'utf8'), 'Updated content');
        await this.atomicWrite(p, Buffer.from(text, 'utf8'));
        result.updated.push(p);
        result.updatedNotes.push(await this.noteForWritten(p, text));
      } catch (error) {
        if (error instanceof VaultError) {
          result.failed.push({
            path: normalizedOrRaw(update.path),
            error: failedEntryMessage(error),
          });
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
    await this.assertNoCaseNearMiss(base, `${base || '/'} does not exist.`);
    if (!baseStat.isDirectory())
      throw new VaultError('INVALID_INPUT', `${base} is a file, not a folder.`);

    const out: Entry[] = [];
    const walk = async (dir: string, level: number): Promise<void> => {
      // A folder or file that disappears between being listed and being read is not an error of
      // the listing: on a vault that other programs write to, it is a Tuesday.
      let dirents: Dirent[];
      try {
        dirents = await fs.readdir(this.abs(dir), { withFileTypes: true });
      } catch (error) {
        if (!isEnoent(error)) throw error;
        if (dir !== base) return;
        throw new VaultError('NOT_FOUND', `${base || '/'} does not exist.`);
      }
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
          const stat = await this.statOrNull(this.abs(rel));
          if (!stat) continue;
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

  async move(fromInput: string, toInput: string, opts: MutateOpts = {}): Promise<void> {
    const from = requireFilePath(fromInput);
    const to = requireFilePath(toInput);
    const fromAbs = this.abs(from);
    const toAbs = this.abs(to);
    await this.assertInsideRoot(fromAbs);
    await this.assertInsideRoot(toAbs);
    const fromStat = await this.statOrNull(fromAbs);
    if (!fromStat) throw new VaultError('NOT_FOUND', `${from} does not exist.`);
    await this.assertNoCaseNearMiss(from, `${from} does not exist.`);
    await this.assertNoCaseConflict(to);
    if (await this.statOrNull(toAbs))
      throw new VaultError('ALREADY_EXISTS', `${to} already exists.`);
    if (opts.expectedHash !== undefined) {
      if (fromStat.isDirectory()) {
        throw new VaultError(
          'INVALID_INPUT',
          'expectedHash is only supported when moving a single file, not a folder.',
        );
      }
      assertExpectedHash(from, await this.hashOf(from), opts.expectedHash);
    }
    await fs.mkdir(path.dirname(toAbs), { recursive: true });
    try {
      await renameWithRetry(fromAbs, toAbs);
    } catch {
      throw new VaultError('IO', `Failed to move ${from} to ${to}.`);
    }
  }

  async softDelete(inputPath: string, confirm: boolean, opts: MutateOpts = {}): Promise<void> {
    if (confirm !== true) {
      throw new VaultError(
        'CONFIRM_REQUIRED',
        'Deletion requires confirm=true. The file is moved to .trash/ (not erased) and can be restored manually.',
      );
    }
    const p = requireFilePath(inputPath);
    const fromAbs = this.abs(p);
    await this.assertInsideRoot(fromAbs);
    const fromStat = await this.statOrNull(fromAbs);
    if (!fromStat) throw new VaultError('NOT_FOUND', `${p} does not exist.`);
    await this.assertNoCaseNearMiss(p, `${p} does not exist.`);
    if (opts.expectedHash !== undefined) {
      if (fromStat.isDirectory()) {
        throw new VaultError(
          'INVALID_INPUT',
          'expectedHash is only supported when deleting a single file, not a folder.',
        );
      }
      assertExpectedHash(p, await this.hashOf(p), opts.expectedHash);
    }

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
      await renameWithRetry(fromAbs, toAbs);
    } catch (error) {
      // A folder rename can still lose to a handle held open past the whole retry window (the
      // file watcher, most often, on Windows): fall back to copying the tree instead of moving
      // it, rather than failing the delete outright. A file has no such fallback — and needs
      // none, a single rename is not expected to be held open this long.
      if (!fromStat.isDirectory() || !isRetryableRenameError(error)) {
        throw new VaultError('IO', `Failed to move ${p} to trash.`);
      }
      try {
        await copyThenRemoveDir(fromAbs, toAbs);
      } catch {
        throw new VaultError('IO', `Failed to move ${p} to trash.`);
      }
    }
  }

  /**
   * Unlinks a file outright — no .trash, no confirm. Internal use only: transaction rollback
   * (Task 7) uses this to undo a file it created mid-transaction. Rejects reserved (`_brainstem/`)
   * and dot paths exactly like every other adapter method.
   */
  async hardDelete(inputPath: string): Promise<void> {
    const p = requireFilePath(inputPath);
    const abs = this.abs(p);
    await this.assertInsideRoot(abs);
    try {
      await fs.unlink(abs);
    } catch (error) {
      if (isEnoent(error)) throw new VaultError('NOT_FOUND', `${p} does not exist.`);
      throw new VaultError('IO', `Failed to delete ${p}.`);
    }
  }

  // ---- search --------------------------------------------------------------

  async search(query: string, opts: SearchOpts = {}): Promise<Match[]> {
    if (typeof query !== 'string' || query.trim() === '') {
      throw new VaultError('INVALID_INPUT', 'Search query must not be empty.');
    }
    const regex = opts.regex === true;
    // The pattern-length cap and the ripgrep-availability check are both about `regex: true`
    // specifically — a literal query is never capped here and works with or without ripgrep.
    // The length check runs first so a malformed pattern is reported as such (INVALID_INPUT)
    // even when ripgrep is also unavailable, rather than being masked by UNSUPPORTED.
    if (regex && query.length > MAX_SEARCH_PATTERN_CHARS) {
      throw new VaultError(
        'INVALID_INPUT',
        `regex pattern exceeds ${MAX_SEARCH_PATTERN_CHARS} characters (got ${query.length}).`,
      );
    }
    // Ripgrep validates its own (much larger) regex syntax itself, on the spawned process; the JS
    // fallback's reduced syntax is validated up front, here, by compiling before any file is
    // read — so a malformed pattern fails the same way (INVALID_INPUT, before any I/O) whether or
    // not ripgrep happens to be installed.
    let safeSearchMatcher: SafeSearchMatcher | null = null;
    if (regex && !this.rg) {
      try {
        safeSearchMatcher = compileSafeSearch(query, { caseSensitive: opts.caseSensitive });
      } catch (error) {
        if (error instanceof VaultError && error.code === 'INVALID_INPUT') {
          throw new VaultError(
            'INVALID_INPUT',
            `${error.message} ripgrep is not installed, so only this reduced regex syntax is ` +
              'available (literals, ., character classes, * + ? {m,n}, alternation, grouping); ' +
              'install ripgrep for the full syntax.',
          );
        }
        throw error;
      }
    }
    if (opts.paths !== undefined && opts.paths.length > MAX_SEARCH_PATHS) {
      throw new VaultError(
        'INVALID_INPUT',
        `paths must have at most ${MAX_SEARCH_PATHS} entries (got ${opts.paths.length}).`,
      );
    }
    // ripgrep does NOT apply --glob filters to files named explicitly on the command line (only
    // to files it discovers itself while walking a directory), and the JS fallback's extension
    // check alone would let a reserved/dot path with an allowed extension through (e.g.
    // `_brainstem/state.json`, which is valid `.json`). So an explicit `paths` list is filtered
    // here, once, before either backend ever sees it — using exactly the predicate list()'s own
    // directory walk uses — rather than relying on ripgrep's globs or the extension check alone.
    const paths = opts.paths?.filter((p) => !isReservedPath(p) && !hasDotSegment(p));
    if (paths?.length === 0) return [];

    // The ceiling is MAX_SEARCH_SCAN, not MAX_SEARCH_RESULTS: the tool layer's public `limit`
    // input is already capped at MAX_SEARCH_RESULTS by its own Zod schema, but vault_search's
    // full-vault-scan fallback (when a tags/where candidate list is itself too large to trust)
    // legitimately asks the adapter for up to MAX_SEARCH_SCAN raw matches to filter afterwards —
    // this must not be silently re-clamped back down to 50 here.
    const limit = Math.max(1, Math.min(opts.limit ?? MAX_SEARCH_RESULTS, MAX_SEARCH_SCAN));
    const prefix = normalizeVaultPath(opts.pathPrefix ?? '');
    const caseSensitive = opts.caseSensitive ?? false;

    const prefixAbs = this.abs(prefix);
    await this.assertInsideRoot(prefixAbs);
    const st = await this.statOrNull(prefixAbs);
    if (!st) throw new VaultError('NOT_FOUND', `${prefix || '/'} does not exist.`);
    await this.assertNoCaseNearMiss(prefix, `${prefix || '/'} does not exist.`);
    if (!st.isDirectory())
      throw new VaultError('INVALID_INPUT', `${prefix} is a file, not a folder.`);

    const matches = this.rg
      ? await this.searchRipgrep(query, prefix, limit, caseSensitive, regex, paths)
      : await this.searchJs(query, prefix, limit, caseSensitive, paths, safeSearchMatcher);
    return matches.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
  }

  private async searchJs(
    query: string,
    prefix: string,
    limit: number,
    caseSensitive: boolean,
    paths?: string[],
    /** Compiled once by `search()` and reused across every candidate file/line — never recompiled
     *  per line — when `regex: true` was requested and ripgrep is not available (see
     *  `src/vault/safe-regex.ts`). `null` for a literal (non-regex) search. */
    regexMatcher?: SafeSearchMatcher | null,
  ): Promise<Match[]> {
    const candidates = paths
      ? paths
      : (await this.list(prefix, { depth: Number.POSITIVE_INFINITY, includeDirs: false })).map(
          (e) => e.path,
        );
    const needle = caseSensitive ? query : query.toLowerCase();
    const out: Match[] = [];
    for (const candidate of candidates) {
      if (!LocalFSAdapter.TEXT_EXTENSIONS.has(path.extname(candidate).toLowerCase())) continue;
      let text: string;
      try {
        text = strictUtf8.decode(await fs.readFile(this.abs(candidate)));
      } catch {
        continue;
      }
      // The required-literal prefilter (src/vault/safe-regex.ts) rules out a whole file with one
      // pass over its raw text, before ever splitting it into lines: `find()` below already runs
      // the same check per LINE, but a file that fails it can never have a matching line, so this
      // skips the split (and every per-line NFA run `find()` would otherwise have to reject one
      // at a time) entirely for a file the required literal doesn't appear in anywhere.
      if (regexMatcher?.cannotMatch(text)) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && out.length < limit; i += 1) {
        const line = lines[i] ?? '';
        const hit = regexMatcher
          ? regexMatcher.find(line) !== null
          : (caseSensitive ? line : line.toLowerCase()).includes(needle);
        // the line as it is, trailing whitespace included: ripgrep mode returns the same bytes, and
        // an agent may hand this text back to vault_edit as the exact string to replace
        if (hit) out.push({ path: candidate, line: i + 1, text: clampMatchText(line) });
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
    regex: boolean,
    paths?: string[],
  ): Promise<Match[]> {
    if (!this.rg) return [];
    const args = [
      '--json',
      '--no-messages',
      '--no-ignore',
      caseSensitive ? '--case-sensitive' : '--ignore-case',
      '--max-count',
      String(limit),
      // Regex mode drops -F/--fixed-strings so ripgrep's (RE2-derived, linear-time) regex engine
      // applies; --pcre2 is never enabled (Global Constraint — no backtracking engine on
      // user-supplied patterns). Literal mode is byte-for-byte the existing behaviour.
      ...(regex ? [] : ['--fixed-strings']),
      // Per-extension include globs only make sense while ripgrep is walking a directory itself.
      // An explicit `paths` list is already the exact candidate set (drawn from the index), so
      // the includes are dropped for it.
      ...(paths === undefined
        ? [...LocalFSAdapter.TEXT_EXTENSIONS].flatMap((ext) => ['--glob', `*${ext}`])
        : []),
      // ripgrep applies "last matching glob wins", so these excludes must come after any
      // extension includes above — otherwise an unanchored include like `*.md` would re-include
      // everything under an excluded directory that happens to have an allowed extension.
      // NOTE: these globs only take effect when ripgrep is walking `prefix` itself
      // (paths === undefined) — ripgrep does NOT apply --glob filters to files named explicitly
      // on the command line, so when `paths` is given, these three are a no-op for it. The real
      // guarantee that no dot-path or `_brainstem` entry is ever searched via `paths` comes from
      // the pre-filter in search() above (isReservedPath/hasDotSegment), not from these globs.
      // They're left in either way since they're harmless (and still needed for the
      // paths === undefined, directory-walk case).
      '--glob',
      '!.*',
      '--glob',
      '!**/.*/**',
      // A leading '/' anchors this glob to `cwd` (set below to the vault root) rather than to
      // wherever the server process happens to be running, and rather than matching the
      // `_brainstem` basename at any depth — so a legitimate nested look-alike such as
      // `notes/_brainstem/x.md` is still searchable. (Only matters for the directory-walk case —
      // see the NOTE above for the `paths` case.)
      '--glob',
      `!/${RESERVED_DIR}/**`,
      ...(regex ? ['-e', query] : []),
      '--',
      // Literal mode keeps the query as the bare positional pattern (unchanged from before);
      // regex mode already carried it via -e above, so only the search target(s) follow --.
      // `paths` are resolved to absolute paths (like the single-prefix case below) so ripgrep's
      // JSON output always reports absolute paths, which this.rel() can convert back correctly
      // regardless of how ripgrep echoes a given path argument.
      ...(regex ? [] : [query]),
      ...(paths ? paths.map((p) => this.abs(p)) : [this.abs(prefix)]),
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
          text: clampMatchText(text),
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

  watch(onChange: (event: ChangeEvent) => void, onError?: (error: unknown) => void): Unsubscribe {
    const watcher = chokidarWatch(this.root, {
      ignoreInitial: true,
      ignored: (absPath: string, stats?: Stats) => {
        if (absPath === this.root) return false;
        if (path.basename(absPath).startsWith('.')) return true;
        // chokidar puts an fs.watch on every file it tracks; on macOS that OPENS the file (kqueue
        // needs a descriptor), and opening a FIFO blocks until a writer comes — never, here. So
        // anything that is not a plain file or a folder is not watched at all (a FIFO or socket
        // named like a note was never a note: no listing shows it). Measured: a FIFO in the vault
        // froze the whole suite on macOS, three runs in a row, while Linux never noticed.
        if (stats !== undefined && !stats.isFile() && !stats.isDirectory()) return true;
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
    // chokidar's own inotify/fsevents/polling backend surfaces a queue overflow or similar here —
    // never thrown, so an unhandled listener is silent unless a caller wires this in.
    if (onError) watcher.on('error', onError);
    return () => {
      void watcher.close();
    };
  }
}
