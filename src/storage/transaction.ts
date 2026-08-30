import { randomBytes } from 'node:crypto';
import { promises as fs, constants as fsConstants, type Stats } from 'node:fs';
import path from 'node:path';
import { sha256hex } from '../auth/hash.ts';
import {
  applyFrontmatterUpdate,
  joinFrontmatter,
  mergeFrontmatter,
  splitFrontmatter,
} from './frontmatter.ts';
import { assertWithinSize } from './limits.ts';
import { isMarkdownPath, normalizeVaultPath } from './path-policy.ts';
import { applyTextPatches, unifiedDiff } from './text-diff.ts';
import { type StorageAdapter, type TextPatch, VaultError } from './types.ts';
import { assertExpectedHash, type WriteGate } from './write-gate.ts';

/** Ops per transaction. */
export const MAX_TX_OPS = 20;
/** Distinct files a single transaction may touch (a move counts its source and destination). */
export const MAX_TX_FILES = 20;

export type TxOp =
  | {
      op: 'write';
      path: string;
      content: string;
      mergeFrontmatter?: boolean;
      expectedHash?: string;
    }
  | { op: 'edit'; path: string; patches: TextPatch[]; expectedHash?: string }
  | { op: 'append'; path: string; content: string; expectedHash?: string }
  | {
      op: 'frontmatter_update';
      path: string;
      set?: Record<string, unknown>;
      unset?: string[];
      expectedHash?: string;
    }
  | { op: 'move'; from: string; to: string; expectedHash?: string }
  | { op: 'delete'; path: string; confirm: boolean; expectedHash?: string };

export interface TxOpResult {
  index: number;
  op: TxOp['op'];
  /** The op passed pre-flight (and, for an applied transaction, was written). */
  ok: boolean;
  error?: string;
  /** Unified diff of what the op would change. Only produced for `dryRun`. */
  diff?: string;
  /** Content hash of the op's target after the op. Only produced for an applied transaction. */
  hash?: string;
}

export interface TxResult {
  id: string;
  applied: boolean;
  dryRun: boolean;
  /** The vault was restored to its pre-transaction state. False when `journal` is set. */
  rolledBack: boolean;
  results: TxOpResult[];
  /** Every path the transaction touched, sorted — the caller re-indexes these. */
  touched: string[];
  /** Journal directory left on disk because the rollback (or its cleanup) did not finish. */
  journal?: string;
}

export interface TxDeps {
  adapter: StorageAdapter;
  gate: WriteGate;
  /** Absolute path of the vault root — journal pre-images are copied from and back to it. */
  vaultRoot: string;
  /** Absolute path of the reserved state directory (`<vault>/_brainstem`); journals live in `tx/`. */
  stateDir: string;
  now?: () => Date;
}

interface JournalEntry {
  path: string;
  file: string;
  hash: string | null;
}

/**
 * Lifecycle of a journal directory. `applying` is written before the first mutation and flipped
 * to a terminal state *before* the directory is removed, so a journal that outlives its
 * transaction (a failed `rm`, a sync client holding the folder) still says whether the batch
 * committed. Without it a leftover directory is ambiguous, and restoring the pre-images of a
 * committed batch is the one way this design can lose data.
 */
export type TxJournalState = 'applying' | 'applied' | 'rolled-back';

export interface JournalStatus {
  state: TxJournalState | 'unknown';
  id: string | null;
  startedAt: string | null;
  /** The pre-images may be the only copy of the originals — the owner has to look at them. */
  needsRestore: boolean;
  /** Ready-made advice for the boot log. */
  message: string;
}

/**
 * Classifies a leftover journal from the raw text of its `manifest.json` (`null` when it could
 * not be read). Pure, so the boot scan in main.ts — which has no test harness — stays four lines.
 * Anything unreadable is treated as unfinished: over-warning is cheap, under-warning is not.
 */
