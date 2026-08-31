export type VaultErrorCode =
  | 'INVALID_PATH'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'TOO_LARGE'
  | 'CONFIRM_REQUIRED'
  | 'INVALID_INPUT'
  | 'ENCODING'
  | 'UNSUPPORTED'
  | 'IO'
  | 'CONFLICT';

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: VaultErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
    this.details = details;
  }
}

/** Message for a per-item `failed[]` entry: CONFLICT keeps its code prefix (the caller needs the
 *  re-read-and-retry advice), every other code stays bare. The one rule shared by
 *  batchFrontmatterUpdate and vault_move's rewrite loops. */
export function failedEntryMessage(error: VaultError): string {
  return error.code === 'CONFLICT' ? `${error.code}: ${error.message}` : error.message;
}

export interface NoteMeta {
  size: number;
  modifiedAt: string;
}

export interface Note {
  path: string;
  content: string;
  frontmatter: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
  meta: NoteMeta;
  hash: string;
}

export interface Entry {
  path: string;
  kind: 'file' | 'dir';
  size?: number;
  modifiedAt?: string;
}

export interface ListOpts {
  depth?: number;
  glob?: string;
  includeFiles?: boolean;
  includeDirs?: boolean;
}

export interface WriteOpts {
  mergeFrontmatter?: boolean;
  expectedHash?: string;
}

/** Optimistic-concurrency option shared by mutating adapter methods other than `write`. */
export interface MutateOpts {
  expectedHash?: string;
}

export interface TextPatch {
  find: string;
  replace: string;
}

export interface EditResult {
  path: string;
  applied: number;
  diff: string;
  dryRun: boolean;
  /** Post-edit note (for dryRun: the unchanged pre-edit note) — lets callers reuse the content
   *  and hash without re-reading the file they just wrote. */
  note: Note;
}

export interface FmUpdate {
  path: string;
  set?: Record<string, unknown>;
  unset?: string[];
  expectedHash?: string;
}

export interface BatchReadResult {
  notes: Note[];
  missing: string[];
  failed: { path: string; error: string }[];
}

export interface BatchResult {
  updated: string[];
  /** Post-write notes, aligned 1:1 with `updated` — same no-re-read purpose as EditResult.note. */
  updatedNotes: Note[];
  failed: { path: string; error: string }[];
}

export interface SearchOpts {
  limit?: number;
  caseSensitive?: boolean;
  pathPrefix?: string;
  /** Treat the query as a ripgrep regular expression instead of a literal substring. Requires
   *  ripgrep — throws UNSUPPORTED without it. Pattern length is capped. */
  regex?: boolean;
  /** Restrict the search to exactly these vault-relative paths (≤200), skipping the directory
   *  walk. Callers (the vault_search tool) pass already-normalized index paths. */
  paths?: string[];
}

export interface Match {
  path: string;
  line: number;
  text: string;
}

export interface ChangeEvent {
  type: 'create' | 'update' | 'delete';
  path: string;
}

export type Unsubscribe = () => void;

export interface Caps {
  atomicWrites: boolean;
  nativeSearch: boolean;
  watch: boolean;
  revisions: boolean;
}

export interface StorageAdapter {
  read(path: string): Promise<Note>;
  batchRead(paths: string[]): Promise<BatchReadResult>;
  /** Resolves to the post-write note (fresh stat, content from memory — no re-read). */
  write(path: string, content: string, opts?: WriteOpts): Promise<Note>;
  /** Resolves to the post-write content hash (same text-or-raw-bytes rule as `hashOf`). */
  writeBinary(path: string, bytes: Uint8Array, mime: string, opts?: MutateOpts): Promise<string>;
  edit(
    path: string,
    patches: TextPatch[],
    dryRun?: boolean,
    opts?: MutateOpts,
  ): Promise<EditResult>;
  /** Resolves to the post-append note, like `write`. */
  append(path: string, content: string, opts?: MutateOpts): Promise<Note>;
  batchFrontmatterUpdate(updates: FmUpdate[]): Promise<BatchResult>;
  list(prefix: string, opts?: ListOpts): Promise<Entry[]>;
  move(from: string, to: string, opts?: MutateOpts): Promise<void>;
  softDelete(path: string, confirm: boolean, opts?: MutateOpts): Promise<void>;
  search(query: string, opts?: SearchOpts): Promise<Match[]>;
  /** sha256hex of the file's decoded text, or null when it does not exist or is a directory (non-text files hash their raw bytes). */
  hashOf(path: string): Promise<string | null>;
  /** Unlinks a file outright, bypassing .trash. Internal use only (transaction rollback). */
  hardDelete(path: string): Promise<void>;
  watch?(onChange: (e: ChangeEvent) => void): Unsubscribe;
  capabilities(): Caps;
}
