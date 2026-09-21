import { VaultError } from './types.ts';

export const MAX_FILE_BYTES = 1_048_576;
/** Default cap for `writeBinary` (attachments), overridable via the `MAX_BINARY_BYTES` env var
 *  (see `src/config.ts`) and threaded through `LocalFSAdapter.create`/`createLocalRuntime`.
 *  Text writes always stay at `MAX_FILE_BYTES` regardless of this value. */
export const MAX_BINARY_BYTES = 8 * 1024 * 1024;
export const MAX_BATCH = 20;
/** Heading paths one `vault_read` may ask for in `sections`. */
export const MAX_READ_SECTIONS = 10;
export const MAX_SEARCH_RESULTS = 50;
export const MAX_RESULT_CHARS = 120_000;
/**
 * What the strictest client seen accepts in one tool result. Measured, not guessed: a client with
 * a token limit on tool results took results of about 51,000 characters and refused (or diverted
 * to a file the model cannot read) results of 55,100 and 59,800; another client took 120,000.
 * JSON costs more tokens per character than prose, so the bound keeps a margin below the
 * smallest refusal.
 */
export const CLIENT_SAFE_RESULT_CHARS = 48_000;
/** Longest heading path a read may ask for; an unknown one is echoed back in the error or in
 *  "missingSections", so it counts against the result. */
export const MAX_SECTION_NAME_CHARS = 200;
export const MAX_ANALYTICS_FILES = 2000;
export const MAX_LIST_ENTRIES = 2000;
/** A listing deeper than one level, without a glob, shows its shape (shallowest entries, files
 *  per folder) instead of every path once it holds more entries than this. */
export const MAX_DEEP_LIST_ENTRIES = 200;
export const MAX_FRONTMATTER_HITS = 500;
export const MAX_MATCH_TEXT_CHARS = 400;
/** Serialized size of the frontmatter index above which the server warns (a log line at boot or
 *  on the change that crosses it, `index.overBudget` in brainstem_ping). A warning line, not a
 *  limit: nothing is evicted. Measured on a 37,000-note vault of long notes: 3.5 KB per note
 *  (127 MiB), and the process heap holds about twice the serialized size (254 MB for the index,
 *  373 MB with the graph). So this line sits near 75,000 such notes and about 0.5 GB of heap for
 *  the index; the earlier 64 MiB was an estimate (1–2 KB per note) that real notes doubled. */
export const MAX_INDEX_BYTES = 256 * 1024 * 1024;
/** Room for each flat list of one note in vault_outline (frontmatter key names, tags, block ids):
 *  a sixth of what the strictest client accepts each, so headings, the point of an outline, keep
 *  at least half. */
export const MAX_OUTLINE_LIST_CHARS = CLIENT_SAFE_RESULT_CHARS / 6;
export const MAX_GRAPH_ITEMS = 500;
export const MAX_UNLINKED_MENTIONS = 100;
export const MAX_QUERY_ROWS = 500;
/** Character budget for a whole vault_query / vault_recent result: rows (or "values"), groups,
 *  column names and hints, independent of `limit` — a handful of wide selected fields across a
 *  few hundred rows outgrow what a client accepts. */
export const MAX_QUERY_RESULT_CHARS = CLIENT_SAFE_RESULT_CHARS;
/** `select` names the fields of a row; they are echoed back (as keys, or once as "columns"). */
export const MAX_QUERY_SELECT = 50;
/** Free-text arguments that are echoed back or compiled: a search string, a glob, a tag. */
export const MAX_SEARCH_QUERY_CHARS = 1_000;
export const MAX_GLOB_CHARS = 1_000;
export const MAX_TAG_CHARS = 200;
/** Same number as the path policy's own limit: an argument longer than any legal path is refused
 *  by the schema, before it can be echoed in an error. */
export const MAX_PATH_ARG_CHARS = 1_024;
export const MAX_QUERY_FIELD_CHARS = 200;
/** Background index reconcile interval (VAULT_RECONCILE_MS); 0 disables it. */
export const DEFAULT_RECONCILE_MS = 300_000;
/** How long a gated vault tool waits for a deferred index build (`createLocalRuntime({
 *  deferIndex: true })`, used by the stdio entrypoint) before answering with a "still building"
 *  error instead of running. 45 s: measured on a 37,700-note vault the build takes about 32 s, and
 *  with 20 s a query that needed 11 more seconds was answered with an error; the MCP client SDK's
 *  default request timeout is 60 s, so the wait must stay under that or the client gives up first
 *  and learns nothing. Overridable per runtime (`LocalRuntimeOptions.indexWaitMs`) for tests. */