export function classifyJournal(manifestJson: string | null): JournalStatus {
  let parsed: unknown;
  try {
    parsed = manifestJson === null ? null : JSON.parse(manifestJson);
  } catch {
    parsed = null;
  }
  const record =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  const id = typeof record?.id === 'string' ? record.id : null;
  const startedAt = typeof record?.startedAt === 'string' ? record.startedAt : null;
  const raw = record?.state;
  const state: TxJournalState | 'unknown' =
    raw === 'applying' || raw === 'applied' || raw === 'rolled-back' ? raw : 'unknown';
  switch (state) {
    case 'applied':
      return {
        state,
        id,
        startedAt,
        needsRestore: false,
        message:
          'the transaction completed — this folder is a leftover copy that is safe to delete; restoring its pre-images would revert changes that were committed',
      };
    case 'rolled-back':
      return {
        state,
        id,
        startedAt,
        needsRestore: false,
        message:
          'the transaction was rolled back — the vault already holds this content, so the folder is safe to delete',
      };
    case 'applying':
      return {
        state,
        id,
        startedAt,
        needsRestore: true,
        message:
          'the server stopped while applying this transaction — the pre-images here are the originals of the files it was part-way through writing',
      };
    default:
      return {
        state,
        id,
        startedAt,
        needsRestore: true,
        message:
          'the manifest is missing or unreadable — treat it as unfinished and inspect the pre-images before deleting anything',
      };
  }
}

/** What pre-flight computed for one op: the diff it would produce and the resulting hash. */
interface Plan {
  diff: string;
  hash: string | null;
}

/** Simulated content of one path during pre-flight. */
interface FileState {
  exists: boolean;
  /** Decoded text, or null when the file does not exist or is not UTF-8 text (an attachment). */
  content: string | null;
  hash: string | null;
}

function byteLen(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function absOf(vaultRoot: string, vaultPath: string): string {
  return path.join(vaultRoot, ...vaultPath.split('/'));
}

/** Every vault path an op touches, normalized (throws `INVALID_PATH` for anything unreachable). */
function pathsOf(op: TxOp): string[] {
  return op.op === 'move'
    ? [normalizeVaultPath(op.from), normalizeVaultPath(op.to)]
    : [normalizeVaultPath(op.path)];
}

/**
 * Frontmatter split that never throws, mirroring `LocalFSAdapter.toNote`: a note with invalid
 * YAML is treated as body-only, exactly as `read`/`batchFrontmatterUpdate` see it.
 */
function splitLenient(
  p: string,
  content: string,
): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  if (!isMarkdownPath(p)) return { frontmatter: {}, body: content };
  try {
    const split = splitFrontmatter(content);
    return { frontmatter: split.frontmatter, body: split.body };
  } catch (error) {
    if (error instanceof VaultError) return { frontmatter: {}, body: content };
    throw error;
  }
}

