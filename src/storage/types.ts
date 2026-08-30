export type VaultErrorCode =
  | 'INVALID_PATH'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'TOO_LARGE'
  | 'CONFIRM_REQUIRED'
  | 'INVALID_INPUT'
  | 'ENCODING'
  | 'UNSUPPORTED'
  | 'IO';

export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
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
  writeBinary(path: string, bytes: Uint8Array, mime: string): Promise<void>;
  edit(path: string, patches: TextPatch[], dryRun?: boolean): Promise<EditResult>;
  append(path: string, content: string): Promise<void>;
  batchFrontmatterUpdate(updates: FmUpdate[]): Promise<BatchResult>;
  list(prefix: string, opts?: ListOpts): Promise<Entry[]>;
  move(from: string, to: string): Promise<void>;
  softDelete(path: string, confirm: boolean): Promise<void>;
  search(query: string, opts?: SearchOpts): Promise<Match[]>;
  watch?(onChange: (e: ChangeEvent) => void): Unsubscribe;
  capabilities(): Caps;
}
