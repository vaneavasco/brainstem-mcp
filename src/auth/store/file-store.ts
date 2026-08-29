import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  type ClientRecord,
  type CodeRecord,
  type PendingRecord,
  StoreCorruptError,
  type TokenRecord,
  type TokenStore,
} from './types.ts';

const Client = z
  .object({
    clientId: z.string(),
    clientName: z.string(),
    redirectUris: z.array(z.string()),
    fetchedAt: z.number(),
    expiresAt: z.number(),
    negative: z.literal(true).optional(),
  })
  .strict();

const Pending = z
  .object({
    id: z.string(),
    clientId: z.string(),
    clientName: z.string(),
    redirectUri: z.string(),
    codeChallenge: z.string(),
    resource: z.string(),
    scope: z.string(),
    state: z.string(),
    nonce: z.string(),
    expiresAt: z.number(),
    loopbackOnly: z.boolean(),
  })
  .strict();

const Code = z
  .object({
    pendingId: z.string(),
    clientId: z.string(),
    clientName: z.string(),
    redirectUri: z.string(),
    codeChallenge: z.string(),
    resource: z.string(),
    scope: z.string(),
    expiresAt: z.number(),
    usedAt: z.number().optional(),
  })
  .strict();

const Token = z
  .object({
    kind: z.enum(['access', 'refresh']),
    familyId: z.string(),
    clientId: z.string(),
    clientName: z.string(),
    resource: z.string(),
    scope: z.string(),
    expiresAt: z.number(),
    rotatedAt: z.number().optional(),
    revokedAt: z.number().optional(),
    lastUsedAt: z.number().optional(),
  })
  .strict();

const Doc = z
  .object({
    version: z.literal(1),
    clients: z.record(z.string(), Client),
    pending: z.record(z.string(), Pending),
    codes: z.record(z.string(), Code),
    tokens: z.record(z.string(), Token),
  })
  .strict();

type Doc = z.infer<typeof Doc>;

const EMPTY: Doc = { version: 1, clients: {}, pending: {}, codes: {}, tokens: {} };

interface Stamp {
  mtimeMs: number;
  size: number;
}

/**
 * Single-user OAuth state persisted as one JSON file inside the vault
 * (`<vault>/_brainstem/state.json`). Every mutation runs through a private
 * promise queue so concurrent callers never interleave writes, and every
 * read (and each queued mutation, before it applies) re-`stat`s the file so
 * an external rewrite (Obsidian Sync, Syncthing, another process) is picked
 * up instead of silently overwritten.
 */
export class FileTokenStore implements TokenStore {
  private readonly filePath: string;
  private doc: Doc;
  private stamp: Stamp;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(filePath: string, doc: Doc, stamp: Stamp) {
    this.filePath = filePath;
    this.doc = doc;
    this.stamp = stamp;
  }