export const INDEX_WAIT_MS = 45_000;
/** How long a call already waiting for the index keeps waiting once the server is stopping. */
export const STOPPING_INDEX_WAIT_MS = 2_000;
/** Pauses between attempts of the pass that must succeed before a deferred index is ready: a
 *  transient failure (a folder unreadable for a moment) is retried for about half a minute. */
export const DEFAULT_SETTLE_RETRY_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
/** Shortest allowed reconcile interval: each pass lists the whole vault. */
export const MIN_RECONCILE_MS = 10_000;
/** Fraction of markdown notes that had to be read from disk (not served from the machine-local
 *  index cache — `src/storage/local-cache.ts`) above which the cache is worth rewriting right
 *  after the index becomes ready, even though it was present and valid: a cache 1% stale is
 *  barely worth a rewrite; the boot that follows would still hit disk for almost everything if it
 *  weren't refreshed. Below this, the existing cache is left as it is until something else
 *  triggers a save (an hourly tick, or a clean shutdown with a changed index). */
export const INDEX_CACHE_STALE_FRACTION = 0.01;
/** How often a warm, still-running stdio server rewrites its index cache if anything changed
 *  since the last save — an unref'd timer, so it never keeps the process alive on its own. */
export const INDEX_CACHE_HOURLY_SAVE_MS = 60 * 60 * 1000;
/** A save that had to leave just-modified entries out (the 3 s racy window in local-cache.ts) is
 *  repeated once, this long after it: the window plus a margin. */
export const INDEX_CACHE_RACY_RESAVE_MS = 4_000;
/** Time budget for the index-cache save attempted during shutdown (`VaultRuntime.close()`):
 *  shorter than the background default (`DEFAULT_SAVE_BUDGET_MS` in local-cache.ts, 30 s) because
 *  `src/stdio-main.ts` gives the whole shutdown sequence only SHUTDOWN_TIMEOUT_MS (10 s) — this
 *  leaves headroom for draining calls and closing the transport around it. Measured
 *  (`tests/scale/vault.scale.ts`): saving the 40,000-note scale vault's cache (~75 MiB, 40,001
 *  entries) took ~386 ms on the machine this was developed on; 5 s is generous margin for a
 *  slower disk, not a number this vault needs.
 */
export const INDEX_CACHE_SHUTDOWN_SAVE_BUDGET_MS = 5_000;
/**
 * A shutdown save is skipped outright (not even attempted) when the shutdown reason is a dead
 * client (the other end of the pipe is already gone — nobody is waiting on this session again
 * soon, so a slow disk turning a bounded save into wasted shutdown time buys nothing) AND the
 * index holds more notes than this. Measured on the 40,000-note scale vault: an index that size
 * saves in well under a second — ~386 ms, see INDEX_CACHE_SHUTDOWN_SAVE_BUDGET_MS above — so this
 * is set well above that vault's size (about 3.75x its note count): a dead-client shutdown only
 * skips the save for a vault substantially larger than the one this project measured, where "well
 * under a second" is no longer a safe assumption.
 */
export const INDEX_CACHE_DEAD_CLIENT_SKIP_NOTES = 150_000;
/** Minimum distance between reconciles triggered by watcher errors. */
export const DEFAULT_RECONCILE_MIN_GAP_MS = 30_000;
export const MAX_RECENT = 200;
/** Regex search patterns run only through ripgrep; capped like the query engine's regex op. */
export const MAX_SEARCH_PATTERN_CHARS = 200;
/** Above this many pre-filtered candidate paths, vault_search scans everything and post-filters
 *  matches by path instead of handing ripgrep/the JS fallback an explicit file list. */
export const MAX_SEARCH_PATHS = 200;
/** Internal scan cap when vault_search's own candidate list (from evaluateQuery) was itself
 *  truncated (more than MAX_QUERY_ROWS true matches) and so cannot be trusted as exhaustive:
 *  the whole vault is scanned up to this many raw text matches, then filtered by re-testing each
 *  matched file's index entry against the same where/tags/pathPrefix query. */
