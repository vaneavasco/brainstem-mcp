import { randomBytes } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import pathPosix from 'node:path/posix';
import pathWin32 from 'node:path/win32';
import { INDEX_CACHE_SCHEMA, type IndexEntry } from '../vault/frontmatter-index.ts';
import { pathsAreRelated, realpathOrClosestAncestor, vaultKey } from './local-state.ts';

/**
 * A machine-local, per-vault cache of the frontmatter index (`src/vault/frontmatter-index.ts`),
 * used only by the stdio entrypoint (`src/stdio-main.ts`) to skip most of a large vault's read
 * cost on the second boot. **The cache is a hint, never a source**: `FrontmatterIndex.fill`
 * upserts a cached entry only when the file's current `size`/`modifiedAt` in this boot's own
 * listing match the cached entry exactly; every other path is read from disk as it would be
 * without a cache. The known blind spot — a file rewritten with the same size and the same
 * modification time — is the same one the index's own `reconcile` pass already accepts; this
 * module does not attempt to close it.
 *
 * Never inside the vault, never the OS temp dir: `BRAINSTEM_CACHE_HOME` (must be absolute) or the
 * OS cache directory (`$XDG_CACHE_HOME/brainstem` or `~/.cache/brainstem` on Linux,
 * `~/Library/Caches/brainstem` on macOS, `%LOCALAPPDATA%\brainstem\Cache` on Windows), then the
 * same 16-hex `vaultKey` (`src/storage/local-state.ts`) the machine-local state folder uses, so
 * the two never drift apart on how a vault is identified. Unlike the state folder, a cache that
 * cannot be created or written is never fatal: the caller (`src/stdio-main.ts`) runs without one
 * and logs a single warning line instead of exiting.
 */

export interface LocalCacheEnvDeps {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  homedir(): string;
}

export interface LocalCacheFsDeps {
  mkdir(p: string, opts: { recursive: true; mode?: number }): Promise<string | undefined>;
  /** Used only for the F1 containment check (never falls back anywhere when the cache folder
   *  would land inside the vault, or the vault inside the cache base) — see
   *  `src/storage/local-state.ts`'s `realpathOrClosestAncestor`. */
  realpath(p: string): Promise<string>;
}

export type LocalCacheBaseDirResult = { ok: true; dir: string } | { ok: false; error: string };
export type LocalCacheDirResult =
  | { ok: true; dir: string; key: string }
  | { ok: false; error: string };

function pathModule(platform: NodeJS.Platform): typeof pathPosix | typeof pathWin32 {
  return platform === 'win32' ? pathWin32 : pathPosix;
}

/** `~/Library/Caches/brainstem` (macOS), `%LOCALAPPDATA%\brainstem\Cache` (or
 *  `~/AppData/Local/brainstem/Cache` when that env var is unset — Windows), otherwise
 *  `$XDG_CACHE_HOME/brainstem` or `~/.cache/brainstem` (Linux and everything else). */
function defaultBaseCacheDir(deps: LocalCacheEnvDeps): string {
  const mod = pathModule(deps.platform);
  const home = deps.homedir();
  if (deps.platform === 'darwin') {
    return mod.join(home, 'Library', 'Caches', 'brainstem');
  }
  if (deps.platform === 'win32') {
    const localAppData = deps.env.LOCALAPPDATA;
    return localAppData
      ? mod.join(localAppData, 'brainstem', 'Cache')
      : mod.join(home, 'AppData', 'Local', 'brainstem', 'Cache');
  }
  const xdgCacheHome = deps.env.XDG_CACHE_HOME;
  return xdgCacheHome ? mod.join(xdgCacheHome, 'brainstem') : mod.join(home, '.cache', 'brainstem');
}

/** The base directory every vault's index-cache folder lives under: `BRAINSTEM_CACHE_HOME` when
 *  set (must be absolute), otherwise the per-platform default above. Exported on its own, like
 *  `resolveBaseStateDir`, so it can be shown or probed without resolving a vault. */
export function resolveBaseCacheDir(deps: LocalCacheEnvDeps): LocalCacheBaseDirResult {
  const override = deps.env.BRAINSTEM_CACHE_HOME;
  if (override !== undefined && override !== '') {
    const mod = pathModule(deps.platform);
    if (!mod.isAbsolute(override)) {
      return {
        ok: false,
        error: `BRAINSTEM_CACHE_HOME must be an absolute path, got "${override}"`,
      };
    }
    return { ok: true, dir: override };
  }
  return { ok: true, dir: defaultBaseCacheDir(deps) };
}