function describeError(error: unknown): string {
  if (error instanceof VaultError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** `<ISO compact>-<6 hex>`, e.g. `20260830T121314123Z-9f2ab1`. */
function txId(at: Date): string {
  return `${at.toISOString().replace(/[-:.]/g, '')}-${randomBytes(3).toString('hex')}`;
}

/**
 * `<stateDir>/tx/<id>`, with a hard guard that the directory really is one level below the
 * state dir's `tx/` folder — the journal must never be able to escape `_brainstem/`.
 */
function journalDir(stateDir: string, id: string): string {
  const txRoot = path.resolve(stateDir, 'tx');
  const dir = path.resolve(txRoot, id);
  if (path.dirname(dir) !== txRoot || path.basename(dir) !== id) {
    throw new VaultError('IO', 'Refusing to write a transaction journal outside the state dir.');
  }
  return dir;
}

/**
 * Runs `ops` as one all-or-nothing unit.
 *
 * Order: lock every touched path (once, sorted) → pre-flight the whole batch in memory → journal
 * the pre-images → apply through the adapter → drop the journal. Any failure while applying rolls
 * every touched file back to its pre-image; if that rollback cannot finish, the journal is left in
 * place and returned in `journal` so the owner still has every original byte.
 *
 * Pre-flight simulates the ops in order, so two ops on the same path compose (op 2 sees op 1's
 * result). `expectedHash` is therefore checked against the *simulated* state, which for the first
 * op touching a path is exactly the on-disk state; a second op on the same path must carry the
 * hash op 1 produces, not the stale on-disk one.
 *
 * Ops are applied through the adapter *without* `expectedHash`: it was already verified under the
 * same lock, and re-checking would only compare against the value pre-flight simulated anyway.
 */
export async function runTransaction(
  deps: TxDeps,
  ops: TxOp[],
  opts: { dryRun?: boolean } = {},
): Promise<TxResult> {
  const { adapter, gate, vaultRoot, stateDir } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const dryRun = opts.dryRun === true;

  if (!Array.isArray(ops) || ops.length === 0) {
    throw new VaultError('INVALID_INPUT', 'A transaction needs at least one op.');
  }
  if (ops.length > MAX_TX_OPS) {
    throw new VaultError(
      'INVALID_INPUT',
      `A transaction runs at most ${MAX_TX_OPS} ops (got ${ops.length}).`,
    );
  }
  // Normalizing here (before the lock) means an unreachable path — `_brainstem/`, a dot folder,
  // traversal — fails the whole call with INVALID_PATH instead of becoming a per-op result.
  const touched = [...new Set(ops.flatMap(pathsOf))].sort();
  if (touched.length > MAX_TX_FILES) {
    throw new VaultError(
      'INVALID_INPUT',
      `A transaction touches at most ${MAX_TX_FILES} files (got ${touched.length}).`,
    );
  }

  const startedAt = now();
  const id = txId(startedAt);
  const results: TxOpResult[] = ops.map((op, index) => ({ index, op: op.op, ok: false }));

  return await gate.withLock(touched, async () => {
    const states = new Map<string, FileState>();
    /** On-disk state of each path when the transaction started — drives the journal. */
    const onDisk = new Map<string, { existed: boolean; hash: string | null }>();

    async function load(p: string): Promise<FileState> {
      const cached = states.get(p);
      if (cached) return cached;
      let stat: Stats | null = null;
      try {
        stat = await fs.stat(absOf(vaultRoot, p));
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') {
          throw new VaultError('IO', `Could not stat ${p}.`);
        }
      }
      if (stat?.isDirectory()) {
        throw new VaultError(
          'INVALID_INPUT',
          `${p} is a folder; a transaction only operates on single files.`,
        );
      }
      let state: FileState;
      if (stat === null) {
        state = { exists: false, content: null, hash: null };
      } else {
        try {
          const note = await adapter.read(p);
          state = { exists: true, content: note.content, hash: note.hash };
        } catch (error) {
          // An attachment (not UTF-8 text) still has a hash — over its raw bytes — so it can be
          // moved, deleted and hash-checked inside a transaction; only the text ops refuse it.
          if (!(error instanceof VaultError && error.code === 'ENCODING')) throw error;
          state = { exists: true, content: null, hash: await adapter.hashOf(p) };
        }
      }
      states.set(p, state);
      onDisk.set(p, { existed: state.exists, hash: state.hash });
      return state;
    }

    async function requireText(p: string): Promise<FileState & { content: string }> {
      const state = await load(p);
      if (!state.exists) throw new VaultError('NOT_FOUND', `${p} does not exist.`);
      if (state.content === null) throw new VaultError('ENCODING', `${p} is not valid UTF-8 text.`);
      return { ...state, content: state.content };
    }

    function produce(p: string, before: string | null, next: string): Plan {
      const hash = sha256hex(next);
      states.set(p, { exists: true, content: next, hash });
      return { diff: unifiedDiff(p, before ?? '', next), hash };
    }

    async function simulate(op: TxOp): Promise<Plan> {
      switch (op.op) {
        case 'write': {
          const p = normalizeVaultPath(op.path);
          const cur = await load(p);
          assertExpectedHash(p, cur.hash, op.expectedHash);
          assertWithinSize(byteLen(op.content), 'Content');
          let next = op.content;
          if (op.mergeFrontmatter === true && isMarkdownPath(p)) {
            if (cur.exists && cur.content === null) {
              throw new VaultError('ENCODING', `${p} is not valid UTF-8 text.`);
            }
            const incoming = splitFrontmatter(op.content);
            const existing = cur.content === null ? {} : splitLenient(p, cur.content).frontmatter;
            next = joinFrontmatter(mergeFrontmatter(existing, incoming.frontmatter), incoming.body);
            assertWithinSize(byteLen(next), 'Merged content');
          }
          return produce(p, cur.content, next);
        }
        case 'edit': {
          const p = normalizeVaultPath(op.path);
          const cur = await requireText(p);
          assertExpectedHash(p, cur.hash, op.expectedHash);
          const { content } = applyTextPatches(cur.content, op.patches);
          assertWithinSize(byteLen(content), 'Edited content');
          return produce(p, cur.content, content);
        }
        case 'append': {
          const p = normalizeVaultPath(op.path);
          const cur = await load(p);
          if (cur.exists && cur.content === null) {
            throw new VaultError('ENCODING', `${p} is not valid UTF-8 text.`);
          }
          assertExpectedHash(p, cur.hash, op.expectedHash);
          const existing = cur.content ?? '';
          const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
          const suffix = op.content.endsWith('\n') ? '' : '\n';
          const next = `${existing}${separator}${op.content}${suffix}`;
          assertWithinSize(byteLen(next), 'Appended content');
          return produce(p, cur.content, next);
        }
        case 'frontmatter_update': {
          const p = normalizeVaultPath(op.path);
          if (!isMarkdownPath(p)) {
            throw new VaultError('INVALID_INPUT', `${p} is not a markdown file.`);
          }
          const cur = await requireText(p);
          assertExpectedHash(p, cur.hash, op.expectedHash);
          const { frontmatter, body } = splitLenient(p, cur.content);
          const next = joinFrontmatter(applyFrontmatterUpdate(frontmatter, op.set, op.unset), body);
          assertWithinSize(byteLen(next), 'Updated content');
          return produce(p, cur.content, next);
        }
        case 'move': {
          const from = normalizeVaultPath(op.from);
          const to = normalizeVaultPath(op.to);
          if (from === to) {
            throw new VaultError(
              'INVALID_INPUT',
              'move needs a destination different from "from".',
            );
          }
          const src = await load(from);
          const dst = await load(to);
          if (!src.exists) throw new VaultError('NOT_FOUND', `${from} does not exist.`);
          // "Must not exist" covers both the on-disk state and a file an earlier op in this same
          // transaction produced — a move never overwrites, inside a transaction or outside it.
          if (dst.exists) throw new VaultError('ALREADY_EXISTS', `${to} already exists.`);
          assertExpectedHash(from, src.hash, op.expectedHash);
          states.set(to, { ...src });
          states.set(from, { exists: false, content: null, hash: null });
          return { diff: '', hash: src.hash };
        }
        case 'delete': {
          const p = normalizeVaultPath(op.path);
          if (op.confirm !== true) {
            throw new VaultError(
              'CONFIRM_REQUIRED',
              'Deletion requires confirm=true. The file is moved to .trash/ (not erased) and can be restored manually.',
            );
          }
          const cur = await load(p);
          if (!cur.exists) throw new VaultError('NOT_FOUND', `${p} does not exist.`);
          assertExpectedHash(p, cur.hash, op.expectedHash);
          states.set(p, { exists: false, content: null, hash: null });
          return { diff: '', hash: null };
        }
      }
    }

    async function apply(op: TxOp): Promise<void> {
      switch (op.op) {
        case 'write':
          await adapter.write(normalizeVaultPath(op.path), op.content, {
            mergeFrontmatter: op.mergeFrontmatter ?? false,
          });
          return;
        case 'edit':
          await adapter.edit(normalizeVaultPath(op.path), op.patches, false);
          return;
        case 'append':
          await adapter.append(normalizeVaultPath(op.path), op.content);
          return;
        case 'frontmatter_update': {
          const p = normalizeVaultPath(op.path);
          // batchFrontmatterUpdate collects per-item errors instead of throwing; a transaction
          // needs the failure, so turn an empty `updated` back into a throw.
          const result = await adapter.batchFrontmatterUpdate([
            { path: p, set: op.set, unset: op.unset },
          ]);
          if (result.updated.length === 0) {
            throw new VaultError(
              'IO',
              result.failed[0]?.error ?? `Failed to update frontmatter on ${p}.`,
            );
          }
          return;
        }
        case 'move':
          await adapter.move(normalizeVaultPath(op.from), normalizeVaultPath(op.to));
          return;
        case 'delete':
          await adapter.softDelete(normalizeVaultPath(op.path), op.confirm);
          return;
      }
    }

    // ---- pre-flight ------------------------------------------------------
    const plans: Plan[] = [];
    for (const [index, op] of ops.entries()) {
      try {
        const plan = await simulate(op);
        plans.push(plan);
        const entry = results[index] as TxOpResult;
        entry.ok = true;
        if (dryRun) entry.diff = plan.diff;
      } catch (error) {
        (results[index] as TxOpResult).error = describeError(error);
        for (const later of results.slice(index + 1)) {
          later.error = `not attempted (op #${index + 1} failed)`;
        }
        return { id, applied: false, dryRun, rolledBack: false, results, touched };
      }
    }
    if (dryRun) return { id, applied: false, dryRun: true, rolledBack: false, results, touched };

    // ---- journal ---------------------------------------------------------
    const dir = journalDir(stateDir, id);
    const preImages: JournalEntry[] = [];
    const created: string[] = [];
    await fs.mkdir(dir, { recursive: true });
    for (const p of touched) {
      // Every touched path was loaded during pre-flight; load() is cached, so this only ever
      // runs for a path some future op kind might not have needed to read.
      if (!onDisk.has(p)) await load(p);
      const before = onDisk.get(p);
      if (before?.existed !== true) {
        created.push(p);
        continue;
      }
      const file = `${String(preImages.length + 1).padStart(4, '0')}.bin`;
      // A plain copy, never a hard link: the adapter writes through tmp+rename, so a link would
      // survive as the *old* inode here only by luck. COPYFILE_EXCL keeps a stale journal file
      // from ever being reused silently.
      await fs.copyFile(absOf(vaultRoot, p), path.join(dir, file), fsConstants.COPYFILE_EXCL);
      preImages.push({ path: p, file, hash: before.hash });
    }
    /**
     * Writes the manifest through tmp+rename so the state flip is atomic: a half-written manifest
     * would read back as `unknown` and send the owner looking for originals to restore, which for
     * a committed transaction is exactly the wrong advice.
     */
    async function writeManifest(state: TxJournalState): Promise<void> {
      const body = `${JSON.stringify(
        {
          id,
          startedAt: startedAt.toISOString(),
          state,
          vaultRoot,
          touched,
          created,
          preimages: preImages,
          ops,
        },
        null,
        2,
      )}\n`;
      const tmp = path.join(dir, 'manifest.json.tmp');
      await fs.writeFile(tmp, body);
      await fs.rename(tmp, path.join(dir, 'manifest.json'));
    }

    await writeManifest('applying');

    /** Restores every touched path to the state the journal recorded. */
    async function rollback(): Promise<{ ok: true } | { ok: false; error: unknown }> {
      try {
        // Not an op-by-op inverse: every touched path is simply put back the way the journal
        // found it, which is why a `move a→b` followed by an `edit b` still restores a's original
        // bytes (undoing the rename instead would resurrect the edited content under a's name).
        // The entries are distinct paths, so their order among themselves does not matter; only
        // content-before-cleanup does, so that a half-finished rollback has already restored the
        // bytes that existed before.
        for (const pre of preImages) {
          const target = absOf(vaultRoot, pre.path);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.copyFile(path.join(dir, pre.file), target);
        }
        for (const p of created) {
          try {
            await adapter.hardDelete(p);
          } catch (error) {
            // Never created after all (the transaction failed before that op).
            if (!(error instanceof VaultError && error.code === 'NOT_FOUND')) throw error;
          }
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, error };
      }
    }

    /**
     * Records how the transaction ended, then removes the journal. The state is flipped *first*
     * and durably: if the removal fails (a sync client holding the folder, EBUSY), what is left
     * behind still says "this batch committed / was undone — do not restore me".
     */
    async function closeJournal(state: TxJournalState): Promise<boolean> {
      try {
        await writeManifest(state);
      } catch {
        // Best effort: removing the directory below settles it just as well.
      }
      try {
        await fs.rm(dir, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    }

    // ---- apply -----------------------------------------------------------
    for (const [index, op] of ops.entries()) {
      try {
        await apply(op);
      } catch (error) {
        const entry = results[index] as TxOpResult;
        entry.ok = false;
        entry.error = describeError(error);
        for (const later of results.slice(index + 1)) {
          later.ok = false;
          later.error = `not attempted (op #${index + 1} failed)`;
        }
        const undo = await rollback();
        if (undo.ok) {
          const dropped = await closeJournal('rolled-back');
          return {
            id,
            applied: false,
            dryRun: false,
            rolledBack: true,
            results,
            touched,
            ...(dropped ? {} : { journal: dir }),
          };
        }
        entry.error = `${entry.error} — rollback failed (${describeError(undo.error)}); the pre-images of transaction ${id} are kept in ${dir}`;
        return {
          id,
          applied: false,
          dryRun: false,
          rolledBack: false,
          results,
          touched,
          journal: dir,
        };
      }
    }

    for (const [index, plan] of plans.entries()) {
      if (plan.hash !== null) (results[index] as TxOpResult).hash = plan.hash;
    }
    const dropped = await closeJournal('applied');
    return {
      id,
      applied: true,
      dryRun: false,
      rolledBack: false,
      results,
      touched,
      // Nothing failed, but the journal is still on disk: surface it so it is not mistaken for
      // a crashed transaction the next time the server boots.
      ...(dropped ? {} : { journal: dir }),
    };
  });
}
