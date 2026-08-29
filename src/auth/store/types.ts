export interface ClientRecord {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  fetchedAt: number;
  expiresAt: number;
  negative?: true;
}

export interface PendingRecord {
  id: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  state: string;
  nonce: string;
  expiresAt: number;
  loopbackOnly: boolean;
}

/**
 * Self-contained: carries its own copy of the binding fields from the
 * `PendingRecord` it was minted from, so the code stays valid (and its
 * PKCE/redirect binding checkable) even after that pending row is deleted.
 * `pendingId` is kept only for tracing back to the original request.
 */
export interface CodeRecord {
  pendingId: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  expiresAt: number;
  usedAt?: number;
}

export interface TokenRecord {
  kind: 'access' | 'refresh';
  familyId: string;
  clientId: string;
  clientName: string;
  resource: string;
  scope: string;
  expiresAt: number;
  rotatedAt?: number;
  revokedAt?: number;
  lastUsedAt?: number;
}

export interface TokenStore {
  getClient(clientId: string): Promise<ClientRecord | undefined>;
  putClient(rec: ClientRecord): Promise<void>;
  putPending(rec: PendingRecord): Promise<void>;
  getPending(id: string): Promise<PendingRecord | undefined>;
  deletePending(id: string): Promise<void>;
  putCode(hash: string, rec: CodeRecord): Promise<void>;
  consumeCode(hash: string, now: number): Promise<CodeRecord | undefined>; // undefined if missing/used/expired; marks usedAt
  putToken(hash: string, rec: TokenRecord): Promise<void>;
  getToken(hash: string): Promise<TokenRecord | undefined>;
  updateToken(hash: string, patch: Partial<TokenRecord>): Promise<void>;
  /** Returns the number of tokens newly revoked by this call. */
  revokeFamily(familyId: string, now: number): Promise<number>;
  /**
   * Returns the number of tokens that are in revoked state after the call
   * (already-revoked tokens are included; their `revokedAt` is never
   * overwritten). Also clears pending authorizations and codes.
   */
  revokeAll(now: number): Promise<number>;
  sweepExpired(now: number): Promise<void>; // drops expired pending/codes/tokens/negative clients
}

export class StoreCorruptError extends Error {
  readonly filePath: string;

  constructor(filePath: string, reason: string) {
    super(
      `Auth state file ${filePath} is unusable (${reason}). Fix it or run \`npm run revoke-all -- --reset\`.`,
    );
    this.name = 'StoreCorruptError';
    this.filePath = filePath;
  }
}