/**
 * Resolves (and creates, mode 0700) the machine-local index-cache folder for the vault whose
 * *real* path is `vaultRealPath`: `<base>/<vaultKey(vaultRealPath)>/`. Never falls back to the
 * vault itself or to the OS temp dir. Unlike `resolveLocalStateDir`, a failure here is never
 * fatal for the caller — the cache is optional; `ok: false` just means "run without one".
 *
 * F1: refused the same way as the state folder (before creating anything) when the resolved
 * folder would land inside, or equal to, the vault, or when the vault lands inside the cache
 * base (BRAINSTEM_CACHE_HOME pointed at the vault's own parent, say) — there is no exception here
 * (unlike the stdio entrypoint's `STATE_DIR`), because there is no equivalent dev override for
 * the cache.
 */
export async function resolveLocalCacheDir(
  vaultRealPath: string,
  deps: LocalCacheEnvDeps & { fs: LocalCacheFsDeps },
): Promise<LocalCacheDirResult> {
  const base = resolveBaseCacheDir(deps);
  if (!base.ok) return base;
  const mod = pathModule(deps.platform);
  const key = vaultKey(vaultRealPath);
  const dir = mod.join(base.dir, key);

  // See resolveLocalStateDir's identical check: comparing the BASE (not the per-vault `dir`)
  // against the vault catches both directions at once, since `dir` is always a fixed descendant
  // of `base.dir`.
  const baseReal = await realpathOrClosestAncestor(base.dir, deps.fs.realpath, mod);
  if (pathsAreRelated(baseReal, vaultRealPath, mod, deps.platform)) {
    return {
      ok: false,
      error:
        `the machine-local index-cache folder "${dir}" is inside (or equal to) the vault ` +
        `"${vaultRealPath}" — tools would list, read and search the server’s own cache; set ` +
        'BRAINSTEM_CACHE_HOME to a folder outside the vault',
    };
  }

  try {
    await deps.fs.mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return {
      ok: false,
      error: `could not create the local index-cache folder "${dir}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return { ok: true, dir, key };
}

/** `index-v<SCHEMA>.ndjson` — the schema number is in the file name (not just the header) so two
 *  server versions with different schemas never even try to open one another's file for writing. */
function cacheFileName(): string {
  return `index-v${INDEX_CACHE_SCHEMA}.ndjson`;
}

const TMP_FILE_RE = /^\.index-v\d+\.ndjson\.(\d+)\.[0-9a-f]+\.tmp$/;

/** The pid embedded in a tmp file's own name, or null when the name isn't one of ours (or the
 *  pid segment isn't a valid integer — treated as "not a recognized tmp file" rather than
 *  guessed at). */
function tmpFilePid(name: string): number | null {
  const m = TMP_FILE_RE.exec(name);
  if (!m) return null;
  const pid = Number.parseInt(m[1] as string, 10);
  return Number.isInteger(pid) ? pid : null;
}

const STALE_TMP_AGE_MS = 24 * 60 * 60 * 1000;

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes (best-effort) tmp files left by writers that never got to rename them into place — a
 * save that crashed or was killed mid-write. F10: a tmp file's own name carries its writer's
 * pid, so a DEAD writer's tmp file is removed at ANY age (nothing is ever going to finish writing
 * it), while a LIVE writer's tmp file is only removed once it's clearly abandoned — older than a
 * day, same as before F10 (a writer that's been "in progress" that long is not actually still
 * writing). Never touches the live cache file.
 */
async function pruneStaleTmpFiles(
  dir: string,
  now: Date,
  isAlive: (pid: number) => boolean,
): Promise<void> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  const mod = pathModule(process.platform);
  for (const name of names) {
    const pid = tmpFilePid(name);
    if (pid === null) continue;
    const full = mod.join(dir, name);
    try {
      if (!isAlive(pid)) {
        await fsp.rm(full, { force: true });
        continue;
      }
      const st = await fsp.stat(full);
      if (now.getTime() - st.mtimeMs > STALE_TMP_AGE_MS) await fsp.rm(full, { force: true });
    } catch {
      // best effort — a race with the writer that owns it, or it's already gone
    }
  }
}

export interface CacheHeader {
  schema: number;
  server: string;
  vaultKey: string;
  writtenAt: string;
  entries: number;
}

export interface LoadResult {
  /** null when there was nothing usable: absent, or the whole cache was rejected (see
   *  `rejected`) — either way the caller does a cold fill. */
  entries: Map<string, IndexEntry> | null;
  /** Entry lines that parsed and passed the shape check. */
  validCount: number;
  /** Entry lines skipped: malformed JSON, wrong shape, a truncated last line, or (F4) a line that
   *  exceeded INDEX_CACHE_MAX_LINE_BYTES. Never fatal. */
  skippedCount: number;
  /** Set only when the WHOLE cache was thrown out (missing/unparseable header, schema mismatch,
   *  vaultKey mismatch, an unreadable file that was not simply absent, or an empty file) — never
   *  set for an absent cache (nothing to reject) or for per-line skips. */
  rejected?: string;
}

/** F4: the byte cap on one line of the cache file, at both load and save. Chosen generously above
 *  any real entry (a note's frontmatter, links, tags and headings, serialized) while still
 *  bounding how much of a single pathological line `loadIndexCache` will ever hold in memory —
 *  4 MiB is a few hundred times a typical entry's size, measured on the 40,000-note scale vault. */
export const INDEX_CACHE_MAX_LINE_BYTES = 4 * 1024 * 1024;

const NEWLINE_BYTE = 0x0a; // '\n'
const CARRIAGE_RETURN_BYTE = 0x0d; // '\r'

/** One line read from the cache file: either its decoded text, or a marker that the line was
 *  dropped for exceeding `INDEX_CACHE_MAX_LINE_BYTES` — still yielded once (so the caller can
 *  count it), never held in memory past the cap. */
type RawLine = { text: string } | { droppedTooLong: true };

/**
 * F4 + F9: splits `filePath` into lines on byte 0x0A ONLY — never `readline`, which (measured)
 * also breaks a line on U+2028/U+2029: valid, unescaped characters inside a JSON string that this
 * cache's own entries can legitimately carry (a note's title or path), which readline's splitting
 * would silently corrupt into two lines and one JSON.parse failure per occurrence. A trailing
 * 0x0D right before the 0x0A is stripped, so CRLF files are tolerated the same way `readline`'s
 * `crlfDelay` used to make them.
 *
 * A line whose accumulated byte length crosses `maxLineBytes` is never buffered past the cap:
 * further bytes for that line are dropped as they arrive (not accumulated, not even briefly) —
 * bounding memory for a pathological single huge line — and it's yielded as `droppedTooLong`
 * once its terminating newline is found (or the stream ends).
 */
async function* splitLinesByByte(filePath: string, maxLineBytes: number): AsyncGenerator<RawLine> {
  const stream = createReadStream(filePath);
  let pieces: Buffer[] = [];
  let lineBytes = 0;
  let tooLong = false;

  const consume = (piece: Buffer): void => {
    if (tooLong || piece.length === 0) return;
    lineBytes += piece.length;
    if (lineBytes > maxLineBytes) {
      tooLong = true;
      pieces = [];
    } else {
      pieces.push(piece);
    }
  };

  const takeLine = (): RawLine => {
    if (tooLong) {
      pieces = [];
      lineBytes = 0;
      tooLong = false;
      return { droppedTooLong: true };
    }
    let buf = Buffer.concat(pieces);
    if (buf.length > 0 && buf[buf.length - 1] === CARRIAGE_RETURN_BYTE) buf = buf.subarray(0, -1);
    pieces = [];
    lineBytes = 0;
    return { text: buf.toString('utf8') };
  };

  try {
    for await (const chunkUnknown of stream) {
      const chunk = chunkUnknown as Buffer;
      let start = 0;
      for (let i = 0; i < chunk.length; i += 1) {
        if (chunk[i] !== NEWLINE_BYTE) continue;
        consume(chunk.subarray(start, i));
        yield takeLine();
        start = i + 1;
      }
      if (start < chunk.length) consume(chunk.subarray(start));
    }
    // A trailing line with no final newline (a truncated write, or simply no EOF newline).
    if (pieces.length > 0 || tooLong) yield takeLine();
  } finally {
    stream.destroy();
  }
}

function looksLikeIndexEntry(value: unknown): value is IndexEntry {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.path === 'string' &&
    typeof o.size === 'number' &&
    typeof o.modifiedAt === 'string' &&
    typeof o.hash === 'string' &&
    typeof o.hasFrontmatter === 'boolean' &&
    typeof o.frontmatter === 'object' &&
    o.frontmatter !== null &&
    !Array.isArray(o.frontmatter) &&
    Array.isArray(o.links) &&
    Array.isArray(o.tags) &&
    Array.isArray(o.headings) &&
    Array.isArray(o.blockIds) &&
    typeof o.wordCount === 'number'
  );
}

function checkHeader(
  line: string,
  expectedVaultKey: string,
): { ok: true } | { ok: false; error: string } {
  let header: unknown;
  try {
    header = JSON.parse(line);
  } catch {
    return { ok: false, error: 'the cache header could not be parsed as JSON' };
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    return { ok: false, error: 'the cache header is not an object' };
  }
  const h = header as Partial<CacheHeader>;
  if (typeof h.schema !== 'number') {
    return { ok: false, error: 'the cache header is missing a numeric "schema"' };
  }
  if (typeof h.vaultKey !== 'string') {
    return { ok: false, error: 'the cache header is missing "vaultKey"' };
  }
  // The schema is already pinned by the file name (cacheFileName()); this check stays as a second
  // line of defense against a file placed or renamed by hand.
  if (h.schema !== INDEX_CACHE_SCHEMA) {
    return {
      ok: false,
      error: `cache schema ${h.schema} does not match the running server's ${INDEX_CACHE_SCHEMA}`,
    };
  }
  if (h.vaultKey !== expectedVaultKey) {
    return { ok: false, error: 'the cache belongs to a different vault' };
  }
  return { ok: true };
}

