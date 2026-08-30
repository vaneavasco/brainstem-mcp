import { VaultError } from './types.ts';

export const MAX_FILE_BYTES = 1_048_576;
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

export const BINARY_MIME_ALLOWLIST: ReadonlyMap<string, readonly string[]> = new Map([
  ['image/png', ['.png']],
  ['image/jpeg', ['.jpg', '.jpeg']],
  ['image/gif', ['.gif']],
  ['image/webp', ['.webp']],
  ['application/pdf', ['.pdf']],
]);

export function assertWithinSize(bytes: number, what: string): void {
  if (bytes > MAX_FILE_BYTES) {
    throw new VaultError(
      'TOO_LARGE',
      `${what} is ${bytes} bytes; the limit is ${MAX_FILE_BYTES} bytes (1 MiB). Split the content or use vault_append/vault_edit.`,
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
