# Phase 1 — Core Tools on LocalFS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** All 20 vault tools working end-to-end against a local folder vault (`LocalFSAdapter`), with the shared `StorageAdapter` contract, path policy, frontmatter handling, frontmatter index, daily notes, canvas and analytics — behavior-compatible with the reference project and ready for Phase 2 to swap in per-tenant runtimes.

**Architecture:** `src/storage/` holds the adapter contract (`types.ts`), the security boundary (`path-policy.ts`), pure text utilities (`frontmatter.ts`, `text-diff.ts`, `limits.ts`) and `LocalFSAdapter`. `src/vault/` holds vault-level features that are adapter-agnostic (daily notes, canvas, analytics, frontmatter index). `src/tools/` registers MCP tools against a `ToolDeps` object; `src/mcp/factory.ts` obtains a `VaultRuntime` from a `RuntimeResolver` per request (Phase 1: one static runtime built from env; Phase 2: per-tenant from the bearer token). Tools never touch the filesystem directly and never branch on adapter class — only on `capabilities()`.

**Tech Stack:** Phase 0 stack + `yaml@^2.9`, `diff@^9`, `picomatch@^4` (+ `@types/picomatch`), `chokidar@^5`, `date-fns@^4.4`, `@date-fns/tz@^1.5`.

**Spec:** `docs/implementation-plan.md` §4, §5, §6, §8 (items 2, 7, 8, 10), §9 (Phase 1).

## Global Constraints

- Limits (server-side, non-negotiable): `MAX_FILE_BYTES = 1_048_576`, `MAX_BATCH = 20`, `MAX_SEARCH_RESULTS = 50`, `MAX_RESULT_CHARS = 120_000`, binary MIME allowlist `image/png, image/jpeg, image/gif, image/webp, application/pdf`.
- Every path from a tool argument passes `normalizeVaultPath()` before reaching an adapter. Rejected: `..` segments, absolute paths (POSIX and Windows), NUL bytes, backslashes are normalized to `/`, any segment starting with `.` (so `.obsidian`, `.git`, `.trash` are unreachable from tools).
- Tools branch on `adapter.capabilities()`, never on class names.
- Every tool declares `title`, `description`, `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint: false`); list/search/batch/analytics/edit-dry-run tools declare `outputSchema` and return `structuredContent` **and** a JSON text block.
- Tool execution errors are returned as `{ isError: true, content: [{ type: 'text', text }] }` with an actionable message; never a stack trace, never note content echoed in error text beyond the path.
- Ripgrep is invoked with an argv array via `execFile` — never a shell string.
- Frontmatter parsing uses the `yaml` package (not gray-matter — see ADR 0004 written in Task 3). Key order and unknown keys are preserved on rewrite.
- Daily notes are computed in the vault's configured IANA timezone (default `UTC`), never the dyno's local time.
- Tests use temp directories from `fs.mkdtemp(os.tmpdir())` and clean up in `afterEach`. Integration tests talk to the real Express app over `127.0.0.1` with the SDK `Client` (modern era).
- Commit after every task (Conventional Commits). Typecheck + lint + tests green before each commit.

---

### Task 1: Storage contract types, VaultError and limits

**Files:**
- Create: `src/storage/types.ts`, `src/storage/limits.ts`
- Test: `tests/storage/limits.test.ts`

**Interfaces:**
- Produces (used by every later task — copy exactly):
  ```ts
  // src/storage/types.ts
  export type VaultErrorCode =
    | 'INVALID_PATH' | 'NOT_FOUND' | 'ALREADY_EXISTS' | 'TOO_LARGE' | 'CONFIRM_REQUIRED'
    | 'INVALID_INPUT' | 'ENCODING' | 'UNSUPPORTED' | 'IO';
  export class VaultError extends Error { readonly code: VaultErrorCode; constructor(code, message) }
  export interface NoteMeta { size: number; modifiedAt: string }            // ISO-8601
  export interface Note { path: string; content: string; frontmatter: Record<string, unknown>; body: string; hasFrontmatter: boolean; meta: NoteMeta }
  export interface Entry { path: string; kind: 'file' | 'dir'; size?: number; modifiedAt?: string }
  export interface ListOpts { depth?: number; glob?: string; includeFiles?: boolean; includeDirs?: boolean }
  export interface WriteOpts { mergeFrontmatter?: boolean }
  export interface TextPatch { find: string; replace: string }
  export interface EditResult { path: string; applied: number; diff: string; dryRun: boolean }
  export interface FmUpdate { path: string; set?: Record<string, unknown>; unset?: string[] }
  export interface BatchReadResult { notes: Note[]; missing: string[]; failed: { path: string; error: string }[] }
  export interface BatchResult { updated: string[]; failed: { path: string; error: string }[] }
  export interface SearchOpts { limit?: number; caseSensitive?: boolean; pathPrefix?: string }
  export interface Match { path: string; line: number; text: string }
  export interface ChangeEvent { type: 'create' | 'update' | 'delete'; path: string }
  export type Unsubscribe = () => void;
  export interface Caps { atomicWrites: boolean; nativeSearch: boolean; watch: boolean; revisions: boolean }
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
  // src/storage/limits.ts
  export const MAX_FILE_BYTES = 1_048_576; export const MAX_BATCH = 20; export const MAX_SEARCH_RESULTS = 50;
  export const MAX_RESULT_CHARS = 120_000; export const MAX_ANALYTICS_FILES = 2000;
  export const BINARY_MIME_ALLOWLIST: ReadonlyMap<string, readonly string[]>;   // mime -> allowed extensions
  export function assertWithinSize(bytes: number, what: string): void;          // throws VaultError TOO_LARGE
  export function assertBatchSize(count: number): void;                         // throws VaultError INVALID_INPUT
  export function extensionAllowedFor(mime: string, path: string): boolean;
  ```

- [ ] **Step 1: Write the failing test**

`tests/storage/limits.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  MAX_BATCH,
  MAX_FILE_BYTES,
  assertBatchSize,
  assertWithinSize,
  extensionAllowedFor,
} from '../../src/storage/limits.ts';
import { VaultError } from '../../src/storage/types.ts';

describe('limits', () => {
  it('accepts sizes up to the cap and rejects above it with TOO_LARGE', () => {
    expect(() => assertWithinSize(MAX_FILE_BYTES, 'file')).not.toThrow();
    let err: unknown;
    try {
      assertWithinSize(MAX_FILE_BYTES + 1, 'file');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VaultError);
    expect((err as VaultError).code).toBe('TOO_LARGE');
    expect((err as VaultError).message).toContain('1048576');
  });

  it('caps batch sizes at MAX_BATCH', () => {
    expect(() => assertBatchSize(MAX_BATCH)).not.toThrow();
    expect(() => assertBatchSize(MAX_BATCH + 1)).toThrow(VaultError);
    expect(() => assertBatchSize(0)).toThrow(VaultError);
  });

  it('matches binary extensions to their mime type', () => {
    expect(extensionAllowedFor('image/png', 'img/a.png')).toBe(true);
    expect(extensionAllowedFor('image/jpeg', 'img/a.JPG')).toBe(true);
    expect(extensionAllowedFor('image/jpeg', 'img/a.jpeg')).toBe(true);
    expect(extensionAllowedFor('application/pdf', 'docs/a.pdf')).toBe(true);
    expect(extensionAllowedFor('image/png', 'img/a.jpg')).toBe(false);
    expect(extensionAllowedFor('application/x-msdownload', 'a.exe')).toBe(false);
    expect(extensionAllowedFor('text/html', 'a.html')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/storage/limits.test.ts`
Expected: FAIL — cannot find `../../src/storage/limits.ts`.

- [ ] **Step 3: Implement src/storage/types.ts**

```ts
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
```

- [ ] **Step 4: Implement src/storage/limits.ts**

```ts
import { VaultError } from './types.ts';

export const MAX_FILE_BYTES = 1_048_576;
export const MAX_BATCH = 20;
export const MAX_SEARCH_RESULTS = 50;
export const MAX_RESULT_CHARS = 120_000;
export const MAX_ANALYTICS_FILES = 2000;

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
```

- [ ] **Step 5: Run tests, typecheck, lint, commit**

Run: `npx vitest run tests/storage/limits.test.ts && npm run typecheck && npm run lint:fix`
Expected: PASS (3 tests).

```bash
git add -A
git commit -m "feat(storage): adapter contract types, VaultError and server-side limits"
```

---

### Task 2: Path policy (security boundary)

**Files:**
- Create: `src/storage/path-policy.ts`
- Test: `tests/storage/path-policy.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PathPolicyOptions { allowInternal?: boolean }   // internal use only (.trash moves)
  export function normalizeVaultPath(input: unknown, opts?: PathPolicyOptions): string  // throws VaultError INVALID_PATH
  export function isMarkdownPath(path: string): boolean
  export function parentDir(path: string): string                 // '' for root-level files
  export function baseName(path: string): string                  // 'note.md'
  export const TRASH_DIR = '.trash';
  ```

- [ ] **Step 1: Write the failing test**

`tests/storage/path-policy.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  TRASH_DIR,
  baseName,
  isMarkdownPath,
  normalizeVaultPath,
  parentDir,
} from '../../src/storage/path-policy.ts';
import { VaultError } from '../../src/storage/types.ts';

function rejects(input: unknown): string {
  try {
    normalizeVaultPath(input);
  } catch (e) {
    expect(e).toBeInstanceOf(VaultError);
    expect((e as VaultError).code).toBe('INVALID_PATH');
    return (e as VaultError).message;
  }
  throw new Error(`expected rejection for ${JSON.stringify(input)}`);
}

describe('normalizeVaultPath', () => {
  it('normalizes ordinary relative paths', () => {
    expect(normalizeVaultPath('01-projects/plan.md')).toBe('01-projects/plan.md');
    expect(normalizeVaultPath('./01-projects//plan.md')).toBe('01-projects/plan.md');
    expect(normalizeVaultPath('01-projects/./plan.md/')).toBe('01-projects/plan.md');
    expect(normalizeVaultPath('  notes/a.md  ')).toBe('notes/a.md');
    expect(normalizeVaultPath('notes\\win\\a.md')).toBe('notes/win/a.md');
    expect(normalizeVaultPath('')).toBe('');
    expect(normalizeVaultPath('/')).toBe('');
  });

  it('rejects traversal in every disguise', () => {
    rejects('../secret.md');
    rejects('notes/../../etc/passwd');
    rejects('notes/..');
    rejects('..');
    rejects('notes\\..\\x.md');
  });

  it('rejects absolute paths (POSIX, Windows drive, UNC, scheme)', () => {
    rejects('/etc/passwd');
    rejects('C:\\Users\\x\\note.md');
    rejects('c:/x.md');
    rejects('\\\\server\\share\\a.md');
    rejects('file:///etc/passwd');
  });

  it('rejects NUL bytes, control characters and over-long paths', () => {
    rejects('a\u0000b.md');
    rejects('a\nb.md');
    rejects(`${'a'.repeat(1025)}.md`);
  });

  it('rejects dotfile segments (.obsidian, .git, .trash, hidden files) from tool input', () => {
    rejects('.obsidian/app.json');
    rejects('notes/.git/config');
    rejects('.trash/old.md');
    rejects('notes/.hidden.md');
    expect(rejects('.trash/old.md')).toContain('hidden');
  });

  it('allows internal .trash paths only with allowInternal', () => {
    expect(normalizeVaultPath('.trash/notes/a.md', { allowInternal: true })).toBe('.trash/notes/a.md');
    expect(() => normalizeVaultPath('../x', { allowInternal: true })).toThrow(VaultError);
  });

  it('rejects non-string input', () => {
    rejects(undefined);
    rejects(null);
    rejects(42);
    rejects(['a.md']);
  });

  it('applies Unicode NFC normalization so lookups are stable', () => {
    const decomposed = 'cafe\u0301.md';
    expect(normalizeVaultPath(decomposed)).toBe('café.md');
  });
});

describe('helpers', () => {
  it('detects markdown paths and splits dir/base', () => {
    expect(isMarkdownPath('a/b.md')).toBe(true);
    expect(isMarkdownPath('a/b.MD')).toBe(true);
    expect(isMarkdownPath('a/b.canvas')).toBe(false);
    expect(parentDir('a/b/c.md')).toBe('a/b');
    expect(parentDir('c.md')).toBe('');
    expect(baseName('a/b/c.md')).toBe('c.md');
    expect(TRASH_DIR).toBe('.trash');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/storage/path-policy.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement src/storage/path-policy.ts**

```ts
import { VaultError } from './types.ts';

export const TRASH_DIR = '.trash';
const MAX_PATH_CHARS = 1024;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE = /^[a-zA-Z]:/;
const URI_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

export interface PathPolicyOptions {
  allowInternal?: boolean;
}

function reject(reason: string, input: string): never {
  throw new VaultError('INVALID_PATH', `Invalid vault path ${JSON.stringify(input)}: ${reason}.`);
}

/**
 * Normalizes a caller-supplied vault path and rejects anything that could escape
 * the vault or reach hidden/internal files. Returns '' for the vault root.
 */
export function normalizeVaultPath(input: unknown, opts: PathPolicyOptions = {}): string {
  if (typeof input !== 'string') {
    throw new VaultError('INVALID_PATH', 'Path must be a string.');
  }
  const trimmed = input.trim();
  if (trimmed.length > MAX_PATH_CHARS) reject(`longer than ${MAX_PATH_CHARS} characters`, '<too long>');
  if (CONTROL_CHARS.test(trimmed)) reject('contains control characters', trimmed);
  if (URI_SCHEME.test(trimmed)) reject('URIs are not vault paths', trimmed);

  const slashed = trimmed.normalize('NFC').replace(/\\/g, '/');
  if (slashed.startsWith('/')) reject('absolute paths are not allowed', trimmed);
  if (WINDOWS_DRIVE.test(slashed)) reject('absolute paths are not allowed', trimmed);

  const segments: string[] = [];
  for (const raw of slashed.split('/')) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') reject('parent-directory traversal is not allowed', trimmed);
    if (raw.startsWith('.')) {
      const internalOk = opts.allowInternal === true && segments.length === 0 && raw === TRASH_DIR;
      if (!internalOk) reject('hidden files and folders are not accessible', trimmed);
    }
    segments.push(raw);
  }
  return segments.join('/');
}

export function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith('.md');
}