/**
 * Streams `<dir>/index-v<SCHEMA>.ndjson` line by line (never the whole file into one string — a
 * large vault's cache can be tens of megabytes), via `splitLinesByByte` (F4 + F9 — see its own
 * doc comment for why not `readline`). The first non-blank line is the header; a missing/
 * unparseable header, a schema mismatch or a vaultKey mismatch reject the WHOLE cache (the file
 * is deleted and `rejected` names why); a different `server` alone does NOT reject it. Every
 * following line is one entry: one that fails to parse, fails a cheap shape check, or (F4)
 * exceeds `INDEX_CACHE_MAX_LINE_BYTES` is skipped and counted, never fatal — including a
 * truncated last line from a writer that never finished (nothing to detect this specially: it
 * simply fails to parse like any other bad line).
 */
export async function loadIndexCache(
  dir: string,
  expectedVaultKey: string,
  deps: { now?: () => Date; isAlive?: (pid: number) => boolean } = {},
): Promise<LoadResult> {
  await pruneStaleTmpFiles(dir, deps.now?.() ?? new Date(), deps.isAlive ?? defaultIsAlive);

  const file = pathModule(process.platform).join(dir, cacheFileName());
  const entries = new Map<string, IndexEntry>();
  let validCount = 0;
  let skippedCount = 0;
  let headerSeen = false;
  let rejected: string | undefined;

  try {
    for await (const raw of splitLinesByByte(file, INDEX_CACHE_MAX_LINE_BYTES)) {
      if ('droppedTooLong' in raw) {
        if (!headerSeen) {
          headerSeen = true;
          rejected = `the cache header exceeded the maximum line size (${INDEX_CACHE_MAX_LINE_BYTES} bytes)`;
          break;
        }
        skippedCount += 1;
        continue;
      }
      const rawLine = raw.text;
      if (rawLine === '') continue;
      if (!headerSeen) {
        headerSeen = true;
        const check = checkHeader(rawLine, expectedVaultKey);
        if (!check.ok) {
          rejected = check.error;
          break;
        }
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawLine);
      } catch {
        skippedCount += 1;
        continue;
      }
      if (!looksLikeIndexEntry(parsed)) {
        skippedCount += 1;
        continue;
      }
      entries.set(parsed.path, parsed);
      validCount += 1;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return { entries: null, validCount: 0, skippedCount: 0 };
    return {
      entries: null,
      validCount: 0,
      skippedCount: 0,
      rejected: `could not read the cache file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!headerSeen) {
    await fsp.rm(file, { force: true }).catch(() => {});
    return { entries: null, validCount: 0, skippedCount: 0, rejected: 'the cache file was empty' };
  }
  if (rejected) {
    await fsp.rm(file, { force: true }).catch(() => {});
    return { entries: null, validCount: 0, skippedCount: 0, rejected };
  }
  return { entries, validCount, skippedCount };
}

/** Default time budget for a save; the shutdown path (`src/stdio-main.ts`) passes a tighter one. */
export const DEFAULT_SAVE_BUDGET_MS = 30_000;
/** Bytes buffered before one `write()` call — keeps a 40,000-entry save to a handful of syscalls
 *  instead of one per line. */
const FLUSH_BYTES = 1 << 20;

/**
 * F3: git's own "racily clean" rule, adapted. An index entry and the file it describes are
 * compared by `size` + `modifiedAt` alone (see `FrontmatterIndex.fill`'s cache-hit check) — cheap,
 * but blind to a file rewritten so fast that both stay the same. That pair can only exist for a
 * file that changed *close to* the moment of this save: the index might still hold the content of
 * write 1 while the file on disk already holds write 2 of the same size and the same (coarse,
 * often 1-second-resolution) mtime — reachable if the process serving that write died, or was
 * killed, before the watcher event for write 2 was handled. A file that has been quiet for
 * INDEX_CACHE_RACY_WINDOW_MS before this save started did not just race it: either it was read (or
 * a watcher event for it was handled) comfortably after its last modification, or enough time has
 * passed that a same-second mtime collision with "the next write" is no longer physically possible
 * for this save to be a party to. So: an entry whose `modifiedAt` is not older than
 * `writtenAt - INDEX_CACHE_RACY_WINDOW_MS` is left OUT of the cache — never written stale, simply
 * read from disk again at the next boot, like any path the cache has no entry for at all.
 *
 * What this does NOT close, on purpose, and shares with `FrontmatterIndex.reconcile`: a tool that
 * RESTORES an old mtime onto a file of the same size (`cp -p`, `touch -d`) looks, to both, exactly
 * like a file nobody touched — there is no timestamp this save could have compared against that
 * would catch it, because the file's own metadata no longer says anything happened. Documented,
 * not attempted.
 */
export const INDEX_CACHE_RACY_WINDOW_MS = 3_000;

export interface SaveResult {
  ok: boolean;
  /** Set when `ok` is false: why the save was abandoned or failed. Never thrown. */
  reason?: string;
  durationMs: number;
  /** Entries left out for looking "racily clean" (F3) — present only when `ok` is true (an
   *  abandoned/failed save writes nothing at all, racy or not). */
  racySkipped?: number;
  /** Entries left out because their serialized line would exceed `INDEX_CACHE_MAX_LINE_BYTES`
   *  (F4) — same reasoning as `racySkipped`. */
  oversizedSkipped?: number;
  /** Entries left out because their frontmatter held a non-finite number or `-0` somewhere (F11)
   *  — JSON cannot carry either (`JSON.stringify` turns `NaN`/`Infinity` into `null`, and `-0`
   *  into `"-0"`, which `JSON.parse` reads back as `0`), so a cold and a warm answer would
   *  otherwise disagree. Same reasoning as `racySkipped`. */
  unsafeNumberSkipped?: number;
}

export interface SaveOptions {
  serverVersion: string;
  now?: () => Date;
  /** Abandoned (tmp file deleted, old cache left untouched) if exceeded. Defaults to
   *  DEFAULT_SAVE_BUDGET_MS. */
  budgetMs?: number;
}

/** F11: true when `value` is, or contains anywhere (nested through plain objects and arrays), a
 *  number JSON cannot round-trip: non-finite (`NaN`, `Infinity`, `-Infinity`) or negative zero. */
function hasUnsafeNumber(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isFinite(value) || Object.is(value, -0);
  if (Array.isArray(value)) return value.some(hasUnsafeNumber);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(hasUnsafeNumber);
  }
  return false;
}

/**
 * Writes the whole cache atomically: a unique tmp name in `dir`, fsync'd, then renamed over the
 * live file — a crash mid-write leaves the previous cache (or none), never a half-written one.
 * Two processes saving for the same vault at once are safe: each writes its own tmp name, and
 * whichever renames last wins (the loser's tmp file is gone, having been renamed away, or is
 * simply not the one that ends up at the final name).
 *
 * Three kinds of entry are silently left OUT of what's written — none of this is an error, all
 * three just mean "read from disk again at the next boot", exactly like a path the cache never
 * had an entry for: F11 (a number JSON cannot carry, anywhere in the frontmatter), F3 ("racily
 * clean" — see `INDEX_CACHE_RACY_WINDOW_MS`'s own doc comment), and F4 (a serialized line that
 * would exceed `INDEX_CACHE_MAX_LINE_BYTES` — the same cap `loadIndexCache` enforces on the way
 * back in, so a line this save would refuse to read is never written in the first place).
 */
export async function saveIndexCache(
  dir: string,
  entries: Iterable<IndexEntry>,
  count: number,
  vaultKeyValue: string,
  opts: SaveOptions,
): Promise<SaveResult> {
  const started = Date.now();
  const now = opts.now ?? ((): Date => new Date());
  const budgetMs = opts.budgetMs ?? DEFAULT_SAVE_BUDGET_MS;
  const mod = pathModule(process.platform);
  const file = mod.join(dir, cacheFileName());
  const tmp = mod.join(
    dir,
    `.${cacheFileName()}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );

  const writtenAt = now();
  const header: CacheHeader = {
    schema: INDEX_CACHE_SCHEMA,
    server: opts.serverVersion,
    vaultKey: vaultKeyValue,
    writtenAt: writtenAt.toISOString(),
    entries: count,
  };
  const racyCutoffMs = writtenAt.getTime() - INDEX_CACHE_RACY_WINDOW_MS;

  let handle: FileHandle | undefined;
  const abandon = async (reason: string): Promise<SaveResult> => {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
    return { ok: false, reason, durationMs: Date.now() - started };
  };

  let racySkipped = 0;
  let oversizedSkipped = 0;
  let unsafeNumberSkipped = 0;

  try {
    handle = await fsp.open(tmp, 'w', 0o600);
    let buffer = `${JSON.stringify(header)}\n`;
    const flush = async (): Promise<void> => {
      if (buffer === '') return;
      await (handle as FileHandle).write(buffer);
      buffer = '';
    };
    for (const entry of entries) {
      if (Date.now() - started > budgetMs) return await abandon('save exceeded its time budget');

      if (hasUnsafeNumber(entry.frontmatter)) {
        unsafeNumberSkipped += 1;
        continue;
      }

      // An unparseable modifiedAt can't be judged "safely old" either — conservatively treated
      // the same as racy (never expected in practice: it always comes from a real fs stat).
      const modifiedMs = Date.parse(entry.modifiedAt);
      if (Number.isNaN(modifiedMs) || modifiedMs >= racyCutoffMs) {
        racySkipped += 1;
        continue;
      }

      const line = `${JSON.stringify(entry)}\n`;
      if (Buffer.byteLength(line, 'utf8') > INDEX_CACHE_MAX_LINE_BYTES) {
        oversizedSkipped += 1;
        continue;
      }

      buffer += line;
      if (buffer.length >= FLUSH_BYTES) await flush();
    }
    await flush();
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsp.rename(tmp, file);
    return {
      ok: true,
      durationMs: Date.now() - started,
      racySkipped,
      oversizedSkipped,
      unsafeNumberSkipped,
    };
  } catch (error) {
    return await abandon(error instanceof Error ? error.message : String(error));
  }
}

/** Shape `src/vault/runtime.ts`'s `LocalRuntimeOptions.indexCache` expects — structural, not
 *  imported from there, so `runtime.ts` never has to import this storage module directly. */
export interface IndexCacheHandle {
  load(): Promise<{
    entries: Map<string, IndexEntry> | null;
    rejected?: string;
    /** F4: lines dropped while loading, for any reason (malformed JSON, wrong shape, a truncated
     *  last line, or a line over `INDEX_CACHE_MAX_LINE_BYTES`) — surfaced in
     *  `brainstem_ping.index.cache.skipped`. */
    skipped: number;
  }>;
  save(
    entries: Iterable<IndexEntry>,
    count: number,
    opts?: { budgetMs?: number },
  ): Promise<{ ok: boolean; reason?: string; durationMs: number }>;
}

/** Binds a resolved cache folder + vault key to the two calls `createLocalRuntime` needs — the
 *  one place `src/stdio-main.ts` has to wire up, instead of repeating `loadIndexCache`/
 *  `saveIndexCache`'s argument lists at every call site (and in every test that wants a real
 *  cache instead of a hand-rolled fake). */
export function createIndexCacheHandle(
  dir: string,
  key: string,
  serverVersion: string,
): IndexCacheHandle {
  return {
    load: async () => {
      const result = await loadIndexCache(dir, key);
      return { entries: result.entries, rejected: result.rejected, skipped: result.skippedCount };
    },
    save: (entries, count, opts) =>
      saveIndexCache(dir, entries, count, key, { serverVersion, budgetMs: opts?.budgetMs }),
  };
}
