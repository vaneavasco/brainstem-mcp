import { randomBytes } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import pathPosix from 'node:path/posix';
import pathWin32 from 'node:path/win32';
import readline from 'node:readline';
import { INDEX_CACHE_SCHEMA, type IndexEntry } from '../vault/frontmatter-index.ts';
import { vaultKey } from './local-state.ts';

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

function isTmpFileName(name: string): boolean {
  return /^\.index-v\d+\.ndjson\.\d+\.[0-9a-f]+\.tmp$/.test(name);
}

const STALE_TMP_AGE_MS = 24 * 60 * 60 * 1000;

/** Removes (best-effort) tmp files of dead writers — a save that crashed or was killed before it
 *  could rename its tmp file into place — older than a day. Never touches the live cache file. */
async function pruneStaleTmpFiles(dir: string, now: Date): Promise<void> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  const mod = pathModule(process.platform);
  for (const name of names) {
    if (!isTmpFileName(name)) continue;
    const full = mod.join(dir, name);
    try {
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
  /** Entry lines skipped: malformed JSON, wrong shape, or a truncated last line. Never fatal. */
  skippedCount: number;
  /** Set only when the WHOLE cache was thrown out (missing/unparseable header, schema mismatch,
   *  vaultKey mismatch, an unreadable file that was not simply absent, or an empty file) — never
   *  set for an absent cache (nothing to reject) or for per-line skips. */
  rejected?: string;
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
 * large vault's cache can be tens of megabytes). The first non-blank line is the header; a
 * missing/unparseable header, a schema mismatch or a vaultKey mismatch reject the WHOLE cache
 * (the file is deleted and `rejected` names why); a different `server` alone does NOT reject it.
 * Every following line is one entry: one that fails to parse or fails a cheap shape check is
 * skipped and counted, never fatal — including a truncated last line from a writer that never
 * finished (nothing to detect this specially: it simply fails to parse like any other bad line).
 */
export async function loadIndexCache(
  dir: string,
  expectedVaultKey: string,
  deps: { now?: () => Date } = {},
): Promise<LoadResult> {
  await pruneStaleTmpFiles(dir, deps.now?.() ?? new Date());

  const file = pathModule(process.platform).join(dir, cacheFileName());
  const entries = new Map<string, IndexEntry>();
  let validCount = 0;
  let skippedCount = 0;
  let headerSeen = false;
  let rejected: string | undefined;

  try {
    const stream = createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    try {
      for await (const rawLine of rl) {
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
    } finally {
      rl.close();
      stream.destroy();
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

export interface SaveResult {
  ok: boolean;
  /** Set when `ok` is false: why the save was abandoned or failed. Never thrown. */
  reason?: string;
  durationMs: number;
}

export interface SaveOptions {
  serverVersion: string;
  now?: () => Date;
  /** Abandoned (tmp file deleted, old cache left untouched) if exceeded. Defaults to
   *  DEFAULT_SAVE_BUDGET_MS. */
  budgetMs?: number;
}

/**
 * Writes the whole cache atomically: a unique tmp name in `dir`, fsync'd, then renamed over the
 * live file — a crash mid-write leaves the previous cache (or none), never a half-written one.
 * Two processes saving for the same vault at once are safe: each writes its own tmp name, and
 * whichever renames last wins (the loser's tmp file is gone, having been renamed away, or is
 * simply not the one that ends up at the final name).
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

  const header: CacheHeader = {
    schema: INDEX_CACHE_SCHEMA,
    server: opts.serverVersion,
    vaultKey: vaultKeyValue,
    writtenAt: now().toISOString(),
    entries: count,
  };

  let handle: FileHandle | undefined;
  const abandon = async (reason: string): Promise<SaveResult> => {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
    return { ok: false, reason, durationMs: Date.now() - started };
  };

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
      buffer += `${JSON.stringify(entry)}\n`;
      if (buffer.length >= FLUSH_BYTES) await flush();
    }
    await flush();
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsp.rename(tmp, file);
    return { ok: true, durationMs: Date.now() - started };
  } catch (error) {
    return await abandon(error instanceof Error ? error.message : String(error));
  }
}

/** Shape `src/vault/runtime.ts`'s `LocalRuntimeOptions.indexCache` expects — structural, not
 *  imported from there, so `runtime.ts` never has to import this storage module directly. */
export interface IndexCacheHandle {
  load(): Promise<{ entries: Map<string, IndexEntry> | null; rejected?: string }>;
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
    load: () => loadIndexCache(dir, key),
    save: (entries, count, opts) =>
      saveIndexCache(dir, entries, count, key, { serverVersion, budgetMs: opts?.budgetMs }),
  };
}