export const MAX_SEARCH_SCAN = 2000;

/** How often a running stdio process re-writes (touches) its own `instances/<pid>.json` (F5,
 *  `src/storage/local-peers.ts`) — an unref'd timer, so it never keeps the process alive on its
 *  own. Also the grace period an unparseable instance file gets before it's pruned (it may be
 *  mid-write by an older, non-atomic-writing version — one heartbeat interval is enough for that
 *  to resolve itself either way). */
export const INSTANCE_HEARTBEAT_MS = 60_000;
/** An instance file older than this (or whose pid is dead) is no longer a live peer and is
 *  pruned. Three heartbeats: the portable defence against pid reuse (a crashed server's pid
 *  reused by an unrelated process stops counting once its stale instance file ages out), with
 *  margin for a heartbeat that was merely late (a slow disk, a busy event loop). */
export const INSTANCE_STALE_MS = 3 * INSTANCE_HEARTBEAT_MS;
/** Bounded concurrency for the `instances/` directory scan (stat/read per entry). */
export const INSTANCE_SCAN_CONCURRENCY = 32;
/** Caps one `listOtherLivePeers` scan at this many directory entries — several stdio sessions on
 *  one vault is normal, but nothing should make one `brainstem_ping` call stat and read an
 *  unbounded number of files. Logged once per call when the cap is actually hit. */
export const INSTANCE_SCAN_MAX = 2_000;

// Obsidian's own accepted attachment formats (Files & links → "Supported file formats"), plus
// the pre-existing png/jpeg/gif/webp/pdf. `.webm` is deliberately listed under both audio/webm
// and video/webm — extensionAllowedFor looks up by MIME key, so either MIME accepts the same
// extension without any change to the matching logic.
export const BINARY_MIME_ALLOWLIST: ReadonlyMap<string, readonly string[]> = new Map([
  ['image/png', ['.png']],
  ['image/jpeg', ['.jpg', '.jpeg']],
  ['image/gif', ['.gif']],
  ['image/webp', ['.webp']],
  ['image/avif', ['.avif']],
  ['image/bmp', ['.bmp']],
  ['image/svg+xml', ['.svg']],
  ['application/pdf', ['.pdf']],
  ['audio/mpeg', ['.mp3']],
  ['audio/mp4', ['.m4a']],
  ['audio/ogg', ['.ogg']],
  ['audio/wav', ['.wav']],
  ['audio/flac', ['.flac']],
  ['audio/webm', ['.webm']],
  ['audio/3gpp', ['.3gp']],
  ['video/mp4', ['.mp4']],
  ['video/quicktime', ['.mov']],
  ['video/x-matroska', ['.mkv']],
  ['video/ogg', ['.ogv']],
  ['video/webm', ['.webm']],
]);

/** Windows one line of match/context text so a single long line cannot blow the result-size cap.
 *  The one clamp shared by adapter search matches and the graph tools' context lines. */
export function clampMatchText(text: string): string {
  return text.length > MAX_MATCH_TEXT_CHARS ? `${text.slice(0, MAX_MATCH_TEXT_CHARS)}…` : text;
}

export function assertWithinSize(
  bytes: number,
  what: string,
  limit: number = MAX_FILE_BYTES,
): void {
  if (bytes > limit) {
    const mib = limit / (1024 * 1024);
    // The parenthetical is a readability aid for MiB-scale limits; below 1 MiB it would round
    // to a meaningless "0.0 MiB", so the exact byte count stands alone.
    const inMib = mib >= 1 ? ` (${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB)` : '';
    throw new VaultError(
      'TOO_LARGE',
      `${what} is ${bytes} bytes; the limit is ${limit} bytes${inMib}. Split the content or use vault_append/vault_edit.`,
    );
  }
}

export function assertBatchSize(count: number): void {
  if (count < 1 || count > MAX_BATCH) {
    throw new VaultError(
      'INVALID_INPUT',
      `Batch size must be between 1 and ${MAX_BATCH} (got ${count}).`,
    );
  }
}

export function extensionAllowedFor(mime: string, path: string): boolean {
  const exts = BINARY_MIME_ALLOWLIST.get(mime.toLowerCase());
  if (!exts) return false;
  const lower = path.toLowerCase();
  return exts.some((ext) => lower.endsWith(ext));
}