  static async open(filePath: string): Promise<FileTokenStore> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    let text: string | null = null;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (text === null) {
      await writeAtomic(filePath, EMPTY);
      const st = await fs.stat(filePath);
      return new FileTokenStore(filePath, structuredClone(EMPTY), {
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
    }
    const doc = parseDoc(filePath, text);
    const st = await fs.stat(filePath);
    return new FileTokenStore(filePath, doc, { mtimeMs: st.mtimeMs, size: st.size });
  }

  private async reloadIfChanged(): Promise<void> {
    const st = await fs.stat(this.filePath).catch(() => null);
    if (!st) return;
    if (st.mtimeMs !== this.stamp.mtimeMs || st.size !== this.stamp.size) {
      this.doc = parseDoc(this.filePath, await fs.readFile(this.filePath, 'utf8'));
      this.stamp = { mtimeMs: st.mtimeMs, size: st.size };
    }
  }

  private mutate<T>(fn: (doc: Doc) => T): Promise<T> {
    const run = async (): Promise<T> => {
      await this.reloadIfChanged();
      const snapshot = structuredClone(this.doc);
      try {
        const result = fn(this.doc);
        await writeAtomic(this.filePath, this.doc);
        const st = await fs.stat(this.filePath);
        this.stamp = { mtimeMs: st.mtimeMs, size: st.size };
        return result;
      } catch (err) {
        // The mutation was applied to `this.doc` in place but never (successfully)
        // persisted — roll back so a failed write can't silently ride along with
        // the next successful one.
        this.doc = snapshot;
        throw err;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async getClient(clientId: string): Promise<ClientRecord | undefined> {
    await this.reloadIfChanged();
    return this.doc.clients[clientId];
  }

  putClient(rec: ClientRecord): Promise<void> {
    return this.mutate((doc) => {
      doc.clients[rec.clientId] = rec;
    });
  }

  putPending(rec: PendingRecord): Promise<void> {
    return this.mutate((doc) => {
      doc.pending[rec.id] = rec;
    });
  }

  async getPending(id: string): Promise<PendingRecord | undefined> {
    await this.reloadIfChanged();
    return this.doc.pending[id];
  }

  deletePending(id: string): Promise<void> {
    return this.mutate((doc) => {
      delete doc.pending[id];
    });
  }

  putCode(hash: string, rec: CodeRecord): Promise<void> {
    return this.mutate((doc) => {
      doc.codes[hash] = rec;
    });
  }

  consumeCode(hash: string, now: number): Promise<CodeRecord | undefined> {
    return this.mutate((doc) => {
      const rec = doc.codes[hash];
      if (!rec || rec.usedAt !== undefined || rec.expiresAt <= now) return undefined;
      rec.usedAt = now;
      return { ...rec };
    });
  }

  putToken(hash: string, rec: TokenRecord): Promise<void> {
    return this.mutate((doc) => {
      doc.tokens[hash] = rec;
    });
  }

  async getToken(hash: string): Promise<TokenRecord | undefined> {
    await this.reloadIfChanged();
    return this.doc.tokens[hash];
  }

  updateToken(hash: string, patch: Partial<TokenRecord>): Promise<void> {
    return this.mutate((doc) => {
      const rec = doc.tokens[hash];
      if (rec) Object.assign(rec, patch);
    });
  }

  /** Returns the number of tokens newly revoked by this call. */
  revokeFamily(familyId: string, now: number): Promise<number> {
    return this.mutate((doc) => {
      let count = 0;
      for (const rec of Object.values(doc.tokens)) {
        if (rec.familyId === familyId && rec.revokedAt === undefined) {
          rec.revokedAt = now;
          count++;
        }
      }
      return count;
    });
  }

  /**
   * Returns the number of tokens that are in revoked state after the call
   * (already-revoked tokens are included; their `revokedAt` is never
   * overwritten). Also clears pending authorizations and codes.
   */
  revokeAll(now: number): Promise<number> {
    return this.mutate((doc) => {
      let count = 0;
      for (const rec of Object.values(doc.tokens)) {
        if (rec.revokedAt === undefined) rec.revokedAt = now;
        count++;
      }
      doc.codes = {};
      doc.pending = {};
      return count;
    });
  }

  sweepExpired(now: number): Promise<void> {
    return this.mutate((doc) => {
      for (const [k, v] of Object.entries(doc.pending)) {
        if (v.expiresAt <= now) delete doc.pending[k];
      }
      for (const [k, v] of Object.entries(doc.codes)) {
        if (v.expiresAt <= now || v.usedAt !== undefined) delete doc.codes[k];
      }
      for (const [k, v] of Object.entries(doc.tokens)) {
        if (v.expiresAt <= now) delete doc.tokens[k];
      }
      for (const [k, v] of Object.entries(doc.clients)) {
        if (v.negative && v.expiresAt <= now) delete doc.clients[k];
      }
    });
  }
}

export { StoreCorruptError };

function parseDoc(filePath: string, text: string): Doc {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new StoreCorruptError(filePath, 'not valid JSON');
  }
  const parsed = Doc.safeParse(json);
  if (!parsed.success) {
    const version = (json as { version?: unknown } | null)?.version;
    const reason =
      typeof version === 'number' && version > 1
        ? `written by a newer version (${version})`
        : 'unexpected shape';
    throw new StoreCorruptError(filePath, reason);
  }
  return parsed.data;
}

async function writeAtomic(filePath: string, doc: Doc): Promise<void> {
  // Unique per write (pid + random suffix) so two FileTokenStore instances on
  // the same file — the running server and, e.g., a future `revoke-all` CLI —
  // can't race each other's rename with a shared `<file>.tmp` name.
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, filePath);
}
