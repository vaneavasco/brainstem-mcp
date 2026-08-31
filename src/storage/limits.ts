import { VaultError } from './types.ts';

export const MAX_FILE_BYTES = 1_048_576;
/** Default cap for `writeBinary` (attachments), overridable via the `MAX_BINARY_BYTES` env var
 *  (see `src/config.ts`) and threaded through `LocalFSAdapter.create`/`createLocalRuntime`.
 *  Text writes always stay at `MAX_FILE_BYTES` regardless of this value. */
export const MAX_BINARY_BYTES = 8 * 1024 * 1024;
export const MAX_BATCH = 20;
export const MAX_SEARCH_RESULTS = 50;
export const MAX_RESULT_CHARS = 120_000;
export const MAX_ANALYTICS_FILES = 2000;
export const MAX_LIST_ENTRIES = 2000;
export const MAX_FRONTMATTER_HITS = 500;
export const MAX_MATCH_TEXT_CHARS = 400;
export const MAX_INDEX_BYTES = 64 * 1024 * 1024;
export const MAX_GRAPH_ITEMS = 500;
export const MAX_UNLINKED_MENTIONS = 100;
export const MAX_QUERY_ROWS = 500;
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