export function parentDir(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

export function baseName(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}
```

- [ ] **Step 4: Run tests, typecheck, lint, commit**

Run: `npx vitest run tests/storage/path-policy.test.ts && npm run typecheck && npm run lint:fix`
Expected: PASS (9 tests).

```bash
git add -A
git commit -m "feat(storage): path policy rejecting traversal, absolute, control-char and dotfile paths"
```

---

### Task 3: Frontmatter split/join/merge with the `yaml` package (+ ADR 0004)

**Files:**
- Create: `src/storage/frontmatter.ts`, `docs/adr/0004-frontmatter-yaml.md`
- Test: `tests/storage/frontmatter.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SplitResult { frontmatter: Record<string, unknown>; body: string; hasFrontmatter: boolean }
  export function splitFrontmatter(text: string): SplitResult          // throws VaultError INVALID_INPUT on bad YAML
  export function joinFrontmatter(frontmatter: Record<string, unknown>, body: string): string
  export function mergeFrontmatter(existing: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown>
  export function applyFrontmatterUpdate(existing: Record<string, unknown>, set?: Record<string, unknown>, unset?: string[]): Record<string, unknown>
  ```

- [ ] **Step 1: Install and write the failing test**

```bash
npm install yaml@^2.9
```

`tests/storage/frontmatter.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  applyFrontmatterUpdate,
  joinFrontmatter,
  mergeFrontmatter,
  splitFrontmatter,
} from '../../src/storage/frontmatter.ts';
import { VaultError } from '../../src/storage/types.ts';

describe('splitFrontmatter', () => {
  it('parses a YAML block and returns the body without it', () => {
    const text = '---\ntitle: Plan\ntags:\n  - a\n  - b\nstatus: active\n---\n# Heading\n\nBody.\n';
    const r = splitFrontmatter(text);
    expect(r.hasFrontmatter).toBe(true);
    expect(r.frontmatter).toEqual({ title: 'Plan', tags: ['a', 'b'], status: 'active' });
    expect(r.body).toBe('# Heading\n\nBody.\n');
  });

  it('treats text without a leading --- as body only', () => {
    const r = splitFrontmatter('# Just a note\n---\nnot frontmatter\n');
    expect(r.hasFrontmatter).toBe(false);
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe('# Just a note\n---\nnot frontmatter\n');
  });

  it('accepts CRLF line endings and an empty block', () => {
    expect(splitFrontmatter('---\r\ntitle: X\r\n---\r\nbody').frontmatter).toEqual({ title: 'X' });
    const empty = splitFrontmatter('---\n---\nbody\n');
    expect(empty.hasFrontmatter).toBe(true);
    expect(empty.frontmatter).toEqual({});
    expect(empty.body).toBe('body\n');
  });

  it('rejects invalid YAML and non-object frontmatter with INVALID_INPUT', () => {
    expect(() => splitFrontmatter('---\ntitle: [unclosed\n---\nbody')).toThrow(VaultError);
    let err: unknown;
    try {
      splitFrontmatter('---\n- just\n- a list\n---\nbody');
    } catch (e) {
      err = e;
    }
    expect((err as VaultError).code).toBe('INVALID_INPUT');
  });

  it('keeps dates as strings rather than JS Date objects', () => {
    const r = splitFrontmatter('---\ncreated: 2026-08-28\n---\n');
    expect(r.frontmatter.created).toBe('2026-08-28');
  });
});

describe('joinFrontmatter', () => {
  it('round-trips preserving key order and omits the block when empty', () => {
    const fm = { title: 'Plan', tags: ['a', 'b'], nested: { k: 1 } };
    const text = joinFrontmatter(fm, 'Body\n');
    expect(text.startsWith('---\ntitle: Plan\ntags:\n  - a\n  - b\nnested:\n  k: 1\n---\nBody\n')).toBe(true);
    expect(splitFrontmatter(text).frontmatter).toEqual(fm);
    expect(joinFrontmatter({}, 'Body\n')).toBe('Body\n');
  });
});

describe('mergeFrontmatter / applyFrontmatterUpdate', () => {
  it('merges shallowly with incoming keys winning and existing order kept', () => {
    const merged = mergeFrontmatter({ a: 1, b: 2, c: 3 }, { b: 20, d: 4 });
    expect(Object.keys(merged)).toEqual(['a', 'b', 'c', 'd']);
    expect(merged).toEqual({ a: 1, b: 20, c: 3, d: 4 });
  });

  it('applies set and unset without touching other keys', () => {
    const out = applyFrontmatterUpdate({ a: 1, b: 2 }, { c: 3, a: 10 }, ['b', 'zzz']);
    expect(out).toEqual({ a: 10, c: 3 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/storage/frontmatter.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement src/storage/frontmatter.ts**

```ts
import { parse, stringify } from 'yaml';
import { VaultError } from './types.ts';

export interface SplitResult {
  frontmatter: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
}

const OPEN = /^---[ \t]*\r?\n/;
const CLOSE = /^---[ \t]*(\r?\n|$)/m;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function splitFrontmatter(text: string): SplitResult {
  const open = OPEN.exec(text);
  if (!open) return { frontmatter: {}, body: text, hasFrontmatter: false };

  const afterOpen = text.slice(open[0].length);
  const close = CLOSE.exec(afterOpen);
  if (!close) return { frontmatter: {}, body: text, hasFrontmatter: false };

  const yamlText = afterOpen.slice(0, close.index);
  const body = afterOpen.slice(close.index + close[0].length);

  let parsed: unknown;
  try {
    // schema 'core' keeps timestamps as strings; yaml's default 'core' does not coerce dates.
    parsed = yamlText.trim() === '' ? {} : parse(yamlText, { schema: 'core' });
  } catch (error) {
    throw new VaultError(
      'INVALID_INPUT',
      `Frontmatter is not valid YAML: ${error instanceof Error ? error.message.split('\n')[0] : 'parse error'}`,
    );
  }
  if (parsed === null || parsed === undefined) parsed = {};
  if (!isPlainObject(parsed)) {
    throw new VaultError('INVALID_INPUT', 'Frontmatter must be a YAML mapping (key: value pairs).');
  }
  return { frontmatter: parsed, body, hasFrontmatter: true };
}

export function joinFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  if (Object.keys(frontmatter).length === 0) return body;
  const yamlText = stringify(frontmatter, { lineWidth: 0 });
  return `---\n${yamlText}---\n${body}`;
}

export function mergeFrontmatter(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  return { ...existing, ...incoming };
}

export function applyFrontmatterUpdate(
  existing: Record<string, unknown>,
  set: Record<string, unknown> = {},
  unset: string[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing, ...set };
  for (const key of unset) delete out[key];
  return out;
}
```

If the `created: 2026-08-28` test fails because `yaml` returns a `Date`, replace `parse(yamlText, { schema: 'core' })` with `parse(yamlText, { schema: 'core', customTags: [] })` and, if still failing, with `parse(yamlText, { schema: 'failsafe' })` plus a post-pass that converts numeric-looking and boolean-looking scalars (`/^-?\d+(\.\d+)?$/`, `true|false`) — document the chosen option in a code comment.

- [ ] **Step 4: Write ADR 0004**

`docs/adr/0004-frontmatter-yaml.md`:
```markdown
# ADR 0004 — Frontmatter via `yaml` package, not gray-matter

Date: 2026-08-28 · Status: accepted

## Context
The spec listed `gray-matter`. It has had no release since 2020, depends on js-yaml 3, and memoizes every parsed string in a process-global cache when called without options — a memory leak for a multi-tenant server.

## Decision
Own 40-line splitter (`---` fences, CRLF tolerant) + `yaml` v2 (`parse`/`stringify`, core schema, dates kept as strings, key order preserved).

## Consequences
Behavior parity with the reference for the common cases; YAML edge cases (anchors, multi-doc) are rejected with INVALID_INPUT instead of silently accepted.
```

- [ ] **Step 5: Run tests, typecheck, lint, commit**

Run: `npx vitest run tests/storage/frontmatter.test.ts && npm run typecheck && npm run lint:fix`
Expected: PASS (8 tests).

```bash
git add -A
git commit -m "feat(storage): frontmatter split/join/merge on yaml v2 (ADR 0004)"
```

---

### Task 4: Exact-text patches and unified diff

**Files:**
- Create: `src/storage/text-diff.ts`
- Test: `tests/storage/text-diff.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function applyTextPatches(content: string, patches: TextPatch[]): { content: string; applied: number }
    // each patch: `find` must occur exactly once in the *current* content; 0 or >1 occurrences -> VaultError INVALID_INPUT naming the patch index and count
  export function unifiedDiff(path: string, before: string, after: string): string   // '' when identical
  ```

- [ ] **Step 1: Install and write the failing test**

```bash
npm install diff@^9
```

`tests/storage/text-diff.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { applyTextPatches, unifiedDiff } from '../../src/storage/text-diff.ts';
import { VaultError } from '../../src/storage/types.ts';

describe('applyTextPatches', () => {
  it('applies ordered patches, later patches seeing earlier results', () => {
    const r = applyTextPatches('alpha beta gamma', [
      { find: 'beta', replace: 'BETA' },
      { find: 'alpha BETA', replace: 'x' },
    ]);
    expect(r).toEqual({ content: 'x gamma', applied: 2 });
  });

  it('rejects a patch whose text is missing, naming the index', () => {
    let err: unknown;
    try {
      applyTextPatches('abc', [{ find: 'zzz', replace: '' }]);
    } catch (e) {
      err = e;
    }
    expect((err as VaultError).code).toBe('INVALID_INPUT');
    expect((err as VaultError).message).toMatch(/patch #1/);
    expect((err as VaultError).message).toMatch(/0 times/);
  });

  it('rejects ambiguous patches (text occurs more than once)', () => {
    expect(() => applyTextPatches('a-a', [{ find: 'a', replace: 'b' }])).toThrow(/2 times/);
  });

  it('rejects empty find strings and empty patch lists', () => {
    expect(() => applyTextPatches('abc', [{ find: '', replace: 'x' }])).toThrow(VaultError);
    expect(() => applyTextPatches('abc', [])).toThrow(VaultError);
  });

  it('supports multi-line exact matches and deletion', () => {
    const r = applyTextPatches('l1\nl2\nl3\n', [{ find: 'l2\n', replace: '' }]);
    expect(r.content).toBe('l1\nl3\n');
  });
});

describe('unifiedDiff', () => {
  it('produces a unified diff with the vault path and no diff for identical text', () => {
    const d = unifiedDiff('notes/a.md', 'one\ntwo\n', 'one\n2\n');
    expect(d).toContain('--- a/notes/a.md');
    expect(d).toContain('+++ b/notes/a.md');
    expect(d).toContain('-two');
    expect(d).toContain('+2');
    expect(unifiedDiff('x.md', 'same\n', 'same\n')).toBe('');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/storage/text-diff.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement src/storage/text-diff.ts**

```ts
import { createTwoFilesPatch } from 'diff';
import { type TextPatch, VaultError } from './types.ts';

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export function applyTextPatches(
  content: string,
  patches: TextPatch[],
): { content: string; applied: number } {
  if (patches.length === 0) {
    throw new VaultError('INVALID_INPUT', 'At least one patch is required.');
  }
  let current = content;
  patches.forEach((patch, i) => {
    if (patch.find.length === 0) {
      throw new VaultError('INVALID_INPUT', `patch #${i + 1}: "find" must not be empty.`);
    }
    const occurrences = countOccurrences(current, patch.find);
    if (occurrences !== 1) {
      throw new VaultError(
        'INVALID_INPUT',
        `patch #${i + 1}: "find" text occurs ${occurrences} times; it must occur exactly once. Include more surrounding context to disambiguate.`,
      );
    }
    current = current.replace(patch.find, () => patch.replace);
  });
  return { content: current, applied: patches.length };
}

export function unifiedDiff(path: string, before: string, after: string): string {
  if (before === after) return '';
  return createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after, undefined, undefined, {
    context: 3,
  });
}
```

If `createTwoFilesPatch`'s 7th parameter is not accepted by `diff@9` typings, drop the options argument (default context is 4 lines) — the test does not assert context size.

- [ ] **Step 4: Run tests, typecheck, lint, commit**

Run: `npx vitest run tests/storage/text-diff.test.ts && npm run typecheck && npm run lint:fix`
Expected: PASS (6 tests).

```bash
git add -A
git commit -m "feat(storage): ordered exact-text patches with unified diff preview"
```

---

### Task 5: LocalFSAdapter — core I/O (read, write, binary, edit, append, batch)

**Files:**
- Create: `src/storage/local-fs.ts`
- Test: `tests/storage/local-fs-core.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces:
  ```ts
  export interface LocalFSOptions { ripgrepPath?: string | null }   // undefined = auto-detect `rg`, null = disable
  export class LocalFSAdapter {                                      // `implements StorageAdapter` is added in Task 6
    static create(rootDir: string, opts?: LocalFSOptions): Promise<LocalFSAdapter>;
    readonly root: string;                                           // realpath of the vault root
    capabilities(): Caps;
    read(path: string): Promise<Note>;
    batchRead(paths: string[]): Promise<BatchReadResult>;
    write(path: string, content: string, opts?: WriteOpts): Promise<void>;
    writeBinary(path: string, bytes: Uint8Array, mime: string): Promise<void>;
    edit(path: string, patches: TextPatch[], dryRun?: boolean): Promise<EditResult>;
    append(path: string, content: string): Promise<void>;
    batchFrontmatterUpdate(updates: FmUpdate[]): Promise<BatchResult>;
  }
  ```
  Behavior contract: invalid YAML frontmatter on **read** degrades to `hasFrontmatter: false, frontmatter: {}` (never blocks reading); invalid YAML in content passed to **write with mergeFrontmatter** is an INVALID_INPUT error.

- [ ] **Step 1: Write the failing test**

`tests/storage/local-fs-core.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES } from '../../src/storage/limits.ts';
import { LocalFSAdapter } from '../../src/storage/local-fs.ts';
import { VaultError } from '../../src/storage/types.ts';

let root: string;
let outside: string;
let vault: LocalFSAdapter;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-vault-'));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-outside-'));
  vault = await LocalFSAdapter.create(root, { ripgrepPath: null });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof VaultError) return e.code;
    throw e;
  }
  throw new Error('expected a VaultError');
}

describe('LocalFSAdapter core', () => {
  it('reports capabilities for the filesystem backend', () => {
    expect(vault.capabilities()).toEqual({
      atomicWrites: true,
      nativeSearch: false,
      watch: true,
      revisions: false,
    });
  });

  it('writes and reads a markdown note with frontmatter, creating parent folders', async () => {
    await vault.write('01-projects/plan.md', '---\ntitle: Plan\ntags: [a]\n---\n# Plan\n');
    const note = await vault.read('01-projects/plan.md');
    expect(note.path).toBe('01-projects/plan.md');
    expect(note.frontmatter).toEqual({ title: 'Plan', tags: ['a'] });
    expect(note.body).toBe('# Plan\n');
    expect(note.hasFrontmatter).toBe(true);
    expect(note.meta.size).toBeGreaterThan(0);
    expect(Date.parse(note.meta.modifiedAt)).not.toBeNaN();
    const leftovers = (await fs.readdir(path.join(root, '01-projects'))).filter((n) => n.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('merges frontmatter on write when requested, incoming keys winning', async () => {
    await vault.write('n.md', '---\na: 1\nb: 2\n---\nold body\n');
    await vault.write('n.md', '---\nb: 20\nc: 3\n---\nnew body\n', { mergeFrontmatter: true });
    const note = await vault.read('n.md');
    expect(note.frontmatter).toEqual({ a: 1, b: 20, c: 3 });
    expect(note.body).toBe('new body\n');
  });

  it('rejects oversized writes and reports NOT_FOUND for missing files', async () => {
    expect(await code(vault.write('big.md', 'x'.repeat(MAX_FILE_BYTES + 1)))).toBe('TOO_LARGE');
    expect(await code(vault.read('nope.md'))).toBe('NOT_FOUND');
    expect(await code(vault.read(''))).toBe('INVALID_PATH');
  });

  it('rejects invalid UTF-8 with ENCODING and degrades invalid YAML to no frontmatter', async () => {
    await fs.writeFile(path.join(root, 'bin.md'), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    expect(await code(vault.read('bin.md'))).toBe('ENCODING');
    await fs.writeFile(path.join(root, 'bad.md'), '---\ntitle: [oops\n---\nbody\n');
    const note = await vault.read('bad.md');
    expect(note.hasFrontmatter).toBe(false);
    expect(note.frontmatter).toEqual({});
    expect(note.body).toBe('---\ntitle: [oops\n---\nbody\n');
  });

  it('blocks symlink escapes out of the vault root', async () => {
    await fs.writeFile(path.join(outside, 'secret.md'), 'top secret');
    await fs.symlink(outside, path.join(root, 'link'));
    expect(await code(vault.read('link/secret.md'))).toBe('INVALID_PATH');
    expect(await code(vault.write('link/new.md', 'x'))).toBe('INVALID_PATH');
  });

  it('writes allowlisted binaries and rejects others or mismatched extensions', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await vault.writeBinary('img/a.png', png, 'image/png');
    expect(await fs.readFile(path.join(root, 'img/a.png'))).toEqual(Buffer.from(png));
    expect(await code(vault.writeBinary('img/a.jpg', png, 'image/png'))).toBe('INVALID_INPUT');
    expect(await code(vault.writeBinary('a.exe', png, 'application/x-msdownload'))).toBe('INVALID_INPUT');
    expect(await code(vault.writeBinary('big.png', new Uint8Array(MAX_FILE_BYTES + 1), 'image/png'))).toBe(
      'TOO_LARGE',
    );
  });

  it('edits with dry-run (no write) and for real (write), returning a diff', async () => {
    await vault.write('e.md', 'alpha\nbeta\n');
    const dry = await vault.edit('e.md', [{ find: 'beta', replace: 'BETA' }], true);
    expect(dry).toMatchObject({ path: 'e.md', applied: 1, dryRun: true });
    expect(dry.diff).toContain('-beta');
    expect(dry.diff).toContain('+BETA');
    expect((await vault.read('e.md')).content).toBe('alpha\nbeta\n');
    const real = await vault.edit('e.md', [{ find: 'beta', replace: 'BETA' }]);
    expect(real.dryRun).toBe(false);
    expect((await vault.read('e.md')).content).toBe('alpha\nBETA\n');
    expect(await code(vault.edit('e.md', [{ find: 'zzz', replace: '' }]))).toBe('INVALID_INPUT');
  });

  it('appends with newline handling and creates the file when missing', async () => {
    await vault.append('log.md', 'first');
    await vault.append('log.md', 'second');
    await vault.append('log.md', 'third\n');
    expect((await vault.read('log.md')).content).toBe('first\nsecond\nthird\n');
  });

  it('batch-reads reporting missing and failed files separately', async () => {
    await vault.write('a.md', 'A');
    await fs.writeFile(path.join(root, 'bad.md'), Buffer.from([0xff, 0xfe]));
    const r = await vault.batchRead(['a.md', 'missing.md', 'bad.md']);
    expect(r.notes.map((n) => n.path)).toEqual(['a.md']);
    expect(r.missing).toEqual(['missing.md']);
    expect(r.failed).toEqual([{ path: 'bad.md', error: expect.stringContaining('UTF-8') }]);
    expect(await code(vault.batchRead([]))).toBe('INVALID_INPUT');
    expect(await code(vault.batchRead(new Array(21).fill('a.md')))).toBe('INVALID_INPUT');
  });

  it('batch-updates frontmatter without touching bodies', async () => {
    await vault.write('x.md', '---\nstatus: draft\nkeep: 1\n---\nBody\n');
    await vault.write('y.md', 'No frontmatter body\n');
    const r = await vault.batchFrontmatterUpdate([
      { path: 'x.md', set: { status: 'done' }, unset: ['keep'] },
      { path: 'y.md', set: { type: 'note' } },
      { path: 'missing.md', set: { a: 1 } },
    ]);
    expect(r.updated).toEqual(['x.md', 'y.md']);
    expect(r.failed).toEqual([{ path: 'missing.md', error: expect.stringContaining('missing.md') }]);
    expect(await vault.read('x.md')).toMatchObject({ frontmatter: { status: 'done' }, body: 'Body\n' });
    expect(await vault.read('y.md')).toMatchObject({
      frontmatter: { type: 'note' },
      body: 'No frontmatter body\n',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/storage/local-fs-core.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement src/storage/local-fs.ts (core part)**

```ts
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { type Stats, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  applyFrontmatterUpdate,
  joinFrontmatter,
  mergeFrontmatter,
  splitFrontmatter,
} from './frontmatter.ts';
import { BINARY_MIME_ALLOWLIST, assertBatchSize, assertWithinSize, extensionAllowedFor } from './limits.ts';
import { isMarkdownPath, normalizeVaultPath } from './path-policy.ts';
import { applyTextPatches, unifiedDiff } from './text-diff.ts';
import {
  type BatchReadResult,
  type BatchResult,
  type Caps,
  type EditResult,
  type FmUpdate,
  type Note,
  type TextPatch,
  VaultError,
  type WriteOpts,
} from './types.ts';

const execFileAsync = promisify(execFile);
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

export interface LocalFSOptions {
  ripgrepPath?: string | null;
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
  if (p === '') throw new VaultError('INVALID_PATH', 'A file path is required (got the vault root).');
  return p;
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}

export class LocalFSAdapter {
  readonly root: string;
  private readonly rg: string | null;

  private constructor(root: string, rg: string | null) {
    this.root = root;
    this.rg = rg;
  }

  static async create(rootDir: string, opts: LocalFSOptions = {}): Promise<LocalFSAdapter> {
    await fs.mkdir(rootDir, { recursive: true });
    const root = await fs.realpath(rootDir);
    const rg = opts.ripgrepPath === undefined ? await detectRipgrep() : opts.ripgrepPath;
    return new LocalFSAdapter(root, rg);
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

  /** Resolves symlinks of the deepest existing ancestor and asserts it stays inside the vault root. */
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
          result.failed.push({ path: String(raw), error: error.message });
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
      finalContent = joinFrontmatter(mergeFrontmatter(existingFm, incoming.frontmatter), incoming.body);
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
      throw new VaultError('INVALID_INPUT', `File extension of ${p} does not match media type ${mime}.`);
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
    const next = `${existing}${separator}${content}`;
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
          result.failed.push({ path: String(update.path), error: error.message });
        } else {
          throw error;
        }
      }
    }
    return result;
  }
}
```

- [ ] **Step 4: Run tests, typecheck, lint, commit**

Run: `npx vitest run tests/storage/local-fs-core.test.ts && npm run typecheck && npm run lint:fix`
Expected: PASS (11 tests). If Biome flags the `for (;;)` loop or the unused `execFileAsync` (used in Task 6), keep them — add `// biome-ignore lint/...` only with the exact rule name Biome prints.

```bash
git add -A
git commit -m "feat(storage): LocalFSAdapter core I/O with atomic writes, symlink guard and batch ops"
```

---

### Task 6: LocalFSAdapter — list, move, soft delete, search (ripgrep + JS fallback), watch

**Files:**
- Modify: `src/storage/local-fs.ts` (add methods; declare `implements StorageAdapter`)
- Test: `tests/storage/local-fs-nav.test.ts`

**Interfaces:**
- Produces the remaining `StorageAdapter` methods:
  - `list(prefix, opts)`: `depth` default 1 (`Number.POSITIVE_INFINITY` allowed); `glob` is matched against the path **relative to `prefix`** with picomatch (`**/*.md`, `*.canvas`); dot entries never listed; entries sorted by name, dirs and files interleaved in readdir order per level.
  - `move(from, to)`: files or folders; `ALREADY_EXISTS` if destination exists; creates destination parents.
  - `softDelete(path, confirm)`: `CONFIRM_REQUIRED` unless `confirm === true`; moves to `.trash/<same relative path>`; if that exists, suffixes `.<ISO timestamp>` before the extension.
  - `search(query, opts)`: **literal substring** search (not regex); ripgrep when available, JS fallback otherwise; skips dot dirs/files and non-text extensions; `limit ≤ 50`; results ordered by path then line.
  - `watch(onChange)`: chokidar, `ignoreInitial`, dot paths ignored, `create/update/delete` events with vault-relative paths; returns an unsubscribe function.

- [ ] **Step 1: Install and write the failing test**

```bash
npm install picomatch@^4 chokidar@^5
npm install --save-dev @types/picomatch
```

`tests/storage/local-fs-nav.test.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFSAdapter } from '../../src/storage/local-fs.ts';
import type { ChangeEvent, StorageAdapter } from '../../src/storage/types.ts';
import { VaultError } from '../../src/storage/types.ts';

let root: string;
let vault: LocalFSAdapter;

function hasRipgrep(): boolean {
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function seed(): Promise<void> {
  await vault.write('00-inbox/todo.md', '---\ntype: task\n---\nBuy milk\n');
  await vault.write('01-projects/brainstem/plan.md', '---\ntype: project\n---\nShip the MCP server\n');
  await vault.write('01-projects/brainstem/notes.md', 'meeting notes about milk and MCP\n');
  await vault.write('02-areas/health.md', 'Drink Milk daily\n');
  await vault.write('board.canvas', '{"nodes":[],"edges":[]}');
  await fs.mkdir(path.join(root, '.obsidian'), { recursive: true });
  await fs.writeFile(path.join(root, '.obsidian/app.json'), '{"milk":true}');
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof VaultError) return e.code;
    throw e;
  }
  throw new Error('expected a VaultError');
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-nav-'));
  vault = await LocalFSAdapter.create(root, { ripgrepPath: null });
  await seed();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('list', () => {
  it('lists one level by default, never dot entries, with file metadata', async () => {
    const entries = await vault.list('');
    expect(entries.map((e) => `${e.kind}:${e.path}`)).toEqual([
      'dir:00-inbox',
      'dir:01-projects',
      'dir:02-areas',
      'file:board.canvas',
    ]);
    const canvas = entries.find((e) => e.path === 'board.canvas');
    expect(canvas?.size).toBeGreaterThan(0);
    expect(canvas?.modifiedAt).toBeDefined();
  });

  it('recurses with depth and filters with a glob relative to the prefix', async () => {
    const all = await vault.list('', { depth: Number.POSITIVE_INFINITY, includeDirs: false });
    expect(all.map((e) => e.path)).toEqual([
      '00-inbox/todo.md',
      '01-projects/brainstem/notes.md',
      '01-projects/brainstem/plan.md',
      '02-areas/health.md',
      'board.canvas',
    ]);
    const md = await vault.list('01-projects', { depth: 5, glob: '**/*.md', includeDirs: false });
    expect(md.map((e) => e.path)).toEqual(['01-projects/brainstem/notes.md', '01-projects/brainstem/plan.md']);
    const dirsOnly = await vault.list('', { includeFiles: false });
    expect(dirsOnly.every((e) => e.kind === 'dir')).toBe(true);
  });

  it('rejects listing a file or a missing folder', async () => {
    expect(await code(vault.list('board.canvas'))).toBe('INVALID_INPUT');
    expect(await code(vault.list('nope'))).toBe('NOT_FOUND');
    expect(await code(vault.list('.obsidian'))).toBe('INVALID_PATH');
  });
});

describe('move', () => {
  it('moves files and folders, creating parents, refusing to overwrite', async () => {
    await vault.move('00-inbox/todo.md', '04-archive/2026/todo.md');
    expect((await vault.read('04-archive/2026/todo.md')).body).toBe('Buy milk\n');
    expect(await code(vault.read('00-inbox/todo.md'))).toBe('NOT_FOUND');
    await vault.move('01-projects/brainstem', '01-projects/brainstem-mcp');
    expect((await vault.read('01-projects/brainstem-mcp/plan.md')).frontmatter).toEqual({ type: 'project' });
    expect(await code(vault.move('02-areas/health.md', 'board.canvas'))).toBe('ALREADY_EXISTS');
    expect(await code(vault.move('missing.md', 'x.md'))).toBe('NOT_FOUND');
    expect(await code(vault.move('02-areas/health.md', '.trash/h.md'))).toBe('INVALID_PATH');
  });
});

describe('softDelete', () => {
  it('requires confirm=true and moves into .trash keeping the relative path', async () => {
    expect(await code(vault.softDelete('02-areas/health.md', false))).toBe('CONFIRM_REQUIRED');
    await vault.softDelete('02-areas/health.md', true);
    expect(await code(vault.read('02-areas/health.md'))).toBe('NOT_FOUND');
    expect(await fs.readFile(path.join(root, '.trash/02-areas/health.md'), 'utf8')).toBe('Drink Milk daily\n');
    // trash is unreachable through the public API
    expect(await code(vault.read('.trash/02-areas/health.md'))).toBe('INVALID_PATH');
    expect((await vault.list('', { depth: 9 })).some((e) => e.path.startsWith('.trash'))).toBe(false);
  });

  it('does not overwrite an earlier trashed file with the same path', async () => {
    await vault.softDelete('02-areas/health.md', true);
    await vault.write('02-areas/health.md', 'second version\n');
    await vault.softDelete('02-areas/health.md', true);
    const trashed = await fs.readdir(path.join(root, '.trash/02-areas'));
    expect(trashed).toHaveLength(2);
    expect(trashed).toContain('health.md');
    expect(trashed.some((n) => /^health\..+\.md$/.test(n))).toBe(true);
  });
});

describe('search (JS fallback)', () => {
  it('finds literal substrings case-insensitively by default, skipping dot files, honoring limit and prefix', async () => {
    const all = await vault.search('milk');
    expect(all.map((m) => `${m.path}:${m.line}`)).toEqual([
      '00-inbox/todo.md:4',
      '01-projects/brainstem/notes.md:1',
      '02-areas/health.md:1',
    ]);
    expect(all[0]?.text).toBe('Buy milk');
    const sensitive = await vault.search('Milk', { caseSensitive: true });
    expect(sensitive.map((m) => m.path)).toEqual(['02-areas/health.md']);
    const limited = await vault.search('milk', { limit: 2 });
    expect(limited).toHaveLength(2);
    const scoped = await vault.search('milk', { pathPrefix: '01-projects' });
    expect(scoped.map((m) => m.path)).toEqual(['01-projects/brainstem/notes.md']);
    expect(await code(vault.search('   '))).toBe('INVALID_INPUT');
  });

  it('treats the query literally, not as a regex', async () => {
    await vault.write('re.md', 'a.c\nabc\n');
    const r = await vault.search('a.c');
    expect(r.map((m) => `${m.path}:${m.line}`)).toEqual(['re.md:1']);
  });
});

describe.skipIf(!hasRipgrep())('search (ripgrep)', () => {
  it('returns the same results as the JS fallback', async () => {
    const rgVault = await LocalFSAdapter.create(root);
    expect(rgVault.capabilities().nativeSearch).toBe(true);
    const viaRg = await rgVault.search('milk');
    const viaJs = await vault.search('milk');
    expect(viaRg).toEqual(viaJs);
  });
});

describe('watch', () => {
  it('emits create/update/delete events with vault-relative paths', async () => {
    const adapter: StorageAdapter = vault;
    const events: ChangeEvent[] = [];
    const unsubscribe = adapter.watch?.((e) => events.push(e));
    expect(unsubscribe).toBeTypeOf('function');
    await new Promise((r) => setTimeout(r, 300)); // let chokidar finish its initial scan
    await vault.write('watched/new.md', 'v1');
    await vault.write('watched/new.md', 'v2');
    await fs.rm(path.join(root, 'watched/new.md'));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !events.some((e) => e.type === 'delete')) {
      await new Promise((r) => setTimeout(r, 50));
    }
    unsubscribe?.();
    const types = events.filter((e) => e.path === 'watched/new.md').map((e) => e.type);
    expect(types[0]).toBe('create');
    expect(types.at(-1)).toBe('delete');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/storage/local-fs-nav.test.ts`
Expected: FAIL — `vault.list is not a function`.

- [ ] **Step 3: Add the methods to src/storage/local-fs.ts**

Add imports at the top of the file:
```ts
import { watch as chokidarWatch } from 'chokidar';
import picomatch from 'picomatch';
import { TRASH_DIR, baseName, parentDir } from './path-policy.ts';
import { MAX_SEARCH_RESULTS } from './limits.ts';
import type { ChangeEvent, Entry, ListOpts, Match, SearchOpts, StorageAdapter, Unsubscribe } from './types.ts';
```
(merge with the existing import lines from `./path-policy.ts`, `./limits.ts`, `./types.ts` — one import statement per module.)

Change the class declaration to `export class LocalFSAdapter implements StorageAdapter {` and add:

```ts
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
    if (!baseStat.isDirectory()) throw new VaultError('INVALID_INPUT', `${base} is a file, not a folder.`);

    const out: Entry[] = [];
    const walk = async (dir: string, level: number): Promise<void> => {
      const dirents = await fs.readdir(this.abs(dir), { withFileTypes: true });
      dirents.sort((a, b) => a.name.localeCompare(b.name, 'en'));
      for (const dirent of dirents) {
        if (dirent.name.startsWith('.')) continue;
        const rel = dir === '' ? dirent.name : `${dir}/${dirent.name}`;
        const relToBase = base === '' ? rel : rel.slice(base.length + 1);
        const matches = matcher === null || matcher(relToBase);
        if (dirent.isDirectory()) {
          if (includeDirs && matches) out.push({ path: rel, kind: 'dir' });
          if (level < depth) await walk(rel, level + 1);
        } else if (dirent.isFile() && includeFiles && matches) {
          const stat = await fs.stat(this.abs(rel));
          out.push({ path: rel, kind: 'file', size: stat.size, modifiedAt: stat.mtime.toISOString() });
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
    if (!(await this.statOrNull(fromAbs))) throw new VaultError('NOT_FOUND', `${from} does not exist.`);
    if (await this.statOrNull(toAbs)) throw new VaultError('ALREADY_EXISTS', `${to} already exists.`);
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
    if (!(await this.statOrNull(fromAbs))) throw new VaultError('NOT_FOUND', `${p} does not exist.`);

    let target = normalizeVaultPath(`${TRASH_DIR}/${p}`, { allowInternal: true });
    if (await this.statOrNull(this.abs(target))) {
      const name = baseName(p);
      const dot = name.lastIndexOf('.');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const stamped = dot > 0 ? `${name.slice(0, dot)}.${stamp}${name.slice(dot)}` : `${name}.${stamp}`;
      const dir = parentDir(p);
      target = normalizeVaultPath(`${TRASH_DIR}/${dir === '' ? stamped : `${dir}/${stamped}`}`, {
        allowInternal: true,
      });
    }
    const toAbs = this.abs(target);
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
    const matches = this.rg
      ? await this.searchRipgrep(query, prefix, limit, caseSensitive)
      : await this.searchJs(query, prefix, limit, caseSensitive);
    return matches.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
  }

  private static readonly TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.canvas', '.json', '.csv']);

  private async searchJs(query: string, prefix: string, limit: number, caseSensitive: boolean): Promise<Match[]> {
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
        if (haystack.includes(needle)) out.push({ path: file.path, line: i + 1, text: line.trimEnd() });
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  private async searchRipgrep(query: string, prefix: string, limit: number, caseSensitive: boolean): Promise<Match[]> {
    if (!this.rg) return [];
    const args = [
      '--json',
      '--fixed-strings',
      '--no-messages',
      caseSensitive ? '--case-sensitive' : '--ignore-case',
      '--glob',
      '!.*',
      '--glob',
      '!**/.*/**',
      ...[...LocalFSAdapter.TEXT_EXTENSIONS].flatMap((ext) => ['--glob', `*${ext}`]),
      '--',
      query,
      this.abs(prefix),
    ];
    let stdout = '';
    try {
      ({ stdout } = await execFileAsync(this.rg, args, { maxBuffer: 16 * 1024 * 1024 }));
    } catch (error) {
      const e = error as { code?: number; stdout?: string };
      if (e.code === 1) return []; // ripgrep: no matches
      throw new VaultError('IO', 'Search failed.');
    }
    const out: Match[] = [];
    for (const line of stdout.split('\n')) {
      if (out.length >= limit || line === '') continue;
      const event = JSON.parse(line) as {
        type: string;
        data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
      };
      if (event.type !== 'match' || !event.data?.path?.text) continue;
      out.push({
        path: this.rel(event.data.path.text),
        line: event.data.line_number ?? 0,
        text: (event.data.lines?.text ?? '').replace(/\r?\n$/, ''),
      });
    }
    return out;
  }

  // ---- watch ---------------------------------------------------------------

  watch(onChange: (event: ChangeEvent) => void): Unsubscribe {
    const watcher = chokidarWatch(this.root, {
      ignoreInitial: true,
      ignored: (absPath: string) => absPath !== this.root && path.basename(absPath).startsWith('.'),
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
    });
    watcher.on('add', (abs) => onChange({ type: 'create', path: this.rel(abs) }));
    watcher.on('change', (abs) => onChange({ type: 'update', path: this.rel(abs) }));
    watcher.on('unlink', (abs) => onChange({ type: 'delete', path: this.rel(abs) }));
    return () => {
      void watcher.close();
    };
  }
```

- [ ] **Step 4: Run tests, typecheck, lint, commit**

Run: `npx vitest run tests/storage/ && npm run typecheck && npm run lint:fix`
Expected: PASS — all storage suites (the ripgrep suite is skipped when `rg` is absent; install `ripgrep` locally to run it once).

```bash
git add -A
git commit -m "feat(storage): LocalFSAdapter list/move/soft-delete/search/watch completing StorageAdapter"
```

---

### Task 7: Frontmatter index (rebuildable cache with query and watch attachment)

**Files:**
- Create: `src/vault/frontmatter-index.ts`
- Test: `tests/vault/frontmatter-index.test.ts`

**Interfaces:**
- Consumes: `StorageAdapter`, `Note`, `Unsubscribe` (Task 1), `LocalFSAdapter` (tests only).
- Produces:
  ```ts
  export interface IndexEntry { path: string; frontmatter: Record<string, unknown>; hasFrontmatter: boolean; size: number; modifiedAt: string }
  export interface FrontmatterQuery { field: string; equals?: unknown; contains?: string; exists?: boolean }  // criteria AND-ed; field supports dot paths
  export interface FrontmatterHit { path: string; value: unknown }
  export class FrontmatterIndex {
    static build(adapter: StorageAdapter): Promise<FrontmatterIndex>;   // lists **/*.md, batch-reads in chunks of 20
    static fromNote(note: Note): IndexEntry;
    readonly builtAt: Date;
    upsert(entry: IndexEntry): void;
    remove(path: string): void;
    rename(from: string, to: string): void;
    get(path: string): IndexEntry | undefined;
    all(): IndexEntry[];                     // sorted by path
    size(): number;
    byteSize(): number;                      // approximate memory footprint (sum of JSON lengths)
    query(q: FrontmatterQuery): FrontmatterHit[];   // sorted by path
    refreshPath(adapter: StorageAdapter, path: string): Promise<void>;   // re-read one file; removes on NOT_FOUND
    attach(adapter: StorageAdapter): Unsubscribe;   // uses adapter.watch when capabilities().watch, else no-op
  }
  ```

- [ ] **Step 1: Write the failing test**

`tests/vault/frontmatter-index.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFSAdapter } from '../../src/storage/local-fs.ts';
import { FrontmatterIndex } from '../../src/vault/frontmatter-index.ts';

let root: string;
let vault: LocalFSAdapter;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-index-'));
  vault = await LocalFSAdapter.create(root, { ripgrepPath: null });
  await vault.write('a.md', '---\ntype: project\nstatus: active\ntags: [mcp, Notes]\nmeta:\n  owner: vanea\n---\nA');
  await vault.write('sub/b.md', '---\ntype: area\nstatus: active\ntags: [health]\n---\nB');
  await vault.write('sub/c.md', 'no frontmatter');
  await vault.write('d.canvas', '{"nodes":[],"edges":[]}');
  for (let i = 0; i < 25; i += 1) await vault.write(`bulk/n${i}.md`, `---\nn: ${i}\n---\n`);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('FrontmatterIndex.build', () => {
  it('indexes every markdown file (batching past 20) and ignores non-markdown', async () => {
    const index = await FrontmatterIndex.build(vault);
    expect(index.size()).toBe(28);
    expect(index.get('d.canvas')).toBeUndefined();
    expect(index.get('sub/c.md')).toMatchObject({ hasFrontmatter: false, frontmatter: {} });
    expect(index.get('a.md')?.frontmatter).toMatchObject({ type: 'project' });
    expect(index.byteSize()).toBeGreaterThan(0);
    expect(index.builtAt).toBeInstanceOf(Date);
  });
});

describe('query', () => {
  it('supports equals, contains, exists, array membership and dot paths', async () => {
    const index = await FrontmatterIndex.build(vault);
    expect(index.query({ field: 'type', equals: 'project' }).map((h) => h.path)).toEqual(['a.md']);
    expect(index.query({ field: 'status', equals: 'active' }).map((h) => h.path)).toEqual(['a.md', 'sub/b.md']);
    expect(index.query({ field: 'tags', equals: 'mcp' }).map((h) => h.path)).toEqual(['a.md']);
    expect(index.query({ field: 'tags', contains: 'note' }).map((h) => h.path)).toEqual(['a.md']);
    expect(index.query({ field: 'meta.owner', equals: 'vanea' }).map((h) => h.path)).toEqual(['a.md']);
    expect(index.query({ field: 'type', exists: true }).map((h) => h.path)).toEqual(['a.md', 'sub/b.md']);
    expect(index.query({ field: 'type', exists: false })).toHaveLength(26);
    expect(index.query({ field: 'n', equals: 7 }).map((h) => h.path)).toEqual(['bulk/n7.md']);
    const hit = index.query({ field: 'tags', equals: 'health' })[0];
    expect(hit).toEqual({ path: 'sub/b.md', value: ['health'] });
  });

  it('ANDs multiple criteria', async () => {
    const index = await FrontmatterIndex.build(vault);
    expect(
      index.query({ field: 'status', equals: 'active', contains: 'act', exists: true }).map((h) => h.path),
    ).toEqual(['a.md', 'sub/b.md']);
  });
});

describe('mutation helpers', () => {
  it('upsert/remove/rename/refreshPath keep the index consistent', async () => {
    const index = await FrontmatterIndex.build(vault);
    index.remove('a.md');
    expect(index.get('a.md')).toBeUndefined();
    await index.refreshPath(vault, 'a.md');
    expect(index.get('a.md')?.frontmatter).toMatchObject({ type: 'project' });
    index.rename('a.md', 'moved/a.md');
    expect(index.get('a.md')).toBeUndefined();
    expect(index.get('moved/a.md')?.path).toBe('moved/a.md');
    await index.refreshPath(vault, 'moved/a.md'); // file does not exist on disk -> removed
    expect(index.get('moved/a.md')).toBeUndefined();
  });
});

describe('attach', () => {
  it('follows filesystem changes through the adapter watcher', async () => {
    const index = await FrontmatterIndex.build(vault);
    const detach = index.attach(vault);
    await new Promise((r) => setTimeout(r, 300));
    await vault.write('live.md', '---\ntype: live\n---\n');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !index.get('live.md')) await new Promise((r) => setTimeout(r, 50));
    expect(index.get('live.md')?.frontmatter).toEqual({ type: 'live' });
    await fs.rm(path.join(root, 'live.md'));
    const deadline2 = Date.now() + 5000;
    while (Date.now() < deadline2 && index.get('live.md')) await new Promise((r) => setTimeout(r, 50));
    expect(index.get('live.md')).toBeUndefined();
    detach();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/vault/frontmatter-index.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement src/vault/frontmatter-index.ts**

```ts
import { MAX_BATCH } from '../storage/limits.ts';
import { isMarkdownPath } from '../storage/path-policy.ts';
import { type Note, type StorageAdapter, type Unsubscribe, VaultError } from '../storage/types.ts';

export interface IndexEntry {
  path: string;
  frontmatter: Record<string, unknown>;
  hasFrontmatter: boolean;
  size: number;
  modifiedAt: string;
}

export interface FrontmatterQuery {
  field: string;
  equals?: unknown;
  contains?: string;
  exists?: boolean;
}

export interface FrontmatterHit {
  path: string;
  value: unknown;
}

function getPath(obj: Record<string, unknown>, dotted: string): unknown {
  let current: unknown = obj;
  for (const key of dotted.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a !== 'object' || a === null) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

function matchesEquals(value: unknown, wanted: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => sameValue(item, wanted));
  return sameValue(value, wanted);
}

function matchesContains(value: unknown, needle: string): boolean {
  const n = needle.toLowerCase();
  if (typeof value === 'string') return value.toLowerCase().includes(n);
  if (Array.isArray(value)) return value.some((item) => typeof item === 'string' && item.toLowerCase().includes(n));
  return false;
}

export class FrontmatterIndex {
  readonly builtAt: Date;
  private readonly entries = new Map<string, IndexEntry>();
  private bytes = 0;

  private constructor() {
    this.builtAt = new Date();
  }

  static fromNote(note: Note): IndexEntry {
    return {
      path: note.path,
      frontmatter: note.frontmatter,
      hasFrontmatter: note.hasFrontmatter,
      size: note.meta.size,
      modifiedAt: note.meta.modifiedAt,
    };
  }

  static async build(adapter: StorageAdapter): Promise<FrontmatterIndex> {
    const index = new FrontmatterIndex();
    const files = await adapter.list('', { depth: Number.POSITIVE_INFINITY, includeDirs: false });
    const mdPaths = files.map((f) => f.path).filter(isMarkdownPath);
    for (let i = 0; i < mdPaths.length; i += MAX_BATCH) {
      const chunk = mdPaths.slice(i, i + MAX_BATCH);
      const { notes } = await adapter.batchRead(chunk);
      for (const note of notes) index.upsert(FrontmatterIndex.fromNote(note));
    }
    return index;
  }

  upsert(entry: IndexEntry): void {
    this.remove(entry.path);
    this.entries.set(entry.path, entry);
    this.bytes += JSON.stringify(entry).length;
  }

  remove(path: string): void {
    const existing = this.entries.get(path);
    if (!existing) return;
    this.bytes -= JSON.stringify(existing).length;
    this.entries.delete(path);
  }

  rename(from: string, to: string): void {
    const existing = this.entries.get(from);
    if (!existing) return;
    this.remove(from);
    this.upsert({ ...existing, path: to });
  }

  get(path: string): IndexEntry | undefined {
    return this.entries.get(path);
  }

  all(): IndexEntry[] {
    return [...this.entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  size(): number {
    return this.entries.size;
  }

  byteSize(): number {
    return this.bytes;
  }

  query(q: FrontmatterQuery): FrontmatterHit[] {
    const hits: FrontmatterHit[] = [];
    for (const entry of this.all()) {
      const value = getPath(entry.frontmatter, q.field);
      if (q.exists === true && value === undefined) continue;
      if (q.exists === false && value !== undefined) continue;
      if (q.equals !== undefined && !matchesEquals(value, q.equals)) continue;
      if (q.contains !== undefined && !matchesContains(value, q.contains)) continue;
      if (q.exists === undefined && q.equals === undefined && q.contains === undefined && value === undefined) continue;
      hits.push({ path: entry.path, value });
    }
    return hits;
  }

  async refreshPath(adapter: StorageAdapter, path: string): Promise<void> {
    if (!isMarkdownPath(path)) return;
    try {
      this.upsert(FrontmatterIndex.fromNote(await adapter.read(path)));
    } catch (error) {
      if (error instanceof VaultError && (error.code === 'NOT_FOUND' || error.code === 'ENCODING')) {
        this.remove(path);
        return;
      }
      throw error;
    }
  }

  attach(adapter: StorageAdapter): Unsubscribe {
    if (!adapter.capabilities().watch || !adapter.watch) return () => {};
    return adapter.watch((event) => {
      if (!isMarkdownPath(event.path)) return;
      if (event.type === 'delete') {
        this.remove(event.path);
        return;
      }
      void this.refreshPath(adapter, event.path).catch(() => {
        /* a transient read failure leaves the previous entry in place; the next event or TTL rebuild fixes it */
      });
    });
  }
}
```

- [ ] **Step 4: Run tests, typecheck, lint, commit**

Run: `npx vitest run tests/vault/frontmatter-index.test.ts && npm run typecheck && npm run lint:fix`
Expected: PASS (5 tests).

```bash
git add -A
git commit -m "feat(vault): frontmatter index with dot-path queries, incremental refresh and watch attachment"
```

---

### Task 8: Daily notes (timezone-aware paths, strftime compatibility, templates)

**Files:**
- Create: `src/vault/daily-notes.ts`
- Test: `tests/vault/daily-notes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DailyNoteSettings { folder: string; format: string; template: string | null; timezone: string }
  export const DEFAULT_DAILY_NOTE_SETTINGS: DailyNoteSettings;   // { folder: '', format: 'yyyy-MM-dd', template: null, timezone: 'UTC' }
  export function toDateFnsFormat(format: string): string;         // strftime (%Y-%m-%d) -> date-fns tokens; passthrough otherwise
  export function resolveDailyNotePath(settings: DailyNoteSettings, date: Date): string;   // '<folder>/<formatted>.md', path-policy normalized
  export function renderDailyTemplate(template: string, date: Date, settings: DailyNoteSettings): string;  // {{date}}, {{date:FORMAT}}, {{title}}
  export function parseDateArg(input: string | undefined, now: Date, timezone: string): Date;  // undefined -> now; 'YYYY-MM-DD' -> that calendar day at 12:00 in timezone; else VaultError INVALID_INPUT
  ```

- [ ] **Step 1: Install and write the failing test**

```bash
npm install date-fns@^4.4 @date-fns/tz@^1.5
```

`tests/vault/daily-notes.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { VaultError } from '../../src/storage/types.ts';
import {
  DEFAULT_DAILY_NOTE_SETTINGS,
  parseDateArg,
  renderDailyTemplate,
  resolveDailyNotePath,
  toDateFnsFormat,
} from '../../src/vault/daily-notes.ts';

// 2026-08-28T23:30:00Z is already 2026-08-29 in Europe/Chisinau (UTC+3) and still 2026-08-28 in UTC.
const lateUtc = new Date('2026-08-28T23:30:00Z');

describe('toDateFnsFormat', () => {
  it('translates strftime tokens and passes date-fns formats through', () => {
    expect(toDateFnsFormat('%Y-%m-%d')).toBe('yyyy-MM-dd');
    expect(toDateFnsFormat('%Y/%m/%B %A %H:%M:%S %j %y %b %a')).toBe('yyyy/MM/MMMM EEEE HH:mm:ss DDD yy MMM EEE');
    expect(toDateFnsFormat('yyyy-MM-dd')).toBe('yyyy-MM-dd');
    expect(toDateFnsFormat("yyyy-'W'II")).toBe("yyyy-'W'II");
  });
});

describe('resolveDailyNotePath', () => {
  it('uses the vault timezone, folder and format', () => {
    expect(resolveDailyNotePath(DEFAULT_DAILY_NOTE_SETTINGS, lateUtc)).toBe('2026-08-28.md');
    expect(
      resolveDailyNotePath({ ...DEFAULT_DAILY_NOTE_SETTINGS, timezone: 'Europe/Chisinau' }, lateUtc),
    ).toBe('2026-08-29.md');
    expect(
      resolveDailyNotePath(
        { folder: 'journal/daily/', format: '%Y/%m/%Y-%m-%d', template: null, timezone: 'UTC' },
        lateUtc,
      ),
    ).toBe('journal/daily/2026/08/2026-08-28.md');
  });

  it('rejects folders or formats that would escape the vault', () => {
    expect(() =>
      resolveDailyNotePath({ ...DEFAULT_DAILY_NOTE_SETTINGS, folder: '../outside' }, lateUtc),
    ).toThrow(VaultError);
  });
});

describe('renderDailyTemplate', () => {
  it('expands {{date}}, {{date:FORMAT}} and {{title}} in the vault timezone', () => {
    const settings = { ...DEFAULT_DAILY_NOTE_SETTINGS, timezone: 'Europe/Chisinau' };
    const out = renderDailyTemplate(
      '# {{title}}\n\nCreated {{date:EEEE, d MMMM yyyy}} ({{date}})\n\n## Log\n',
      lateUtc,
      settings,
    );
    expect(out).toBe('# 2026-08-29\n\nCreated Saturday, 29 August 2026 (2026-08-29)\n\n## Log\n');
  });
});

describe('parseDateArg', () => {
  it('defaults to now, accepts YYYY-MM-DD as a calendar day in the timezone, rejects garbage', () => {
    expect(parseDateArg(undefined, lateUtc, 'UTC')).toBe(lateUtc);
    const d = parseDateArg('2026-01-05', lateUtc, 'Europe/Chisinau');
    expect(resolveDailyNotePath({ ...DEFAULT_DAILY_NOTE_SETTINGS, timezone: 'Europe/Chisinau' }, d)).toBe(
      '2026-01-05.md',
    );
    expect(resolveDailyNotePath(DEFAULT_DAILY_NOTE_SETTINGS, d)).toBe('2026-01-05.md');
    expect(() => parseDateArg('yesterday', lateUtc, 'UTC')).toThrow(VaultError);
    expect(() => parseDateArg('2026-13-40', lateUtc, 'UTC')).toThrow(VaultError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/vault/daily-notes.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement src/vault/daily-notes.ts**

```ts
import { TZDate } from '@date-fns/tz';
import { format, isValid } from 'date-fns';
import { normalizeVaultPath } from '../storage/path-policy.ts';
import { VaultError } from '../storage/types.ts';

export interface DailyNoteSettings {
  folder: string;
  format: string;
  template: string | null;
  timezone: string;
}

export const DEFAULT_DAILY_NOTE_SETTINGS: DailyNoteSettings = {
  folder: '',
  format: 'yyyy-MM-dd',
  template: null,
  timezone: 'UTC',
};

const STRFTIME: Record<string, string> = {
  Y: 'yyyy',
  y: 'yy',
  m: 'MM',
  d: 'dd',
  H: 'HH',
  M: 'mm',
  S: 'ss',
  B: 'MMMM',
  b: 'MMM',
  A: 'EEEE',
  a: 'EEE',
  j: 'DDD',
  e: 'd',
  U: 'ww',
  V: 'II',
  u: 'i',
  w: 'e',
  '%': '%',
};

export function toDateFnsFormat(fmt: string): string {
  if (!fmt.includes('%')) return fmt;
  return fmt.replace(/%([A-Za-z%])/g, (whole, token: string) => STRFTIME[token] ?? whole);
}

function inZone(date: Date, timezone: string): TZDate {
  try {
    return new TZDate(date, timezone);
  } catch {
    throw new VaultError('INVALID_INPUT', `Unknown timezone ${JSON.stringify(timezone)}.`);
  }
}

export function formatInVaultZone(date: Date, fmt: string, timezone: string): string {
  return format(inZone(date, timezone), toDateFnsFormat(fmt));
}

export function resolveDailyNotePath(settings: DailyNoteSettings, date: Date): string {
  const name = formatInVaultZone(date, settings.format, settings.timezone);
  const folder = normalizeVaultPath(settings.folder);
  return normalizeVaultPath(folder === '' ? `${name}.md` : `${folder}/${name}.md`);
}

export function renderDailyTemplate(template: string, date: Date, settings: DailyNoteSettings): string {
  const title = formatInVaultZone(date, settings.format, settings.timezone);
  return template
    .replace(/\{\{\s*date:([^}]+?)\s*\}\}/g, (_m, fmt: string) => formatInVaultZone(date, fmt, settings.timezone))
    .replace(/\{\{\s*date\s*\}\}/g, title)
    .replace(/\{\{\s*title\s*\}\}/g, title);
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDateArg(input: string | undefined, now: Date, timezone: string): Date {
  if (input === undefined || input.trim() === '') return now;
  const m = ISO_DAY.exec(input.trim());
  if (!m) throw new VaultError('INVALID_INPUT', 'date must be YYYY-MM-DD.');
  const [, y, mo, d] = m;
  const candidate = new TZDate(Number(y), Number(mo) - 1, Number(d), 12, 0, 0, timezone);
  if (!isValid(candidate) || candidate.getMonth() !== Number(mo) - 1 || candidate.getDate() !== Number(d)) {
    throw new VaultError('INVALID_INPUT', `${input} is not a valid calendar date.`);
  }
  return candidate;
}
```

- [ ] **Step 4: Run tests, typecheck, lint, commit**

Run: `npx vitest run tests/vault/daily-notes.test.ts && npm run typecheck && npm run lint:fix`
Expected: PASS (6 tests). If `TZDate` constructor with an unknown zone does not throw, add an explicit check: `new Intl.DateTimeFormat('en-US', { timeZone: timezone })` inside a try/catch before constructing.

```bash
git add -A
git commit -m "feat(vault): timezone-aware daily note paths with strftime compatibility and templates"
```

---

### Task 9: Canvas (JSON Canvas parse/serialize, add node, add edge)

**Files:**
- Create: `src/vault/canvas.ts`
- Test: `tests/vault/canvas.test.ts`

**Interfaces:**
- Produces (Zod schemas are exported so tools reuse them as input schemas):
  ```ts
  export const CanvasNodeInputSchema: z.ZodType<...>;   // id?, type: 'text'|'file'|'link'|'group', x, y, width, height, color?, text?, file?, subpath?, url?, label?
  export const CanvasEdgeInputSchema: z.ZodType<...>;   // id?, fromNode, toNode, fromSide?, toSide?, fromEnd?, toEnd?, color?, label?
  export type CanvasNode = z.infer<typeof CanvasNodeSchema>;   // id required
  export type CanvasEdge = z.infer<typeof CanvasEdgeSchema>;
  export interface Canvas { nodes: CanvasNode[]; edges: CanvasEdge[] }
  export function parseCanvas(text: string): Canvas;             // '' -> empty canvas; invalid -> VaultError INVALID_INPUT; unknown keys preserved
  export function serializeCanvas(canvas: Canvas): string;       // JSON with tab indentation (Obsidian style) + trailing newline
  export function newCanvasId(): string;                         // 16 lowercase hex chars
  export function addNode(canvas: Canvas, input: z.infer<typeof CanvasNodeInputSchema>): { canvas: Canvas; node: CanvasNode };
  export function addEdge(canvas: Canvas, input: z.infer<typeof CanvasEdgeInputSchema>): { canvas: Canvas; edge: CanvasEdge };
  ```

- [ ] **Step 1: Write the failing test**

`tests/vault/canvas.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { VaultError } from '../../src/storage/types.ts';
import { addEdge, addNode, newCanvasId, parseCanvas, serializeCanvas } from '../../src/vault/canvas.ts';

describe('parseCanvas / serializeCanvas', () => {
  it('parses an empty file as an empty canvas and round-trips unknown keys', () => {
    expect(parseCanvas('')).toEqual({ nodes: [], edges: [] });
    const text = JSON.stringify({
      nodes: [{ id: 'a1', type: 'text', text: 'hi', x: 0, y: 0, width: 100, height: 50, customKey: 1 }],
      edges: [],
      metadata: { version: '1.0-0' },
    });
    const canvas = parseCanvas(text);
    expect(canvas.nodes[0]).toMatchObject({ id: 'a1', customKey: 1 });
    expect((canvas as unknown as { metadata: unknown }).metadata).toEqual({ version: '1.0-0' });
    const out = serializeCanvas(canvas);
    expect(out.endsWith('\n')).toBe(true);
    expect(out).toContain('\t"nodes"');
    expect(parseCanvas(out)).toEqual(canvas);
  });

  it('rejects invalid JSON and structurally invalid canvases', () => {
    expect(() => parseCanvas('{not json')).toThrow(VaultError);
    expect(() => parseCanvas('{"nodes":"nope","edges":[]}')).toThrow(VaultError);
    expect(() => parseCanvas('{"nodes":[{"id":"x","type":"text"}],"edges":[]}')).toThrow(VaultError);
  });
});

describe('addNode', () => {
  it('generates ids, validates by type and rejects duplicates', () => {
    const { canvas, node } = addNode(parseCanvas(''), { type: 'text', text: 'Hello', x: 10, y: 20, width: 200, height: 80 });
    expect(node.id).toMatch(/^[0-9a-f]{16}$/);
    expect(canvas.nodes).toHaveLength(1);
    const withFile = addNode(canvas, { id: 'f1', type: 'file', file: 'notes/a.md', x: 0, y: 0, width: 1, height: 1 });
    expect(withFile.canvas.nodes.map((n) => n.id)).toEqual([node.id, 'f1']);
    expect(() => addNode(withFile.canvas, { id: 'f1', type: 'link', url: 'https://x.y', x: 0, y: 0, width: 1, height: 1 })).toThrow(
      /already exists/,
    );
    expect(() => addNode(canvas, { type: 'file', x: 0, y: 0, width: 1, height: 1 } as never)).toThrow(VaultError);
    expect(() => addNode(canvas, { type: 'file', file: '../escape.md', x: 0, y: 0, width: 1, height: 1 })).toThrow(VaultError);
  });

  it('newCanvasId is unique-ish', () => {
    expect(new Set(Array.from({ length: 100 }, newCanvasId)).size).toBe(100);
  });
});

describe('addEdge', () => {
  it('requires both endpoints to exist and fills defaults', () => {
    let canvas = parseCanvas('');
    canvas = addNode(canvas, { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 1, height: 1 }).canvas;
    canvas = addNode(canvas, { id: 'b', type: 'text', text: 'B', x: 5, y: 5, width: 1, height: 1 }).canvas;
    const { canvas: next, edge } = addEdge(canvas, { fromNode: 'a', toNode: 'b', label: 'leads to' });
    expect(edge.id).toMatch(/^[0-9a-f]{16}$/);
    expect(edge).toMatchObject({ fromNode: 'a', toNode: 'b', label: 'leads to' });
    expect(next.edges).toHaveLength(1);
    expect(() => addEdge(next, { fromNode: 'a', toNode: 'zzz' })).toThrow(/zzz/);
    expect(() => addEdge(next, { id: edge.id, fromNode: 'a', toNode: 'b' })).toThrow(/already exists/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/vault/canvas.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement src/vault/canvas.ts**

```ts
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { normalizeVaultPath } from '../storage/path-policy.ts';
import { VaultError } from '../storage/types.ts';

const Side = z.enum(['top', 'right', 'bottom', 'left']);
const End = z.enum(['none', 'arrow']);

const NodeBase = z.object({
  id: z.string().min(1).optional(),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  color: z.string().optional(),
});

export const CanvasNodeInputSchema = z.discriminatedUnion('type', [
  NodeBase.extend({ type: z.literal('text'), text: z.string() }).loose(),
  NodeBase.extend({ type: z.literal('file'), file: z.string().min(1), subpath: z.string().optional() }).loose(),
  NodeBase.extend({ type: z.literal('link'), url: z.url() }).loose(),
  NodeBase.extend({
    type: z.literal('group'),
    label: z.string().optional(),
    background: z.string().optional(),
    backgroundStyle: z.enum(['cover', 'ratio', 'repeat']).optional(),
  }).loose(),
]);

export const CanvasEdgeInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    fromNode: z.string().min(1),
    toNode: z.string().min(1),
    fromSide: Side.optional(),
    toSide: Side.optional(),
    fromEnd: End.optional(),
    toEnd: End.optional(),
    color: z.string().optional(),
    label: z.string().optional(),
  })
  .loose();

const CanvasNodeSchema = CanvasNodeInputSchema.and(z.object({ id: z.string().min(1) }));
const CanvasEdgeSchema = CanvasEdgeInputSchema.and(z.object({ id: z.string().min(1) }));
const CanvasSchema = z.object({ nodes: z.array(CanvasNodeSchema), edges: z.array(CanvasEdgeSchema) }).loose();

export type CanvasNode = z.infer<typeof CanvasNodeSchema>;
export type CanvasEdge = z.infer<typeof CanvasEdgeSchema>;
export type CanvasNodeInput = z.infer<typeof CanvasNodeInputSchema>;
export type CanvasEdgeInput = z.infer<typeof CanvasEdgeInputSchema>;
export type Canvas = z.infer<typeof CanvasSchema>;

export function newCanvasId(): string {
  return randomBytes(8).toString('hex');
}

export function parseCanvas(text: string): Canvas {
  if (text.trim() === '') return { nodes: [], edges: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new VaultError('INVALID_INPUT', 'Canvas file is not valid JSON.');
  }
  const parsed = CanvasSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new VaultError(
      'INVALID_INPUT',
      `Canvas file is not a valid JSON Canvas: ${first ? `${first.path.join('.')}: ${first.message}` : 'schema error'}.`,
    );
  }
  return parsed.data;
}

export function serializeCanvas(canvas: Canvas): string {
  return `${JSON.stringify(canvas, null, '\t')}\n`;
}

export function addNode(canvas: Canvas, input: CanvasNodeInput): { canvas: Canvas; node: CanvasNode } {
  const parsed = CanvasNodeInputSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new VaultError('INVALID_INPUT', `Invalid canvas node: ${first?.path.join('.')} ${first?.message}.`);
  }
  const data = parsed.data;
  if (data.type === 'file') normalizeVaultPath(data.file); // throws INVALID_PATH on escape attempts
  const id = data.id ?? newCanvasId();
  if (canvas.nodes.some((n) => n.id === id)) {
    throw new VaultError('INVALID_INPUT', `A node with id ${id} already exists.`);
  }
  const node = { ...data, id } as CanvasNode;
  return { canvas: { ...canvas, nodes: [...canvas.nodes, node] }, node };
}

export function addEdge(canvas: Canvas, input: CanvasEdgeInput): { canvas: Canvas; edge: CanvasEdge } {
  const parsed = CanvasEdgeInputSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new VaultError('INVALID_INPUT', `Invalid canvas edge: ${first?.path.join('.')} ${first?.message}.`);
  }
  const data = parsed.data;
  const ids = new Set(canvas.nodes.map((n) => n.id));
  for (const endpoint of [data.fromNode, data.toNode]) {
    if (!ids.has(endpoint)) throw new VaultError('INVALID_INPUT', `Node ${endpoint} does not exist in this canvas.`);
  }
  const id = data.id ?? newCanvasId();
  if (canvas.edges.some((e) => e.id === id)) {
    throw new VaultError('INVALID_INPUT', `An edge with id ${id} already exists.`);
  }
  const edge = { ...data, id } as CanvasEdge;
  return { canvas: { ...canvas, edges: [...canvas.edges, edge] }, edge };
}
```

Zod 4 note: `.loose()` replaces v3's `.passthrough()`; `z.url()` is a top-level string format. If `discriminatedUnion` over `.loose()` members fails to type-check, apply `.loose()` to the final union via `z.union([...])` and check `type` manually.

- [ ] **Step 4: Run tests, typecheck, lint, commit**

Run: `npx vitest run tests/vault/canvas.test.ts && npm run typecheck && npm run lint:fix`
Expected: PASS (5 tests).

```bash
git add -A
git commit -m "feat(vault): JSON Canvas parse/serialize with validated node and edge insertion"
```

---

### Task 10: Vault analytics (hygiene summary and per-category findings)

**Files:**
- Create: `src/vault/analytics.ts`
- Test: `tests/vault/analytics.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const ANALYTICS_CATEGORIES = ['frontmatter_missing','required_frontmatter_missing','broken_wikilinks','suspicious_tag_variants','encoding_issues','oversized_files'] as const;
  export type AnalyticsCategory = (typeof ANALYTICS_CATEGORIES)[number];
  export interface AnalyticsFinding { category: AnalyticsCategory; path: string; detail: string }
  export interface AnalyticsSummary { scannedFiles: number; truncated: boolean; categories: Record<AnalyticsCategory, { count: number; examples: string[] }> }
  export interface AnalyticsOptions { requiredFrontmatter?: string[]; oversizedBytes?: number }   // defaults [], 524_288
  export interface AnalyticsReport { summary: AnalyticsSummary; findings: AnalyticsFinding[] }
  export async function analyzeVault(adapter: StorageAdapter, opts?: AnalyticsOptions): Promise<AnalyticsReport>
  ```
  Rules: scans at most `MAX_ANALYTICS_FILES` (sets `truncated`); markdown read in batches of 20; wikilinks `[[target|alias]]`, `[[target#heading]]`, `[[target^block]]`, `![[embed]]` resolve by exact path or by basename (Obsidian shortest-path), case-insensitive, `.md` optional; tag variants = distinct raw spellings that collapse to the same key after lowercasing and removing `-`/`_` (frontmatter `tags` string or array + inline `#tags`); `examples` = first 3 paths per category.

- [ ] **Step 1: Write the failing test**

`tests/vault/analytics.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFSAdapter } from '../../src/storage/local-fs.ts';
import { analyzeVault } from '../../src/vault/analytics.ts';

let root: string;
let vault: LocalFSAdapter;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-analytics-'));
  vault = await LocalFSAdapter.create(root, { ripgrepPath: null });
  await vault.write('ok.md', '---\ntype: note\ntags: [second-brain]\n---\nSee [[Target]] and [[sub/deep|alias]] and [[Target#Heading]].\n');
  await vault.write('Target.md', '---\ntype: note\ntags: [Second_Brain]\n---\n#secondbrain inline tag\n');
  await vault.write('sub/deep.md', 'no frontmatter, links to [[missing-note]] and ![[img.png]]\n');
  await vault.write('big.md', `---\ntype: note\n---\n${'x'.repeat(600_000)}\n`);
  await fs.writeFile(path.join(root, 'bad.md'), Buffer.from([0xff, 0xfe, 0x41]));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('analyzeVault', () => {
  it('produces counts, examples and detailed findings per category', async () => {
    const { summary, findings } = await analyzeVault(vault, { requiredFrontmatter: ['type', 'status'] });
    expect(summary.scannedFiles).toBe(5);
    expect(summary.truncated).toBe(false);

    expect(summary.categories.frontmatter_missing).toEqual({ count: 1, examples: ['sub/deep.md'] });
    // ok.md, Target.md, big.md have type but not status; sub/deep.md has neither
    expect(summary.categories.required_frontmatter_missing.count).toBe(4);
    expect(summary.categories.broken_wikilinks).toEqual({ count: 2, examples: ['sub/deep.md'] });
    expect(findings.filter((f) => f.category === 'broken_wikilinks').map((f) => f.detail)).toEqual([
      'missing-note',
      'img.png',
    ]);
    expect(summary.categories.suspicious_tag_variants.count).toBe(1);
    expect(findings.find((f) => f.category === 'suspicious_tag_variants')?.detail).toContain('second-brain');
    expect(findings.find((f) => f.category === 'suspicious_tag_variants')?.detail).toContain('Second_Brain');
    expect(findings.find((f) => f.category === 'suspicious_tag_variants')?.detail).toContain('secondbrain');
    expect(summary.categories.encoding_issues).toEqual({ count: 1, examples: ['bad.md'] });
    expect(summary.categories.oversized_files).toEqual({ count: 1, examples: ['big.md'] });
  });

  it('resolves links case-insensitively, with or without .md, by path or basename', async () => {
    await vault.write('links.md', '[[target]] [[TARGET.md]] [[sub/deep.md]] [[deep]] [[Sub/Deep]]\n');
    const { findings } = await analyzeVault(vault);
    expect(findings.filter((f) => f.category === 'broken_wikilinks' && f.path === 'links.md')).toEqual([]);
  });

  it('honors the oversized threshold option and defaults requiredFrontmatter to none', async () => {
    const { summary } = await analyzeVault(vault, { oversizedBytes: 10 });
    expect(summary.categories.oversized_files.count).toBeGreaterThanOrEqual(4);
    expect(summary.categories.required_frontmatter_missing.count).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/vault/analytics.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement src/vault/analytics.ts**

```ts
import { MAX_ANALYTICS_FILES, MAX_BATCH } from '../storage/limits.ts';
import { baseName, isMarkdownPath } from '../storage/path-policy.ts';
import type { Note, StorageAdapter } from '../storage/types.ts';

export const ANALYTICS_CATEGORIES = [
  'frontmatter_missing',
  'required_frontmatter_missing',
  'broken_wikilinks',
  'suspicious_tag_variants',
  'encoding_issues',
  'oversized_files',
] as const;

export type AnalyticsCategory = (typeof ANALYTICS_CATEGORIES)[number];

export interface AnalyticsFinding {
  category: AnalyticsCategory;
  path: string;
  detail: string;
}

export interface AnalyticsSummary {
  scannedFiles: number;
  truncated: boolean;
  categories: Record<AnalyticsCategory, { count: number; examples: string[] }>;
}

export interface AnalyticsOptions {
  requiredFrontmatter?: string[];
  oversizedBytes?: number;
}

export interface AnalyticsReport {
  summary: AnalyticsSummary;
  findings: AnalyticsFinding[];
}

const WIKILINK = /!?\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const INLINE_TAG = /(?:^|\s)#([\p{L}\p{N}_\-/]+)/gu;

function stripMd(name: string): string {
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
}

function tagKey(tag: string): string {
  return tag.toLowerCase().replace(/[-_]/g, '');
}

function collectTags(note: Note): string[] {
  const tags: string[] = [];
  const fm = note.frontmatter.tags;
  if (typeof fm === 'string') tags.push(...fm.split(/[,\s]+/).filter(Boolean));
  if (Array.isArray(fm)) tags.push(...fm.filter((t): t is string => typeof t === 'string'));
  for (const m of note.body.matchAll(INLINE_TAG)) if (m[1]) tags.push(m[1]);
  return tags.map((t) => t.replace(/^#/, ''));
}

export async function analyzeVault(adapter: StorageAdapter, opts: AnalyticsOptions = {}): Promise<AnalyticsReport> {
  const required = opts.requiredFrontmatter ?? [];
  const oversizedBytes = opts.oversizedBytes ?? 524_288;

  const allFiles = await adapter.list('', { depth: Number.POSITIVE_INFINITY, includeDirs: false });
  const truncated = allFiles.length > MAX_ANALYTICS_FILES;
  const files = allFiles.slice(0, MAX_ANALYTICS_FILES);
  const findings: AnalyticsFinding[] = [];

  const mdPaths = files.filter((f) => isMarkdownPath(f.path)).map((f) => f.path);
  const knownPaths = new Set(mdPaths.map((p) => stripMd(p).toLowerCase()));
  const knownBasenames = new Set(mdPaths.map((p) => stripMd(baseName(p)).toLowerCase()));
  const otherPaths = new Set(files.filter((f) => !isMarkdownPath(f.path)).map((f) => f.path.toLowerCase()));

  for (const file of files) {
    if ((file.size ?? 0) > oversizedBytes) {
      findings.push({ category: 'oversized_files', path: file.path, detail: `${file.size} bytes` });
    }
  }

  const tagForms = new Map<string, Map<string, string[]>>(); // key -> raw form -> paths

  for (let i = 0; i < mdPaths.length; i += MAX_BATCH) {
    const chunk = mdPaths.slice(i, i + MAX_BATCH);
    const { notes, failed } = await adapter.batchRead(chunk);
    for (const f of failed) {
      findings.push({ category: 'encoding_issues', path: f.path, detail: f.error });
    }
    for (const note of notes) {
      if (!note.hasFrontmatter) {
        findings.push({ category: 'frontmatter_missing', path: note.path, detail: 'no YAML frontmatter block' });
      }
      const missingKeys = required.filter((key) => note.frontmatter[key] === undefined);
      if (missingKeys.length > 0) {
        findings.push({
          category: 'required_frontmatter_missing',
          path: note.path,
          detail: `missing: ${missingKeys.join(', ')}`,
        });
      }
      for (const m of note.body.matchAll(WIKILINK)) {
        const target = (m[1] ?? '').trim();
        if (target === '') continue;
        const lower = target.toLowerCase();
        const resolved =
          knownPaths.has(stripMd(lower)) ||
          knownBasenames.has(stripMd(baseName(lower))) ||
          otherPaths.has(lower) ||
          [...otherPaths].some((p) => baseName(p) === lower);
        if (!resolved) findings.push({ category: 'broken_wikilinks', path: note.path, detail: target });
      }
      for (const tag of collectTags(note)) {
        const key = tagKey(tag);
        const forms = tagForms.get(key) ?? new Map<string, string[]>();
        forms.set(tag, [...(forms.get(tag) ?? []), note.path]);
        tagForms.set(key, forms);
      }
    }
  }

  for (const [, forms] of tagForms) {
    if (forms.size < 2) continue;
    const spellings = [...forms.keys()];
    const firstPath = [...forms.values()].flat().sort()[0] ?? '';
    findings.push({
      category: 'suspicious_tag_variants',
      path: firstPath,
      detail: `tag spelled ${spellings.length} ways: ${spellings.join(', ')}`,
    });
  }

  findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { summary: summarize(findings, files.length, truncated), findings };
}

export function summarize(findings: AnalyticsFinding[], scannedFiles: number, truncated: boolean): AnalyticsSummary {
  const categories = Object.fromEntries(
    ANALYTICS_CATEGORIES.map((category) => {
      const paths = [...new Set(findings.filter((f) => f.category === category).map((f) => f.path))];
      return [category, { count: findings.filter((f) => f.category === category).length, examples: paths.slice(0, 3) }];
    }),
  ) as AnalyticsSummary['categories'];
  return { scannedFiles, truncated, categories };
}
```

Note for the test `broken_wikilinks` detail order: findings are sorted by path only (stable sort keeps document order within a file), so `sub/deep.md` yields `['missing-note', 'img.png']` in source order.

- [ ] **Step 4: Run tests, typecheck, lint, commit**

Run: `npx vitest run tests/vault/analytics.test.ts && npm run typecheck && npm run lint:fix`
Expected: PASS (3 tests).

```bash
git add -A
git commit -m "feat(vault): analytics for frontmatter gaps, broken wikilinks, tag variants, encoding and size"
```

---

### Task 11: Tool result helpers and the VaultRuntime (adapter + index + settings)

**Files:**
- Create: `src/tools/results.ts`, `src/tools/annotations.ts`, `src/vault/runtime.ts`
- Test: `tests/tools/results.test.ts`, `tests/vault/runtime.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/tools/results.ts
  import type { CallToolResult } from '@modelcontextprotocol/server';
  export function okText(text: string): CallToolResult;
  export function okJson<T extends Record<string, unknown>>(structured: T, text?: string): CallToolResult; // text defaults to JSON.stringify(structured)
  export function fail(message: string): CallToolResult;                                                  // { isError: true }
  export function clampText(text: string, max?: number): { text: string; truncated: boolean; totalChars: number };
  export function errorToResult(error: unknown, log: (e: unknown) => void): CallToolResult;               // VaultError -> "CODE: message"; ZodError -> "INVALID_INPUT: ..."; else "INTERNAL: unexpected error" (logged)
  export function guarded(log: (e: unknown) => void, fn: () => Promise<CallToolResult>): Promise<CallToolResult>;
  // src/tools/annotations.ts
  export const READ_ONLY, OVERWRITE, APPEND_ONLY, MOVE_OR_DELETE: ToolAnnotations;  // see §5 table
  // src/vault/runtime.ts
  export interface VaultSettings { dailyNotes: DailyNoteSettings; requiredFrontmatter: string[] }
  export interface VaultRuntime {
    adapter: StorageAdapter; index: FrontmatterIndex; settings: VaultSettings; now: () => Date;
    caches: { analytics?: { at: number; report: AnalyticsReport } };
    close(): Promise<void>;
  }
  export type RuntimeResolver = (ctx: McpRequestContext) => Promise<VaultRuntime>;
  export interface LocalRuntimeOptions { vaultPath: string; settings?: Partial<VaultSettings>; ripgrepPath?: string | null; now?: () => Date }
  export async function createLocalRuntime(opts: LocalRuntimeOptions): Promise<VaultRuntime>;   // builds LocalFSAdapter + index, attaches watcher
  export const DEFAULT_VAULT_SETTINGS: VaultSettings;
  ```

- [ ] **Step 1: Write the failing tests**

`tests/tools/results.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MAX_RESULT_CHARS } from '../../src/storage/limits.ts';
import { VaultError } from '../../src/storage/types.ts';
import { clampText, errorToResult, fail, guarded, okJson, okText } from '../../src/tools/results.ts';

describe('results helpers', () => {
  it('builds text, json and error results', () => {
    expect(okText('hi')).toEqual({ content: [{ type: 'text', text: 'hi' }] });
    const r = okJson({ a: 1 });
    expect(r.structuredContent).toEqual({ a: 1 });
    expect(r.content).toEqual([{ type: 'text', text: '{"a":1}' }]);
    expect(okJson({ a: 1 }, 'custom').content[0]).toEqual({ type: 'text', text: 'custom' });
    expect(fail('nope')).toEqual({ isError: true, content: [{ type: 'text', text: 'nope' }] });
  });

  it('clamps long text and reports truncation', () => {
    const short = clampText('abc');
    expect(short).toEqual({ text: 'abc', truncated: false, totalChars: 3 });
    const long = clampText('x'.repeat(MAX_RESULT_CHARS + 10));
    expect(long.truncated).toBe(true);
    expect(long.totalChars).toBe(MAX_RESULT_CHARS + 10);
    expect(long.text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 200);
    expect(long.text).toContain('[truncated');
    expect(clampText('abcdef', 3).text.startsWith('abc')).toBe(true);
  });

  it('maps errors to actionable tool errors without leaking internals', () => {
    const logged: unknown[] = [];
    const log = (e: unknown) => logged.push(e);
    expect(errorToResult(new VaultError('NOT_FOUND', 'a.md does not exist.'), log)).toEqual(
      fail('NOT_FOUND: a.md does not exist.'),
    );
    const zodErr = z.object({ n: z.number() }).safeParse({ n: 'x' });
    const zr = errorToResult(zodErr.success ? null : zodErr.error, log);
    expect(zr.isError).toBe(true);
    expect((zr.content[0] as { text: string }).text).toMatch(/^INVALID_INPUT: /);
    const internal = errorToResult(new Error('db password is hunter2'), log);
    expect((internal.content[0] as { text: string }).text).toBe('INTERNAL: unexpected error; try again or report it.');
    expect((internal.content[0] as { text: string }).text).not.toContain('hunter2');
    expect(logged).toHaveLength(1);
  });

  it('guarded() converts thrown errors and passes results through', async () => {
    const log = () => {};
    expect(await guarded(log, async () => okText('ok'))).toEqual(okText('ok'));
    const r = await guarded(log, async () => {
      throw new VaultError('TOO_LARGE', 'big');
    });
    expect(r).toEqual(fail('TOO_LARGE: big'));
  });
});
```

`tests/vault/runtime.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_VAULT_SETTINGS, createLocalRuntime } from '../../src/vault/runtime.ts';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-runtime-'));
  await fs.writeFile(path.join(root, 'seed.md'), '---\ntype: seed\n---\n');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('createLocalRuntime', () => {
  it('builds adapter + index with defaults and closes cleanly', async () => {
    const runtime = await createLocalRuntime({ vaultPath: root, ripgrepPath: null });
    expect(runtime.adapter.capabilities().watch).toBe(true);
    expect(runtime.index.get('seed.md')?.frontmatter).toEqual({ type: 'seed' });
    expect(runtime.settings).toEqual(DEFAULT_VAULT_SETTINGS);
    expect(runtime.settings.dailyNotes.format).toBe('yyyy-MM-dd');
    expect(runtime.now()).toBeInstanceOf(Date);
    expect(runtime.caches).toEqual({});
    await runtime.close();
  });

  it('applies partial settings overrides deeply', async () => {
    const runtime = await createLocalRuntime({
      vaultPath: root,
      ripgrepPath: null,
      settings: { dailyNotes: { folder: 'journal', timezone: 'Europe/Chisinau' } as never, requiredFrontmatter: ['type'] },
    });
    expect(runtime.settings.dailyNotes).toEqual({ folder: 'journal', format: 'yyyy-MM-dd', template: null, timezone: 'Europe/Chisinau' });
    expect(runtime.settings.requiredFrontmatter).toEqual(['type']);
    await runtime.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/tools/results.test.ts tests/vault/runtime.test.ts`
Expected: FAIL — cannot find modules.

- [ ] **Step 3: Implement src/tools/results.ts**

```ts
import type { CallToolResult } from '@modelcontextprotocol/server';
import { ZodError } from 'zod';
import { MAX_RESULT_CHARS } from '../storage/limits.ts';
import { VaultError } from '../storage/types.ts';

export function okText(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function okJson<T extends Record<string, unknown>>(structured: T, text?: string): CallToolResult {
  return {
    content: [{ type: 'text', text: text ?? JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function clampText(
  text: string,
  max = MAX_RESULT_CHARS,
): { text: string; truncated: boolean; totalChars: number } {
  if (text.length <= max) return { text, truncated: false, totalChars: text.length };
  const head = text.slice(0, max);
  return {
    text: `${head}\n\n[truncated: showing ${max} of ${text.length} characters]`,
    truncated: true,
    totalChars: text.length,
  };
}

export function errorToResult(error: unknown, log: (e: unknown) => void): CallToolResult {
  if (error instanceof VaultError) return fail(`${error.code}: ${error.message}`);
  if (error instanceof ZodError) {
    const first = error.issues[0];
    return fail(`INVALID_INPUT: ${first ? `${first.path.join('.') || 'input'} — ${first.message}` : 'invalid arguments'}`);
  }
  log(error);
  return fail('INTERNAL: unexpected error; try again or report it.');
}

export async function guarded(
  log: (e: unknown) => void,
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    return errorToResult(error, log);
  }
}
```

- [ ] **Step 4: Implement src/tools/annotations.ts**

```ts
import type { ToolAnnotations } from '@modelcontextprotocol/server';

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Replaces content (write, frontmatter update, canvas mutation): destructive but idempotent. */
export const OVERWRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

/** Adds content without removing any: not destructive, not idempotent. */
export const APPEND_ONLY: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export const MOVE_OR_DELETE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
```

- [ ] **Step 5: Implement src/vault/runtime.ts**

```ts
import type { McpRequestContext } from '@modelcontextprotocol/server';
import { LocalFSAdapter } from '../storage/local-fs.ts';
import type { StorageAdapter, Unsubscribe } from '../storage/types.ts';
import type { AnalyticsReport } from './analytics.ts';
import { DEFAULT_DAILY_NOTE_SETTINGS, type DailyNoteSettings } from './daily-notes.ts';
import { FrontmatterIndex } from './frontmatter-index.ts';

export interface VaultSettings {
  dailyNotes: DailyNoteSettings;
  requiredFrontmatter: string[];
}

export const DEFAULT_VAULT_SETTINGS: VaultSettings = {
  dailyNotes: DEFAULT_DAILY_NOTE_SETTINGS,
  requiredFrontmatter: [],
};

export interface VaultRuntime {
  adapter: StorageAdapter;
  index: FrontmatterIndex;
  settings: VaultSettings;
  now: () => Date;
  caches: { analytics?: { at: number; report: AnalyticsReport } };
  close(): Promise<void>;
}

export type RuntimeResolver = (ctx: McpRequestContext) => Promise<VaultRuntime>;

export interface LocalRuntimeOptions {
  vaultPath: string;
  settings?: { dailyNotes?: Partial<DailyNoteSettings>; requiredFrontmatter?: string[] };
  ripgrepPath?: string | null;
  now?: () => Date;
}

export function mergeSettings(overrides: LocalRuntimeOptions['settings']): VaultSettings {
  return {
    dailyNotes: { ...DEFAULT_DAILY_NOTE_SETTINGS, ...(overrides?.dailyNotes ?? {}) },
    requiredFrontmatter: overrides?.requiredFrontmatter ?? [],
  };
}

export async function createLocalRuntime(opts: LocalRuntimeOptions): Promise<VaultRuntime> {
  const adapter = await LocalFSAdapter.create(opts.vaultPath, { ripgrepPath: opts.ripgrepPath });
  const index = await FrontmatterIndex.build(adapter);
  const detach: Unsubscribe = index.attach(adapter);
  return {
    adapter,
    index,
    settings: mergeSettings(opts.settings),
    now: opts.now ?? (() => new Date()),
    caches: {},
    async close() {
      detach();
    },
  };
}
```

- [ ] **Step 6: Run tests, typecheck, lint, commit**

Run: `npx vitest run tests/tools/results.test.ts tests/vault/runtime.test.ts && npm run typecheck && npm run lint:fix`
Expected: PASS (6 tests). If `LocalFSAdapter.create(..., { ripgrepPath: undefined })` fails `exactOptionalPropertyTypes`-style checks, build the options object conditionally.

```bash
git add -A
git commit -m "feat(tools): result helpers, annotation presets and VaultRuntime with local factory"
```

---

### Task 12: Read/write tool group + runtime-aware factory + integration harness

**Files:**
- Create: `src/tools/read.ts`, `src/tools/write.ts`, `src/tools/register.ts`, `tests/tools/harness.ts`
- Modify: `src/mcp/factory.ts`, `src/app.ts`, `tests/app.test.ts` (pass a resolver)
- Test: `tests/tools/read-write.test.ts`

**Interfaces:**
- Consumes: Tasks 1–11.
- Produces:
  ```ts
  // src/tools/register.ts
  export interface ToolContext { runtime: VaultRuntime; log: (e: unknown) => void }
  export function registerVaultTools(server: McpServer, tc: ToolContext): void;   // calls every group's register function
  export async function touch(tc: ToolContext, ...paths: string[]): Promise<void>; // index.refreshPath for each
  // src/tools/read.ts
  export function registerReadTools(server: McpServer, tc: ToolContext): void;    // vault_read, vault_batch_read
  // src/tools/write.ts
  export function registerWriteTools(server: McpServer, tc: ToolContext): void;   // vault_write, vault_write_binary, vault_edit, vault_append, vault_batch_frontmatter_update
  // src/mcp/factory.ts
  export interface FactoryDeps { resolveRuntime: RuntimeResolver; logger: Logger }
  export function createVaultServer(ctx: McpRequestContext, deps: FactoryDeps): Promise<McpServer>;
  // src/app.ts
  export function createApp(config: Config, logger: Logger, resolveRuntime: RuntimeResolver): AppBundle;
  // tests/tools/harness.ts
  export interface Harness { client: Client; runtime: VaultRuntime; root: string; call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>; close(): Promise<void> }
  export function startHarness(overrides?: LocalRuntimeOptions['settings']): Promise<Harness>;
  ```
  `brainstem_ping` stays registered (Phase 0 tests keep passing).

- [ ] **Step 1: Write the harness and the failing test**

`tests/tools/harness.ts`:
```ts
import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { createLogger } from '../../src/logger.ts';
import { type LocalRuntimeOptions, type VaultRuntime, createLocalRuntime } from '../../src/vault/runtime.ts';

export interface Harness {
  client: Client;
  runtime: VaultRuntime;
  root: string;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export async function startHarness(overrides?: LocalRuntimeOptions['settings']): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-tools-'));
  const runtime = await createLocalRuntime({ vaultPath: root, ripgrepPath: null, settings: overrides });
  const config = loadConfig({ PUBLIC_URL: 'https://brainstem.example.com' });
  const { app } = createApp(config, createLogger('fatal'), async () => runtime);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const client = new Client({ name: 'harness', version: '0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return {
    client,
    runtime,
    root,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    async close() {
      await client.close();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
      await runtime.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

export function text(result: CallToolResult): string {
  const first = result.content[0];
  return first && first.type === 'text' ? first.text : '';
}
```

`tests/tools/read-write.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness, text } from './harness.ts';

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

describe('tool surface', () => {
  it('registers the read/write group with annotations and schemas', async () => {
    const { tools } = await h.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ['vault_read', 'vault_batch_read', 'vault_write', 'vault_write_binary', 'vault_edit', 'vault_append', 'vault_batch_frontmatter_update']) {
      expect(byName.has(name), name).toBe(true);
      expect(byName.get(name)?.annotations?.openWorldHint).toBe(false);
    }
    expect(byName.get('vault_read')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get('vault_write')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(byName.get('vault_append')?.annotations).toMatchObject({ destructiveHint: false, idempotentHint: false });
    expect(byName.get('vault_batch_read')?.outputSchema).toBeDefined();
    expect(byName.get('vault_edit')?.outputSchema).toBeDefined();
  });
});

describe('vault_write / vault_read', () => {
  it('writes then reads a note, exposing frontmatter and body', async () => {
    const w = await h.call('vault_write', { path: '01-projects/plan.md', content: '---\ntitle: Plan\n---\n# Plan\n' });
    expect(w.isError).toBeFalsy();
    expect(w.structuredContent).toMatchObject({ path: '01-projects/plan.md' });
    const r = await h.call('vault_read', { path: '01-projects/plan.md' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe('---\ntitle: Plan\n---\n# Plan\n');
    expect(r.structuredContent).toMatchObject({ path: '01-projects/plan.md', frontmatter: { title: 'Plan' }, hasFrontmatter: true, truncated: false });
    expect(h.runtime.index.get('01-projects/plan.md')?.frontmatter).toEqual({ title: 'Plan' });
  });

  it('merges frontmatter when asked and rejects traversal with an actionable error', async () => {
    await h.call('vault_write', { path: 'n.md', content: '---\na: 1\n---\nold\n' });
    await h.call('vault_write', { path: 'n.md', content: '---\nb: 2\n---\nnew\n', mergeFrontmatter: true });
    const r = await h.call('vault_read', { path: 'n.md' });
    expect(r.structuredContent).toMatchObject({ frontmatter: { a: 1, b: 2 } });
    const bad = await h.call('vault_read', { path: '../etc/passwd' });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/^INVALID_PATH: /);
    const missing = await h.call('vault_read', { path: 'nope.md' });
    expect(text(missing)).toMatch(/^NOT_FOUND: /);
  });

  it('clamps oversized read results', async () => {
    await fs.writeFile(path.join(h.root, 'huge.md'), 'y'.repeat(130_000));
    const r = await h.call('vault_read', { path: 'huge.md' });
    expect(r.structuredContent).toMatchObject({ truncated: true, totalChars: 130_000 });
    expect(text(r)).toContain('[truncated');
  });
});

describe('vault_batch_read', () => {
  it('reads several notes and reports missing ones', async () => {
    await h.call('vault_write', { path: 'a.md', content: 'A' });
    await h.call('vault_write', { path: 'b.md', content: 'B' });
    const r = await h.call('vault_batch_read', { paths: ['a.md', 'b.md', 'zzz.md'] });
    expect(r.structuredContent).toMatchObject({ missing: ['zzz.md'], failed: [] });
    expect((r.structuredContent as { notes: { path: string; body: string }[] }).notes.map((n) => n.body)).toEqual(['A', 'B']);
    const tooMany = await h.call('vault_batch_read', { paths: new Array(21).fill('a.md') });
    expect(tooMany.isError).toBe(true);
  });
});

describe('vault_write_binary', () => {
  it('stores base64 content for allowed media types and rejects others', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const ok = await h.call('vault_write_binary', { path: 'img/a.png', base64: png, mimeType: 'image/png' });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ path: 'img/a.png', bytes: 4 });
    const bad = await h.call('vault_write_binary', { path: 'a.svg', base64: png, mimeType: 'image/svg+xml' });
    expect(bad.isError).toBe(true);
    const notB64 = await h.call('vault_write_binary', { path: 'img/b.png', base64: '%%%', mimeType: 'image/png' });
    expect(notB64.isError).toBe(true);
  });
});

describe('vault_edit / vault_append / vault_batch_frontmatter_update', () => {
  it('previews with dryRun, applies patches, appends and updates frontmatter', async () => {
    await h.call('vault_write', { path: 'e.md', content: '---\nstatus: draft\n---\nalpha\n' });
    const dry = await h.call('vault_edit', { path: 'e.md', patches: [{ find: 'alpha', replace: 'beta' }], dryRun: true });
    expect(dry.structuredContent).toMatchObject({ applied: 1, dryRun: true });
    expect(text(dry)).toContain('+beta');
    expect(text(await h.call('vault_read', { path: 'e.md' }))).toContain('alpha');
    const real = await h.call('vault_edit', { path: 'e.md', patches: [{ find: 'alpha', replace: 'beta' }] });
    expect(real.structuredContent).toMatchObject({ applied: 1, dryRun: false });
    await h.call('vault_append', { path: 'e.md', content: 'gamma' });
    expect(text(await h.call('vault_read', { path: 'e.md' }))).toBe('---\nstatus: draft\n---\nbeta\ngamma');
    const fm = await h.call('vault_batch_frontmatter_update', { updates: [{ path: 'e.md', set: { status: 'done' } }] });
    expect(fm.structuredContent).toMatchObject({ updated: ['e.md'], failed: [] });
    expect(h.runtime.index.get('e.md')?.frontmatter).toEqual({ status: 'done' });
    const ambiguous = await h.call('vault_edit', { path: 'e.md', patches: [{ find: 'a', replace: 'b' }] });
    expect(text(ambiguous)).toMatch(/INVALID_INPUT: patch #1/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tools/read-write.test.ts`
Expected: FAIL — `createApp` does not accept a third argument / modules missing.

- [ ] **Step 3: Implement src/tools/register.ts**

```ts
import type { McpServer } from '@modelcontextprotocol/server';
import type { VaultRuntime } from '../vault/runtime.ts';
import { registerReadTools } from './read.ts';
import { registerWriteTools } from './write.ts';

export interface ToolContext {
  runtime: VaultRuntime;
  log: (e: unknown) => void;
}

export async function touch(tc: ToolContext, ...paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => tc.runtime.index.refreshPath(tc.runtime.adapter, p)));
}

export function registerVaultTools(server: McpServer, tc: ToolContext): void {
  registerReadTools(server, tc);
  registerWriteTools(server, tc);
}
```
(Tasks 13 and 14 append `registerSearchTools`, `registerManageTools`, `registerCanvasTools`, `registerDailyTools`, `registerAnalyticsTools` here.)

- [ ] **Step 4: Implement src/tools/read.ts**

```ts
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { MAX_BATCH, MAX_RESULT_CHARS } from '../storage/limits.ts';
import { READ_ONLY } from './annotations.ts';
import type { ToolContext } from './register.ts';
import { clampText, guarded, okJson } from './results.ts';

const PathArg = z.string().describe('Vault-relative path, e.g. "01-projects/plan.md". No leading slash, no "..".');

const NoteSummary = z.object({
  path: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  hasFrontmatter: z.boolean(),
  size: z.number(),
  modifiedAt: z.string(),
});

export function registerReadTools(server: McpServer, tc: ToolContext): void {
  const { adapter } = tc.runtime;

  server.registerTool(
    'vault_read',
    {
      title: 'Read note',
      description:
        'Read one file from the vault. Returns the full text (frontmatter + body) and parsed frontmatter. Large files are truncated at 120k characters.',
      inputSchema: z.object({ path: PathArg }),
      outputSchema: NoteSummary.extend({ truncated: z.boolean(), totalChars: z.number() }),
      annotations: READ_ONLY,
    },
    ({ path }) =>
      guarded(tc.log, async () => {
        const note = await adapter.read(path);
        const clamped = clampText(note.content);
        return okJson(
          {
            path: note.path,
            frontmatter: note.frontmatter,
            hasFrontmatter: note.hasFrontmatter,
            size: note.meta.size,
            modifiedAt: note.meta.modifiedAt,
            truncated: clamped.truncated,
            totalChars: clamped.totalChars,
          },
          clamped.text,
        );
      }),
  );

  server.registerTool(
    'vault_batch_read',
    {
      title: 'Read several notes',
      description: `Read up to ${MAX_BATCH} files in one call. Missing files are listed in "missing", unreadable ones in "failed"; the call never fails because of one bad path.`,
      inputSchema: z.object({ paths: z.array(PathArg).min(1).max(MAX_BATCH) }),
      outputSchema: z.object({
        notes: z.array(NoteSummary.extend({ body: z.string(), truncated: z.boolean() })),
        missing: z.array(z.string()),
        failed: z.array(z.object({ path: z.string(), error: z.string() })),
      }),
      annotations: READ_ONLY,
    },
    ({ paths }) =>
      guarded(tc.log, async () => {
        const result = await adapter.batchRead(paths);
        const perNote = Math.max(2_000, Math.floor(MAX_RESULT_CHARS / Math.max(1, result.notes.length)));
        const notes = result.notes.map((note) => {
          const clamped = clampText(note.body, perNote);
          return {
            path: note.path,
            frontmatter: note.frontmatter,
            hasFrontmatter: note.hasFrontmatter,
            size: note.meta.size,
            modifiedAt: note.meta.modifiedAt,
            body: clamped.text,
            truncated: clamped.truncated,
          };
        });
        return okJson({ notes, missing: result.missing, failed: result.failed });
      }),
  );
}
```

- [ ] **Step 5: Implement src/tools/write.ts**

```ts
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { BINARY_MIME_ALLOWLIST, MAX_BATCH, MAX_FILE_BYTES } from '../storage/limits.ts';
import { VaultError } from '../storage/types.ts';
import { APPEND_ONLY, OVERWRITE } from './annotations.ts';
import { type ToolContext, touch } from './register.ts';
import { guarded, okJson } from './results.ts';

const PathArg = z.string().describe('Vault-relative path, e.g. "00-inbox/idea.md".');

function decodeBase64Strict(input: string): Uint8Array {
  const cleaned = input.replace(/\s+/g, '');
  if (cleaned === '' || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
    throw new VaultError('INVALID_INPUT', 'base64 is not valid.');
  }
  return new Uint8Array(Buffer.from(cleaned, 'base64'));
}

export function registerWriteTools(server: McpServer, tc: ToolContext): void {
  const { adapter } = tc.runtime;

  server.registerTool(
    'vault_write',
    {
      title: 'Write note',
      description: `Create or overwrite a text file (max ${MAX_FILE_BYTES} bytes). Content may start with a YAML frontmatter block. With mergeFrontmatter=true the existing frontmatter is kept and only the provided keys are changed. Prefer vault_edit or vault_append to change part of an existing note.`,
      inputSchema: z.object({
        path: PathArg,
        content: z.string(),
        mergeFrontmatter: z.boolean().optional().describe('Keep existing frontmatter keys not present in the new content.'),
      }),
      outputSchema: z.object({ path: z.string(), bytes: z.number() }),
      annotations: OVERWRITE,
    },
    ({ path, content, mergeFrontmatter }) =>
      guarded(tc.log, async () => {
        await adapter.write(path, content, { mergeFrontmatter: mergeFrontmatter ?? false });
        const note = await adapter.read(path);
        await touch(tc, note.path);
        return okJson({ path: note.path, bytes: note.meta.size }, `Wrote ${note.path} (${note.meta.size} bytes).`);
      }),
  );

  server.registerTool(
    'vault_write_binary',
    {
      title: 'Write image or PDF',
      description: `Store a binary attachment from base64. Allowed media types: ${[...BINARY_MIME_ALLOWLIST.keys()].join(', ')}. Max ${MAX_FILE_BYTES} bytes decoded. The file extension must match the media type.`,
      inputSchema: z.object({ path: PathArg, base64: z.string(), mimeType: z.string() }),
      outputSchema: z.object({ path: z.string(), bytes: z.number(), mimeType: z.string() }),
      annotations: OVERWRITE,
    },
    ({ path, base64, mimeType }) =>
      guarded(tc.log, async () => {
        const bytes = decodeBase64Strict(base64);
        await adapter.writeBinary(path, bytes, mimeType);
        return okJson({ path, bytes: bytes.byteLength, mimeType }, `Wrote ${path} (${bytes.byteLength} bytes, ${mimeType}).`);
      }),
  );

  server.registerTool(
    'vault_edit',
    {
      title: 'Edit note (exact-text patches)',
      description:
        'Apply ordered exact-text replacements to a file. Each "find" must occur exactly once in the current text (include surrounding context to disambiguate). Use dryRun=true to preview the unified diff without writing.',
      inputSchema: z.object({
        path: PathArg,
        patches: z.array(z.object({ find: z.string().min(1), replace: z.string() })).min(1).max(50),
        dryRun: z.boolean().optional(),
      }),
      outputSchema: z.object({ path: z.string(), applied: z.number(), dryRun: z.boolean(), diff: z.string() }),
      annotations: APPEND_ONLY,
    },
    ({ path, patches, dryRun }) =>
      guarded(tc.log, async () => {
        const result = await adapter.edit(path, patches, dryRun ?? false);
        if (!result.dryRun) await touch(tc, result.path);
        const summary = result.dryRun
          ? `Dry run: ${result.applied} patch(es) would change ${result.path}.\n${result.diff}`
          : `Applied ${result.applied} patch(es) to ${result.path}.\n${result.diff}`;
        return okJson({ ...result }, summary);
      }),
  );

  server.registerTool(
    'vault_append',
    {
      title: 'Append to note',
      description: 'Append text to the end of a file (a newline is inserted if the file does not end with one). Creates the file when missing. Cheaper than vault_write for adding to existing notes.',
      inputSchema: z.object({ path: PathArg, content: z.string().min(1) }),
      outputSchema: z.object({ path: z.string(), bytes: z.number() }),
      annotations: APPEND_ONLY,
    },
    ({ path, content }) =>
      guarded(tc.log, async () => {
        await adapter.append(path, content);
        const note = await adapter.read(path);
        await touch(tc, note.path);
        return okJson({ path: note.path, bytes: note.meta.size }, `Appended to ${note.path} (now ${note.meta.size} bytes).`);
      }),
  );

  server.registerTool(
    'vault_batch_frontmatter_update',
    {
      title: 'Update frontmatter on several notes',
      description: `Set or remove YAML frontmatter keys on up to ${MAX_BATCH} markdown files without touching their bodies. Per-file failures are reported in "failed".`,
      inputSchema: z.object({
        updates: z
          .array(
            z.object({
              path: PathArg,
              set: z.record(z.string(), z.unknown()).optional(),
              unset: z.array(z.string()).optional(),
            }),
          )
          .min(1)
          .max(MAX_BATCH),
      }),
      outputSchema: z.object({
        updated: z.array(z.string()),
        failed: z.array(z.object({ path: z.string(), error: z.string() })),
      }),
      annotations: OVERWRITE,
    },
    ({ updates }) =>
      guarded(tc.log, async () => {
        const result = await adapter.batchFrontmatterUpdate(updates);
        await touch(tc, ...result.updated);
        return okJson({ updated: result.updated, failed: result.failed });
      }),
  );
}
```

- [ ] **Step 6: Update src/mcp/factory.ts to take a runtime resolver**

Replace the file with:
```ts
import { McpServer, type McpRequestContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Logger } from '../logger.ts';
import { registerVaultTools } from '../tools/register.ts';
import type { RuntimeResolver } from '../vault/runtime.ts';
import { SERVER_INFO } from '../version.ts';

export interface FactoryDeps {
  resolveRuntime: RuntimeResolver;
  logger: Logger;
}

const PingOutput = z.object({
  server: z.string(),
  version: z.string(),
  era: z.enum(['legacy', 'modern']),
  now: z.string(),
});

/** Builds a fresh McpServer for one request (stateless per MCP 2026-07-28). */
export async function createVaultServer(ctx: McpRequestContext, deps: FactoryDeps): Promise<McpServer> {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'brainstem-mcp gives you read/write access to the user\'s personal markdown vault. Paths are vault-relative. Prefer vault_edit/vault_append over rewriting whole notes. Deleting requires confirm=true and only moves files to .trash/.',
    cacheHints: {
      'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    },
  });

  server.registerTool(
    'brainstem_ping',
    {
      title: 'Ping',
      description: 'Health check. Returns server name, version, protocol era and current time.',
      outputSchema: PingOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const out = { server: SERVER_INFO.name, version: SERVER_INFO.version, era: ctx.era, now: new Date().toISOString() };
      return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
    },
  );

  const runtime = await deps.resolveRuntime(ctx);
  registerVaultTools(server, {
    runtime,
    log: (error) => deps.logger.error({ err: error }, 'tool failure'),
  });
  return server;
}
```

- [ ] **Step 7: Update src/app.ts and tests/app.test.ts**

In `src/app.ts` change the signature and the handler factory:
```ts
import type { RuntimeResolver } from './vault/runtime.ts';
// ...
export function createApp(config: Config, logger: Logger, resolveRuntime: RuntimeResolver): AppBundle {
  const handler = createMcpHandler((ctx) => createVaultServer(ctx, { resolveRuntime, logger }), {
    legacy: config.legacyMode,
    keepAliveMs: 15_000,
    onerror: (error) => logger.warn({ err: error }, 'mcp handler error'),
  });
  // ... unchanged below
```

In `tests/app.test.ts`, build a throwaway runtime for the Phase 0 tests:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalRuntime, type VaultRuntime } from '../src/vault/runtime.ts';
// inside beforeAll, before createApp:
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-app-'));
runtime = await createLocalRuntime({ vaultPath: root, ripgrepPath: null });
const { app } = createApp(config, logger, async () => runtime);
// in afterAll: await runtime.close();
```
(declare `let runtime: VaultRuntime;` next to `let server: Server;`). Also update `tests/server.test.ts` → `startServer(config, logger, resolver, 0)` after Task 15 changes the signature; until then leave `server.test.ts` untouched and let Task 15 fix it (mark it `it.skip` temporarily with a `// TODO(task 15)` comment is NOT allowed — instead do the signature change now in `src/server.ts`: `startServer(config, logger, resolveRuntime, listenPort?, opts?)` (keep the trailing `opts: { drainMs?: number }` parameter added by the Phase 0 fix wave) and pass `async () => runtime` in the test, building the runtime the same way).

- [ ] **Step 8: Run all tests, typecheck, lint, commit**

Run: `npm test && npm run typecheck && npm run lint:fix`
Expected: PASS — Phase 0 suites + `read-write.test.ts` (6 tests).

```bash
git add -A
git commit -m "feat(tools): read/write tool group, runtime-aware server factory and HTTP integration harness"
```

---

### Task 13: Search, list, move and delete tool group

**Files:**
- Create: `src/tools/search.ts`, `src/tools/manage.ts`
- Modify: `src/tools/register.ts` (call the two new register functions)
- Test: `tests/tools/search-manage.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function registerSearchTools(server: McpServer, tc: ToolContext): void;   // vault_search, vault_search_frontmatter
  export function registerManageTools(server: McpServer, tc: ToolContext): void;   // vault_list, vault_move, vault_delete
  ```

- [ ] **Step 1: Write the failing test**

`tests/tools/search-manage.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness, text } from './harness.ts';

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
  await h.call('vault_write', { path: '00-inbox/todo.md', content: '---\ntype: task\nstatus: open\n---\nBuy milk\n' });
  await h.call('vault_write', { path: '01-projects/brainstem/plan.md', content: '---\ntype: project\nstatus: open\n---\nShip it\n' });
  await h.call('vault_write', { path: '02-areas/health.md', content: 'Drink milk\n' });
});

afterEach(async () => {
  await h.close();
});

describe('vault_search', () => {
  it('returns literal matches with a truncation flag and honors limit/prefix', async () => {
    const r = await h.call('vault_search', { query: 'milk' });
    expect(r.structuredContent).toMatchObject({ query: 'milk', truncated: false });
    const matches = (r.structuredContent as { matches: { path: string; line: number; text: string }[] }).matches;
    expect(matches.map((m) => m.path)).toEqual(['00-inbox/todo.md', '02-areas/health.md']);
    const limited = await h.call('vault_search', { query: 'milk', limit: 1 });
    expect(limited.structuredContent).toMatchObject({ truncated: true });
    const scoped = await h.call('vault_search', { query: 'milk', pathPrefix: '02-areas' });
    expect((scoped.structuredContent as { matches: unknown[] }).matches).toHaveLength(1);
    const empty = await h.call('vault_search', { query: '  ' });
    expect(empty.isError).toBe(true);
  });
});

describe('vault_search_frontmatter', () => {
  it('queries the index by equals/contains/exists and requires a criterion', async () => {
    const r = await h.call('vault_search_frontmatter', { field: 'status', equals: 'open' });
    expect((r.structuredContent as { hits: { path: string }[] }).hits.map((x) => x.path)).toEqual([
      '00-inbox/todo.md',
      '01-projects/brainstem/plan.md',
    ]);
    const ex = await h.call('vault_search_frontmatter', { field: 'type', exists: false });
    expect((ex.structuredContent as { hits: { path: string }[] }).hits.map((x) => x.path)).toEqual(['02-areas/health.md']);
    const none = await h.call('vault_search_frontmatter', { field: 'type' });
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/INVALID_INPUT/);
  });
});

describe('vault_list', () => {
  it('lists with depth and glob and rejects hidden folders', async () => {
    const top = await h.call('vault_list', {});
    expect((top.structuredContent as { entries: { path: string; kind: string }[] }).entries.map((e) => e.path)).toEqual([
      '00-inbox',
      '01-projects',
      '02-areas',
    ]);
    const md = await h.call('vault_list', { path: '01-projects', depth: 3, glob: '**/*.md', includeDirs: false });
    expect((md.structuredContent as { entries: { path: string }[] }).entries.map((e) => e.path)).toEqual([
      '01-projects/brainstem/plan.md',
    ]);
    const hidden = await h.call('vault_list', { path: '.obsidian' });
    expect(text(hidden)).toMatch(/INVALID_PATH/);
  });
});

describe('vault_move / vault_delete', () => {
  it('moves files and folders keeping the index in sync', async () => {
    const mv = await h.call('vault_move', { from: '00-inbox/todo.md', to: '04-archive/todo.md' });
    expect(mv.structuredContent).toEqual({ from: '00-inbox/todo.md', to: '04-archive/todo.md' });
    expect(h.runtime.index.get('00-inbox/todo.md')).toBeUndefined();
    expect(h.runtime.index.get('04-archive/todo.md')?.frontmatter).toMatchObject({ type: 'task' });
    await h.call('vault_move', { from: '01-projects/brainstem', to: '01-projects/bs' });
    expect(h.runtime.index.get('01-projects/bs/plan.md')).toBeDefined();
    expect(h.runtime.index.get('01-projects/brainstem/plan.md')).toBeUndefined();
    const clash = await h.call('vault_move', { from: '04-archive/todo.md', to: '02-areas/health.md' });
    expect(text(clash)).toMatch(/ALREADY_EXISTS/);
  });

  it('requires confirm=true and soft-deletes into .trash', async () => {
    const refused = await h.call('vault_delete', { path: '02-areas/health.md', confirm: false });
    expect(text(refused)).toMatch(/CONFIRM_REQUIRED/);
    const ok = await h.call('vault_delete', { path: '02-areas/health.md', confirm: true });
    expect(ok.structuredContent).toEqual({ path: '02-areas/health.md', trashed: true });
    expect(await fs.readFile(path.join(h.root, '.trash/02-areas/health.md'), 'utf8')).toBe('Drink milk\n');
    expect(h.runtime.index.get('02-areas/health.md')).toBeUndefined();
    const gone = await h.call('vault_read', { path: '02-areas/health.md' });
    expect(text(gone)).toMatch(/NOT_FOUND/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tools/search-manage.test.ts`
Expected: FAIL — unknown tool `vault_search` (JSON-RPC error surfaces as a rejected promise; that is the expected failure).

- [ ] **Step 3: Implement src/tools/search.ts**

```ts
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { MAX_SEARCH_RESULTS } from '../storage/limits.ts';
import { VaultError } from '../storage/types.ts';
import { READ_ONLY } from './annotations.ts';
import type { ToolContext } from './register.ts';
import { guarded, okJson } from './results.ts';

export function registerSearchTools(server: McpServer, tc: ToolContext): void {
  const { adapter, index } = tc.runtime;

  server.registerTool(
    'vault_search',
    {
      title: 'Full-text search',
      description: `Literal (non-regex) substring search across text files in the vault, case-insensitive by default. Returns up to ${MAX_SEARCH_RESULTS} matching lines with path and line number. Use pathPrefix to scope to a folder.`,
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
        caseSensitive: z.boolean().optional(),
        pathPrefix: z.string().optional().describe('Folder to search in, e.g. "01-projects".'),
      }),
      outputSchema: z.object({
        query: z.string(),
        matches: z.array(z.object({ path: z.string(), line: z.number(), text: z.string() })),
        truncated: z.boolean(),
      }),
      annotations: READ_ONLY,
    },
    ({ query, limit, caseSensitive, pathPrefix }) =>
      guarded(tc.log, async () => {
        const max = limit ?? MAX_SEARCH_RESULTS;
        const opts = {
          limit: max,
          ...(caseSensitive !== undefined ? { caseSensitive } : {}),
          ...(pathPrefix !== undefined ? { pathPrefix } : {}),
        };
        const matches = await adapter.search(query, opts);
        return okJson({ query, matches, truncated: matches.length >= max });
      }),
  );

  server.registerTool(
    'vault_search_frontmatter',
    {
      title: 'Search by frontmatter',
      description:
        'Find markdown notes by a frontmatter field using the in-memory index. Provide at least one of equals (exact value or array membership), contains (case-insensitive substring) or exists. Dot paths like "meta.owner" are supported.',
      inputSchema: z.object({
        field: z.string().min(1),
        equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
        contains: z.string().optional(),
        exists: z.boolean().optional(),
      }),
      outputSchema: z.object({
        field: z.string(),
        hits: z.array(z.object({ path: z.string(), value: z.unknown() })),
      }),
      annotations: READ_ONLY,
    },
    ({ field, equals, contains, exists }) =>
      guarded(tc.log, async () => {
        if (equals === undefined && contains === undefined && exists === undefined) {
          throw new VaultError('INVALID_INPUT', 'Provide at least one of equals, contains or exists.');
        }
        const hits = index.query({
          field,
          ...(equals !== undefined ? { equals } : {}),
          ...(contains !== undefined ? { contains } : {}),
          ...(exists !== undefined ? { exists } : {}),
        });
        return okJson({ field, hits });
      }),
  );
}
```

- [ ] **Step 4: Implement src/tools/manage.ts**

```ts
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { isMarkdownPath, normalizeVaultPath } from '../storage/path-policy.ts';
import { MOVE_OR_DELETE, READ_ONLY } from './annotations.ts';
import { type ToolContext, touch } from './register.ts';
import { guarded, okJson } from './results.ts';

export function registerManageTools(server: McpServer, tc: ToolContext): void {
  const { adapter, index } = tc.runtime;

  server.registerTool(
    'vault_list',
    {
      title: 'List folder',
      description:
        'List files and folders under a vault path (default: root, depth 1). Use depth for recursion and glob (relative to the listed folder, e.g. "**/*.md") to filter. Hidden folders such as .obsidian are never listed.',
      inputSchema: z.object({
        path: z.string().optional(),
        depth: z.number().int().min(1).max(50).optional(),
        glob: z.string().optional(),
        includeFiles: z.boolean().optional(),
        includeDirs: z.boolean().optional(),
      }),
      outputSchema: z.object({
        path: z.string(),
        entries: z.array(
          z.object({
            path: z.string(),
            kind: z.enum(['file', 'dir']),
            size: z.number().optional(),
            modifiedAt: z.string().optional(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    ({ path, depth, glob, includeFiles, includeDirs }) =>
      guarded(tc.log, async () => {
        const base = normalizeVaultPath(path ?? '');
        const entries = await adapter.list(base, {
          ...(depth !== undefined ? { depth } : {}),
          ...(glob !== undefined ? { glob } : {}),
          ...(includeFiles !== undefined ? { includeFiles } : {}),
          ...(includeDirs !== undefined ? { includeDirs } : {}),
        });
        return okJson({ path: base, entries });
      }),
  );

  server.registerTool(
    'vault_move',
    {
      title: 'Move or rename',
      description: 'Move or rename a file or folder inside the vault. Fails if the destination already exists. Wikilinks in other notes are not rewritten.',
      inputSchema: z.object({ from: z.string(), to: z.string() }),
      outputSchema: z.object({ from: z.string(), to: z.string() }),
      annotations: MOVE_OR_DELETE,
    },
    ({ from, to }) =>
      guarded(tc.log, async () => {
        const src = normalizeVaultPath(from);
        const dst = normalizeVaultPath(to);
        await adapter.move(src, dst);
        // Keep the index coherent for a single note or a whole folder.
        if (index.get(src)) {
          index.rename(src, dst);
          await touch(tc, dst);
        } else {
          for (const entry of index.all()) {
            if (entry.path.startsWith(`${src}/`)) index.rename(entry.path, `${dst}/${entry.path.slice(src.length + 1)}`);
          }
        }
        return okJson({ from: src, to: dst }, `Moved ${src} → ${dst}.`);
      }),
  );

  server.registerTool(
    'vault_delete',
    {
      title: 'Delete (to trash)',
      description:
        'Soft-delete a file or folder by moving it into the vault\'s .trash/ folder. Requires confirm=true — call without it first only if you need the user to confirm. Nothing is erased permanently.',
      inputSchema: z.object({ path: z.string(), confirm: z.boolean() }),
      outputSchema: z.object({ path: z.string(), trashed: z.boolean() }),
      annotations: MOVE_OR_DELETE,
    },
    ({ path, confirm }) =>
      guarded(tc.log, async () => {
        const p = normalizeVaultPath(path);
        await adapter.softDelete(p, confirm);
        if (isMarkdownPath(p)) index.remove(p);
        for (const entry of index.all()) if (entry.path.startsWith(`${p}/`)) index.remove(entry.path);
        return okJson({ path: p, trashed: true }, `Moved ${p} to .trash/.`);
      }),
  );
}
```

- [ ] **Step 5: Register the groups**

In `src/tools/register.ts` add imports and calls:
```ts
import { registerManageTools } from './manage.ts';
import { registerSearchTools } from './search.ts';
// in registerVaultTools, after registerWriteTools:
  registerSearchTools(server, tc);
  registerManageTools(server, tc);
```

- [ ] **Step 6: Run tests, typecheck, lint, commit**

Run: `npx vitest run tests/tools/ && npm run typecheck && npm run lint:fix`
Expected: PASS.

```bash
git add -A
git commit -m "feat(tools): search, frontmatter query, list, move and soft-delete tools"
```

---

### Task 14: Canvas, daily-note and analytics tool group

**Files:**
- Create: `src/tools/canvas.ts`, `src/tools/daily.ts`, `src/tools/analytics.ts`
- Modify: `src/tools/register.ts`
- Test: `tests/tools/canvas-daily-analytics.test.ts`

**Interfaces:**
- Produces: `registerCanvasTools`, `registerDailyTools`, `registerAnalyticsTools` — same `(server, tc)` signature.

- [ ] **Step 1: Write the failing test**

`tests/tools/canvas-daily-analytics.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness, text } from './harness.ts';

let h: Harness;

beforeEach(async () => {
  h = await startHarness({
    dailyNotes: { folder: 'journal', timezone: 'Europe/Chisinau', template: '# {{title}}\n\n## Log\n' },
    requiredFrontmatter: ['type'],
  });
});

afterEach(async () => {
  await h.close();
});

describe('canvas tools', () => {
  it('creates a canvas by adding nodes and edges, then reads it back', async () => {
    const n1 = await h.call('vault_canvas_add_node', {
      path: 'boards/ideas.canvas',
      node: { id: 'a', type: 'text', text: 'Idea A', x: 0, y: 0, width: 200, height: 100 },
    });
    expect(n1.structuredContent).toMatchObject({ path: 'boards/ideas.canvas', node: { id: 'a' } });
    const n2 = await h.call('vault_canvas_add_node', {
      path: 'boards/ideas.canvas',
      node: { type: 'file', file: '01-projects/plan.md', x: 300, y: 0, width: 200, height: 100 },
    });
    const bId = (n2.structuredContent as { node: { id: string } }).node.id;
    expect(bId).toMatch(/^[0-9a-f]{16}$/);
    const e = await h.call('vault_canvas_add_edge', { path: 'boards/ideas.canvas', edge: { fromNode: 'a', toNode: bId, label: 'informs' } });
    expect(e.structuredContent).toMatchObject({ edge: { fromNode: 'a', toNode: bId } });
    const read = await h.call('vault_canvas_read', { path: 'boards/ideas.canvas' });
    expect(read.structuredContent).toMatchObject({ path: 'boards/ideas.canvas' });
    expect((read.structuredContent as { nodes: unknown[]; edges: unknown[] }).nodes).toHaveLength(2);
    expect((read.structuredContent as { nodes: unknown[]; edges: unknown[] }).edges).toHaveLength(1);
    expect(await fs.readFile(path.join(h.root, 'boards/ideas.canvas'), 'utf8')).toContain('\t"nodes"');
    const notCanvas = await h.call('vault_canvas_read', { path: 'note.md' });
    expect(text(notCanvas)).toMatch(/INVALID_INPUT/);
    const badEdge = await h.call('vault_canvas_add_edge', { path: 'boards/ideas.canvas', edge: { fromNode: 'a', toNode: 'nope' } });
    expect(text(badEdge)).toMatch(/nope/);
  });
});

describe('daily note tools', () => {
  it('resolves paths in the vault timezone, refuses to read missing notes, creates from template on append', async () => {
    const p = await h.call('vault_daily_note_path', { date: '2026-08-29' });
    expect(p.structuredContent).toEqual({ path: 'journal/2026-08-29.md', date: '2026-08-29', exists: false });
    const missing = await h.call('vault_daily_note_read', { date: '2026-08-29' });
    expect(text(missing)).toMatch(/NOT_FOUND/);
    const a = await h.call('vault_daily_note_append', { date: '2026-08-29', content: '- did a thing' });
    expect(a.structuredContent).toEqual({ path: 'journal/2026-08-29.md', created: true });
    const r = await h.call('vault_daily_note_read', { date: '2026-08-29' });
    expect(text(r)).toBe('# 2026-08-29\n\n## Log\n- did a thing');
    const a2 = await h.call('vault_daily_note_append', { date: '2026-08-29', content: '- another' });
    expect(a2.structuredContent).toEqual({ path: 'journal/2026-08-29.md', created: false });
    const today = await h.call('vault_daily_note_path', {});
    expect((today.structuredContent as { date: string }).date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const bad = await h.call('vault_daily_note_path', { date: 'tomorrow' });
    expect(text(bad)).toMatch(/INVALID_INPUT/);
  });
});

describe('analytics tools', () => {
  it('summarizes hygiene issues, caches, and drills into a category', async () => {
    await h.call('vault_write', { path: 'a.md', content: '---\ntype: note\n---\n[[missing]]\n' });
    await h.call('vault_write', { path: 'b.md', content: 'no frontmatter\n' });
    const s = await h.call('vault_analytics_summary', {});
    expect(s.structuredContent).toMatchObject({
      scannedFiles: 2,
      truncated: false,
      categories: {
        frontmatter_missing: { count: 1, examples: ['b.md'] },
        required_frontmatter_missing: { count: 1, examples: ['b.md'] },
        broken_wikilinks: { count: 1, examples: ['a.md'] },
      },
    });
    await h.call('vault_write', { path: 'c.md', content: 'also none\n' });
    const cached = await h.call('vault_analytics_summary', {});
    expect((cached.structuredContent as { scannedFiles: number }).scannedFiles).toBe(2);
    const fresh = await h.call('vault_analytics_summary', { refresh: true });
    expect((fresh.structuredContent as { scannedFiles: number }).scannedFiles).toBe(3);
    const f = await h.call('vault_analytics_findings', { category: 'broken_wikilinks' });
    expect(f.structuredContent).toEqual({
      category: 'broken_wikilinks',
      total: 1,
      findings: [{ category: 'broken_wikilinks', path: 'a.md', detail: 'missing' }],
    });
    const badCat = await h.call('vault_analytics_findings', { category: 'nonsense' });
    expect(badCat.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tools/canvas-daily-analytics.test.ts`
Expected: FAIL — unknown tools.

- [ ] **Step 3: Implement src/tools/canvas.ts**

```ts
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { normalizeVaultPath } from '../storage/path-policy.ts';
import { VaultError } from '../storage/types.ts';
import { type Canvas, CanvasEdgeInputSchema, CanvasNodeInputSchema, addEdge, addNode, parseCanvas, serializeCanvas } from '../vault/canvas.ts';
import { OVERWRITE, READ_ONLY } from './annotations.ts';
import type { ToolContext } from './register.ts';
import { guarded, okJson } from './results.ts';

function requireCanvasPath(input: string): string {
  const p = normalizeVaultPath(input);
  if (!p.toLowerCase().endsWith('.canvas')) {
    throw new VaultError('INVALID_INPUT', `${p || '(root)'} is not a .canvas file.`);
  }
  return p;
}

export function registerCanvasTools(server: McpServer, tc: ToolContext): void {
  const { adapter } = tc.runtime;

  async function readCanvasOrEmpty(p: string): Promise<Canvas> {
    try {
      return parseCanvas((await adapter.read(p)).content);
    } catch (error) {
      if (error instanceof VaultError && error.code === 'NOT_FOUND') return { nodes: [], edges: [] };
      throw error;
    }
  }

  server.registerTool(
    'vault_canvas_read',
    {
      title: 'Read canvas',
      description: 'Read an Obsidian .canvas file (JSON Canvas) and return its nodes and edges.',
      inputSchema: z.object({ path: z.string() }),
      outputSchema: z.object({ path: z.string(), nodes: z.array(z.record(z.string(), z.unknown())), edges: z.array(z.record(z.string(), z.unknown())) }),
      annotations: READ_ONLY,
    },
    ({ path }) =>
      guarded(tc.log, async () => {
        const p = requireCanvasPath(path);
        const canvas = parseCanvas((await adapter.read(p)).content);
        return okJson({ path: p, nodes: canvas.nodes, edges: canvas.edges });
      }),
  );

  server.registerTool(
    'vault_canvas_add_node',
    {
      title: 'Add canvas node',
      description: 'Append a node (text, file, link or group) to a .canvas file, creating the canvas if missing. The id is generated when omitted.',
      inputSchema: z.object({ path: z.string(), node: CanvasNodeInputSchema }),
      outputSchema: z.object({ path: z.string(), node: z.record(z.string(), z.unknown()) }),
      annotations: OVERWRITE,
    },
    ({ path, node }) =>
      guarded(tc.log, async () => {
        const p = requireCanvasPath(path);
        const { canvas, node: added } = addNode(await readCanvasOrEmpty(p), node);
        await adapter.write(p, serializeCanvas(canvas));
        return okJson({ path: p, node: added }, `Added node ${added.id} to ${p}.`);
      }),
  );

  server.registerTool(
    'vault_canvas_add_edge',
    {
      title: 'Add canvas edge',
      description: 'Append an edge between two existing nodes of a .canvas file. Both fromNode and toNode must exist.',
      inputSchema: z.object({ path: z.string(), edge: CanvasEdgeInputSchema }),
      outputSchema: z.object({ path: z.string(), edge: z.record(z.string(), z.unknown()) }),
      annotations: OVERWRITE,
    },
    ({ path, edge }) =>
      guarded(tc.log, async () => {
        const p = requireCanvasPath(path);
        const current = parseCanvas((await adapter.read(p)).content);
        const { canvas, edge: added } = addEdge(current, edge);
        await adapter.write(p, serializeCanvas(canvas));
        return okJson({ path: p, edge: added }, `Added edge ${added.id} to ${p}.`);
      }),
  );
}
```

- [ ] **Step 4: Implement src/tools/daily.ts**

```ts
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { VaultError } from '../storage/types.ts';
import { formatInVaultZone, parseDateArg, renderDailyTemplate, resolveDailyNotePath } from '../vault/daily-notes.ts';
import { APPEND_ONLY, READ_ONLY } from './annotations.ts';
import { type ToolContext, touch } from './register.ts';
import { clampText, guarded, okJson } from './results.ts';

const DateArg = z.string().optional().describe('Calendar day as YYYY-MM-DD in the vault timezone. Defaults to today.');

export function registerDailyTools(server: McpServer, tc: ToolContext): void {
  const { adapter, settings, now } = tc.runtime;
  const daily = settings.dailyNotes;

  function resolve(dateArg: string | undefined): { path: string; date: string; when: Date } {
    const when = parseDateArg(dateArg, now(), daily.timezone);
    return { path: resolveDailyNotePath(daily, when), date: formatInVaultZone(when, 'yyyy-MM-dd', daily.timezone), when };
  }

  server.registerTool(
    'vault_daily_note_path',
    {
      title: 'Daily note path',
      description: 'Resolve the path of the daily note for a date (default today, vault timezone) and whether it exists.',
      inputSchema: z.object({ date: DateArg }),
      outputSchema: z.object({ path: z.string(), date: z.string(), exists: z.boolean() }),
      annotations: READ_ONLY,
    },
    ({ date }) =>
      guarded(tc.log, async () => {
        const { path, date: day } = resolve(date);
        let exists = true;
        try {
          await adapter.read(path);
        } catch (error) {
          if (error instanceof VaultError && error.code === 'NOT_FOUND') exists = false;
          else throw error;
        }
        return okJson({ path, date: day, exists });
      }),
  );

  server.registerTool(
    'vault_daily_note_read',
    {
      title: 'Read daily note',
      description: 'Read the daily note for a date (default today). Fails with NOT_FOUND when it does not exist — it never creates one; use vault_daily_note_append to create.',
      inputSchema: z.object({ date: DateArg }),
      outputSchema: z.object({ path: z.string(), date: z.string(), frontmatter: z.record(z.string(), z.unknown()), truncated: z.boolean() }),
      annotations: READ_ONLY,
    },
    ({ date }) =>
      guarded(tc.log, async () => {
        const { path, date: day } = resolve(date);
        const note = await adapter.read(path);
        const clamped = clampText(note.content);
        return okJson({ path, date: day, frontmatter: note.frontmatter, truncated: clamped.truncated }, clamped.text);
      }),
  );

  server.registerTool(
    'vault_daily_note_append',
    {
      title: 'Append to daily note',
      description: 'Append text to the daily note for a date (default today), creating it from the configured template when missing.',
      inputSchema: z.object({ content: z.string().min(1), date: DateArg }),
      outputSchema: z.object({ path: z.string(), created: z.boolean() }),
      annotations: APPEND_ONLY,
    },
    ({ content, date }) =>
      guarded(tc.log, async () => {
        const { path, when } = resolve(date);
        let created = false;
        try {
          await adapter.read(path);
        } catch (error) {
          if (!(error instanceof VaultError && error.code === 'NOT_FOUND')) throw error;
          created = true;
          await adapter.write(path, daily.template ? renderDailyTemplate(daily.template, when, daily) : '');
        }
        await adapter.append(path, content);
        await touch(tc, path);
        return okJson({ path, created }, `${created ? 'Created and appended to' : 'Appended to'} ${path}.`);
      }),
  );
}
```

- [ ] **Step 5: Implement src/tools/analytics.ts**

```ts
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ANALYTICS_CATEGORIES, type AnalyticsReport, analyzeVault } from '../vault/analytics.ts';
import { READ_ONLY } from './annotations.ts';
import type { ToolContext } from './register.ts';
import { guarded, okJson } from './results.ts';

const CACHE_TTL_MS = 10 * 60 * 1000;

export function registerAnalyticsTools(server: McpServer, tc: ToolContext): void {
  const { adapter, settings, caches, now } = tc.runtime;

  async function report(refresh: boolean): Promise<AnalyticsReport> {
    const cached = caches.analytics;
    if (!refresh && cached && now().getTime() - cached.at < CACHE_TTL_MS) return cached.report;
    const fresh = await analyzeVault(adapter, { requiredFrontmatter: settings.requiredFrontmatter });
    caches.analytics = { at: now().getTime(), report: fresh };
    return fresh;
  }

  const CategorySummary = z.object({ count: z.number(), examples: z.array(z.string()) });

  server.registerTool(
    'vault_analytics_summary',
    {
      title: 'Vault health summary',
      description: 'Counts and examples of vault hygiene issues: notes without frontmatter, missing required frontmatter keys, broken wikilinks, inconsistent tag spellings, non-UTF-8 files and oversized files. Results are cached for 10 minutes unless refresh=true.',
      inputSchema: z.object({ refresh: z.boolean().optional() }),
      outputSchema: z.object({
        scannedFiles: z.number(),
        truncated: z.boolean(),
        categories: z.object(Object.fromEntries(ANALYTICS_CATEGORIES.map((c) => [c, CategorySummary]))),
      }),
      annotations: READ_ONLY,
    },
    ({ refresh }) =>
      guarded(tc.log, async () => {
        const { summary } = await report(refresh ?? false);
        return okJson({ ...summary });
      }),
  );

  server.registerTool(
    'vault_analytics_findings',
    {
      title: 'Vault health findings',
      description: `Detailed findings for one category: ${ANALYTICS_CATEGORIES.join(', ')}.`,
      inputSchema: z.object({
        category: z.enum(ANALYTICS_CATEGORIES),
        limit: z.number().int().min(1).max(100).optional(),
        refresh: z.boolean().optional(),
      }),
      outputSchema: z.object({
        category: z.string(),
        total: z.number(),
        findings: z.array(z.object({ category: z.string(), path: z.string(), detail: z.string() })),
      }),
      annotations: READ_ONLY,
    },
    ({ category, limit, refresh }) =>
      guarded(tc.log, async () => {
        const { findings } = await report(refresh ?? false);
        const matching = findings.filter((f) => f.category === category);
        return okJson({ category, total: matching.length, findings: matching.slice(0, limit ?? 100) });
      }),
  );
}
```

- [ ] **Step 6: Register the groups and run**

In `src/tools/register.ts`:
```ts
import { registerAnalyticsTools } from './analytics.ts';
import { registerCanvasTools } from './canvas.ts';
import { registerDailyTools } from './daily.ts';
// after registerManageTools(server, tc):
  registerCanvasTools(server, tc);
  registerDailyTools(server, tc);
  registerAnalyticsTools(server, tc);
```

Run: `npx vitest run tests/tools/ && npm run typecheck && npm run lint:fix`
Expected: PASS (all tool suites).

```bash
git add -A
git commit -m "feat(tools): canvas, daily-note and analytics tools"
```

---

### Task 15: Environment wiring (localfs backend), full-surface test, docs and Phase 1 acceptance

**Files:**
- Modify: `src/config.ts`, `src/main.ts`, `src/server.ts`, `.env.example`, `README.md`, `docs/plans/README.md`
- Test: `tests/config.test.ts` (extend), `tests/tools/surface.test.ts`

**Interfaces:**
- `Config` gains:
  ```ts
  storage: { backend: 'localfs'; vaultPath: string } | { backend: 'drive' };
  vaultSettings: { dailyNotes: { folder: string; format: string; template: string | null; timezone: string }; requiredFrontmatter: string[] };
  ```
  New env vars: `STORAGE_BACKEND` (`drive` default, `localfs`), `VAULT_PATH` (required when localfs), `DAILY_NOTES_FOLDER` (default `''`), `DAILY_NOTES_FORMAT` (default `yyyy-MM-dd`), `DAILY_NOTES_TEMPLATE` (optional), `VAULT_TIMEZONE` (default `UTC`, validated with `Intl.DateTimeFormat`), `REQUIRED_FRONTMATTER` (comma-separated, default empty).

- [ ] **Step 1: Extend the config tests**

Append to `tests/config.test.ts`:
```ts
describe('storage and vault settings', () => {
  it('defaults to the drive backend and UTC daily notes', () => {
    const cfg = loadConfig(base);
    expect(cfg.storage).toEqual({ backend: 'drive' });
    expect(cfg.vaultSettings).toEqual({
      dailyNotes: { folder: '', format: 'yyyy-MM-dd', template: null, timezone: 'UTC' },
      requiredFrontmatter: [],
    });
  });

  it('requires VAULT_PATH for localfs and parses vault settings', () => {
    expect(() => loadConfig({ ...base, STORAGE_BACKEND: 'localfs' })).toThrow(ConfigError);
    const cfg = loadConfig({
      ...base,
      STORAGE_BACKEND: 'localfs',
      VAULT_PATH: '/tmp/vault',
      DAILY_NOTES_FOLDER: 'journal',
      DAILY_NOTES_FORMAT: '%Y-%m-%d',
      DAILY_NOTES_TEMPLATE: '# {{title}}',
      VAULT_TIMEZONE: 'Europe/Chisinau',
      REQUIRED_FRONTMATTER: 'type, status',
    });
    expect(cfg.storage).toEqual({ backend: 'localfs', vaultPath: '/tmp/vault' });
    expect(cfg.vaultSettings).toEqual({
      dailyNotes: { folder: 'journal', format: '%Y-%m-%d', template: '# {{title}}', timezone: 'Europe/Chisinau' },
      requiredFrontmatter: ['type', 'status'],
    });
  });

  it('rejects an unknown timezone or backend', () => {
    expect(() => loadConfig({ ...base, VAULT_TIMEZONE: 'Mars/Olympus' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, STORAGE_BACKEND: 's3' })).toThrow(ConfigError);
  });
});
```

Run: `npx vitest run tests/config.test.ts` → the three new tests FAIL.

- [ ] **Step 2: Implement the config changes**

In `src/config.ts` extend `EnvSchema`:
```ts
  STORAGE_BACKEND: z.enum(['drive', 'localfs']).default('drive'),
  VAULT_PATH: z.string().min(1).optional(),
  DAILY_NOTES_FOLDER: z.string().default(''),
  DAILY_NOTES_FORMAT: z.string().min(1).default('yyyy-MM-dd'),
  DAILY_NOTES_TEMPLATE: z.string().optional(),
  VAULT_TIMEZONE: z.string().min(1).default('UTC'),
  REQUIRED_FRONTMATTER: z.string().default(''),
```
extend `Config`:
```ts
export type StorageConfig = { backend: 'localfs'; vaultPath: string } | { backend: 'drive' };
export interface VaultSettingsConfig {
  dailyNotes: { folder: string; format: string; template: string | null; timezone: string };
  requiredFrontmatter: string[];
}
// in Config:
  storage: StorageConfig;
  vaultSettings: VaultSettingsConfig;
```
and after the `mcpUrl` computation:
```ts
  const d = parsed.data;
  if (d.STORAGE_BACKEND === 'localfs' && !d.VAULT_PATH) {
    throw new ConfigError(['VAULT_PATH (required when STORAGE_BACKEND=localfs)'], []);
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: d.VAULT_TIMEZONE });
  } catch {
    throw new ConfigError([], ['VAULT_TIMEZONE (unknown IANA timezone)']);
  }
  const storage: StorageConfig =
    d.STORAGE_BACKEND === 'localfs' ? { backend: 'localfs', vaultPath: d.VAULT_PATH as string } : { backend: 'drive' };
  const vaultSettings: VaultSettingsConfig = {
    dailyNotes: {
      folder: d.DAILY_NOTES_FOLDER,
      format: d.DAILY_NOTES_FORMAT,
      template: d.DAILY_NOTES_TEMPLATE ?? null,
      timezone: d.VAULT_TIMEZONE,
    },
    requiredFrontmatter: d.REQUIRED_FRONTMATTER.split(',').map((s) => s.trim()).filter(Boolean),
  };
```
and return `storage, vaultSettings` in the object.

- [ ] **Step 3: Wire main.ts and server.ts**

`src/server.ts`: signature is `startServer(config, logger, resolveRuntime: RuntimeResolver, listenPort = config.port, opts: { drainMs?: number } = {})` (already changed in Task 12; keep the trailing opts) and passes `resolveRuntime` to `createApp`. Update `tests/server.test.ts` accordingly (build a temp local runtime like `tests/app.test.ts`).

`src/main.ts` — after `createLogger`:
```ts
import { createLocalRuntime } from './vault/runtime.ts';
// ...
  if (config.storage.backend !== 'localfs') {
    logger.fatal('STORAGE_BACKEND=drive is implemented in Phase 3. Set STORAGE_BACKEND=localfs and VAULT_PATH for now.');
    process.exit(1);
  }
  const runtime = await createLocalRuntime({ vaultPath: config.storage.vaultPath, settings: config.vaultSettings });
  logger.info({ vaultPath: config.storage.vaultPath, indexed: runtime.index.size() }, 'vault runtime ready');
  const running = await startServer(config, logger, async () => runtime);
  // in shutdown(): await runtime.close() before running.close()
```

`.env.example` — add:
```
STORAGE_BACKEND=localfs
VAULT_PATH=./vault-dev
DAILY_NOTES_FOLDER=journal
DAILY_NOTES_FORMAT=yyyy-MM-dd
# DAILY_NOTES_TEMPLATE=# {{title}}
VAULT_TIMEZONE=Europe/Chisinau
REQUIRED_FRONTMATTER=
```
and add `vault-dev/` to `.gitignore`.

- [ ] **Step 4: Full-surface test**

`tests/tools/surface.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.ts';

const EXPECTED = [
  'vault_read', 'vault_batch_read', 'vault_write', 'vault_write_binary', 'vault_edit', 'vault_append',
  'vault_batch_frontmatter_update', 'vault_search', 'vault_search_frontmatter', 'vault_list', 'vault_move',
  'vault_delete', 'vault_canvas_read', 'vault_canvas_add_node', 'vault_canvas_add_edge', 'vault_daily_note_path',
  'vault_daily_note_read', 'vault_daily_note_append', 'vault_analytics_summary', 'vault_analytics_findings',
];

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

describe('tool surface parity', () => {
  it('exposes exactly the 20 vault tools plus brainstem_ping, each with title, description and full annotations', async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED, 'brainstem_ping'].sort());
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(20);
      expect(tool.description?.length ?? 0, tool.name).toBeLessThan(600);
      for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        expect(typeof (tool.annotations as Record<string, unknown>)[key], `${tool.name}.${key}`).toBe('boolean');
      }
    }
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
    expect(readOnly).toEqual([
      'brainstem_ping', 'vault_analytics_findings', 'vault_analytics_summary', 'vault_batch_read', 'vault_canvas_read',
      'vault_daily_note_path', 'vault_daily_note_read', 'vault_list', 'vault_read', 'vault_search', 'vault_search_frontmatter',
    ]);
  });

  it('is deterministic across two listings (prompt-cache friendly)', async () => {
    const a = await h.client.listTools();
    const b = await h.client.listTools();
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
  });
});
```

- [ ] **Step 5: Run everything, dev smoke, Heroku config**

```bash
npm test && npm run typecheck && npm run lint:fix && npm run build
cp .env.example .env && npm run dev &   # then in another shell:
npx @modelcontextprotocol/inspector      # connect to http://localhost:3000/mcp, run vault_write then vault_read, vault_daily_note_append, vault_analytics_summary
```
Heroku is deferred (owner decision 2026-08-28): the acceptance environment is the local Docker Compose stack built in Task 16 — no Heroku commands in this task.

- [ ] **Step 6: Parity spot-check against the reference README (record in docs/plans/README.md)**

Compare, with the Inspector against the local server, the behavior of: `vault_edit` dry-run diff shape, `vault_delete` without confirm (error text mentions `.trash/` and `confirm=true`), `vault_daily_note_read` on a missing day (error, no creation), `vault_daily_note_append` template rendering, `vault_write_binary` rejecting `image/svg+xml`, `vault_search` cap at 50. Note any intentional deviations (literal search, timezone setting, `failed[]` in batch read, `refresh` flag on analytics) under "Phase 1 — deviations from reference".

- [ ] **Step 7: Docs and commit**

Update `README.md` with a "Tools" section listing the 20 tools grouped as in `docs/implementation-plan.md` §5 and the env vars added in this task; update `docs/plans/README.md` Phase 1 status to done with the date and the deviations list.

```bash
git add -A
git commit -m "feat: localfs backend wiring, env-driven vault settings, full tool-surface test and docs"
git push origin main
```

---

### Task 16: Local Docker Compose stack (app + Postgres) and smoke script

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `compose.yaml`, `scripts/docker-smoke.sh`
- Modify: `package.json` (scripts `docker:up`, `docker:down`, `docker:logs`, `docker:smoke`), `.gitignore` (`vault-dev/`), `README.md` (Run with Docker section)

**Interfaces:**
- Consumes: `dist/main.js` (Task 15 wiring: `STORAGE_BACKEND=localfs`, `VAULT_PATH`), `/health`, the 20 tools.
- Produces: `docker compose up --build` → server on `http://localhost:3000/mcp` with the vault bind-mounted at `./vault-dev`; a Postgres 17 service (unused until Phase 2, already wired with a healthcheck so Phase 2 only adds `DATABASE_URL`).

- [ ] **Step 1: Write Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends ripgrep ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /vault && chown -R node:node /vault /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD curl -fsS http://localhost:3000/health || exit 1
CMD ["node", "dist/main.js"]
```

`version.ts` reads `../package.json` relative to `dist/`, so `package.json` must be present in the runtime image (it is, copied for `npm ci`). `ripgrep` in the image makes `capabilities().nativeSearch` true inside Docker.

- [ ] **Step 2: Write .dockerignore**

```
node_modules
dist
.git
.superpowers
vault-dev
.env
.env.*
docs
tests
coverage
*.log
```

- [ ] **Step 3: Write compose.yaml**

```yaml
services:
  app:
    build: .
    user: "${UID:-1000}:${GID:-1000}"
    ports:
      - "3000:3000"
    environment:
      PUBLIC_URL: http://localhost:3000
      ALLOW_INSECURE_PUBLIC_URL: "true"
      PORT: "3000"
      LOG_LEVEL: info
      MCP_LEGACY_MODE: stateless
      STORAGE_BACKEND: localfs
      VAULT_PATH: /vault
      VAULT_TIMEZONE: Europe/Chisinau
      DAILY_NOTES_FOLDER: journal
      DAILY_NOTES_FORMAT: yyyy-MM-dd
      # Phase 2 adds: DATABASE_URL: postgres://brainstem:brainstem@postgres:5432/brainstem, ENCRYPTION_KEY, GOOGLE_CLIENT_ID/SECRET
    volumes:
      - ./vault-dev:/vault
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped

  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: brainstem
      POSTGRES_PASSWORD: brainstem
      POSTGRES_DB: brainstem
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U brainstem -d brainstem"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  pgdata:
```

`user:` maps the container to the host uid/gid so files written into `./vault-dev` are owned by you (export `UID`/`GID` in your shell if they are not 1000; `id -u`/`id -g`).

- [ ] **Step 4: Write scripts/docker-smoke.sh**

```bash
#!/usr/bin/env bash
# End-to-end smoke against the compose stack: health, tool list, write → read → file on disk.
set -euo pipefail
BASE="${BASE_URL:-http://localhost:3000}"
INSPECTOR=(npx -y @modelcontextprotocol/inspector --cli "$BASE/mcp")

echo "[1/4] health"; curl -fsS "$BASE/health" | grep -q '"status":"ok"'
echo "[2/4] tools/list has 20 vault tools"
COUNT=$("${INSPECTOR[@]}" --method tools/list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tools.filter(t=>t.name.startsWith("vault_")).length))')
[ "$COUNT" = "20" ] || { echo "expected 20 vault tools, got $COUNT"; exit 1; }
echo "[3/4] vault_write then vault_read"
"${INSPECTOR[@]}" --method tools/call --tool-name vault_write --tool-arg path=00-inbox/smoke.md --tool-arg content=$'---\ntype: smoke\n---\n# Smoke\n' >/dev/null
"${INSPECTOR[@]}" --method tools/call --tool-name vault_read --tool-arg path=00-inbox/smoke.md | grep -q '"type":"smoke"'
echo "[4/4] file landed in ./vault-dev"; test -f vault-dev/00-inbox/smoke.md
echo "docker smoke OK"
```

`chmod +x scripts/docker-smoke.sh`.

- [ ] **Step 5: npm scripts, .gitignore, README**

```bash
npm pkg set scripts.docker:up="docker compose up -d --build"
npm pkg set scripts.docker:down="docker compose down"
npm pkg set scripts.docker:logs="docker compose logs -f app"
npm pkg set scripts.docker:smoke="bash scripts/docker-smoke.sh"
printf 'vault-dev/\n' >> .gitignore
```

README `## Run with Docker` section:
```markdown
## Run with Docker (local acceptance environment)

```bash
mkdir -p vault-dev
npm run docker:up        # builds the image, starts app (:3000) + postgres (:5432)
npm run docker:smoke     # health, tools/list, write→read, file visible in ./vault-dev
npm run docker:logs
npm run docker:down
```

The vault is the bind-mounted `./vault-dev` folder — open it in Obsidian to see notes Claude writes. Postgres is idle until Phase 2 (auth).
```

- [ ] **Step 6: Verify**

```bash
mkdir -p vault-dev && npm run docker:up && sleep 8 && docker compose ps && npm run docker:smoke && npm run docker:down
```
Expected: both services `healthy`/`running`; smoke prints `docker smoke OK`; `vault-dev/00-inbox/smoke.md` exists on the host and is owned by your user. Biome must ignore `Dockerfile`/`compose.yaml`/`scripts/*.sh` (not in `files.includes`); `npm run lint` stays pristine.

- [ ] **Step 7: Commit**

```bash
git add Dockerfile .dockerignore compose.yaml scripts/docker-smoke.sh package.json .gitignore README.md
git commit -m "feat(docker): compose stack (app + postgres) with bind-mounted vault and smoke script"
```

---

## Phase 1 exit checklist

- [x] `npm test` green: storage (limits, path-policy, frontmatter, text-diff, local-fs core + nav), vault (index, daily, canvas, analytics, runtime), tools (results, read-write, search-manage, canvas-daily-analytics, surface), plus Phase 0 suites. Confirmed 2026-08-28 with the final fix wave applied (139 tests, 0 skipped, `rg` installed locally for this run).
- [x] `surface.test.ts` proves exactly 20 vault tools + `brainstem_ping`, all with title/description/4 annotations, deterministic order.
- [x] Inspector session against `npm run dev` (2026-08-28, controller, Inspector CLI mode): write → edit dry-run (`applied: 1`) → append → daily append (`journal/2026-08-28.md`, `created: true`) → analytics summary → `vault_delete` without confirm returns `CONFIRM_REQUIRED` → with confirm lands in `.trash/`.
- [x] Ripgrep suite executed at least once locally (`rg` installed) and equal to the JS fallback. Re-verified during the final fix wave with a locally-installed `rg` 14.1.1: all 16 nav-suite tests (including the new symlink-prefix, streaming-limit and `.gitignore` cases) pass unskipped. The suite also now runs unconditionally in CI (`.github/workflows/ci.yml` installs ripgrep via `apt-get` before `npm test`), so this no longer depends on the local dev machine having `rg`.
- [x] `docker compose up --build` (2026-08-28, controller): `/health` ok, `npm run docker:smoke` passes all 5 steps incl. `vault_search` (ripgrep inside the image), note visible in `./vault-dev`; `docker compose down` clean.
- [x] Parity deviations recorded in `docs/plans/README.md`. See also the new "Phase 1 — final fix wave" section there for what the final-review fix wave changed and what it deliberately deferred.
