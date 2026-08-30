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
  failed: { path: string; error: string }[];
}

export interface SearchOpts {
  limit?: number;
  caseSensitive?: boolean;
  pathPrefix?: string;
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
  write(path: string, content: string, opts?: WriteOpts): Promise<void>;
  writeBinary(path: string, bytes: Uint8Array, mime: string, opts?: MutateOpts): Promise<void>;
  edit(
    path: string,
    patches: TextPatch[],
    dryRun?: boolean,
    opts?: MutateOpts,
  ): Promise<EditResult>;
  append(path: string, content: string, opts?: MutateOpts): Promise<void>;
  batchFrontmatterUpdate(updates: FmUpdate[]): Promise<BatchResult>;
  list(prefix: string, opts?: ListOpts): Promise<Entry[]>;
  move(from: string, to: string, opts?: MutateOpts): Promise<void>;
  softDelete(path: string, confirm: boolean, opts?: MutateOpts): Promise<void>;
  search(query: string, opts?: SearchOpts): Promise<Match[]>;
  /** sha256hex of the file's decoded text, or null when it does not exist or is not text. */
  hashOf(path: string): Promise<string | null>;
  /** Unlinks a file outright, bypassing .trash. Internal use only (transaction rollback). */
  hardDelete(path: string): Promise<void>;
  watch?(onChange: (e: ChangeEvent) => void): Unsubscribe;
  capabilities(): Caps;
}
