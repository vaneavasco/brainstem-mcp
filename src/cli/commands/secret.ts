import { upsertEnv } from '../env-file.ts';
import { runRevokeAll } from './revoke-all.ts';

export interface SecretShowDeps {
  env: Map<string, string>;
  print(l: string): void;
}

/** Prints the current `OWNER_SECRET` verbatim — this is the one place it's meant to be shown. */
export function runSecretShow(deps: SecretShowDeps): number {
  const secret = deps.env.get('OWNER_SECRET') ?? '';
  if (secret === '') {
    deps.print('OWNER_SECRET is not set — run ./brainstem setup');
    return 1;
  }
  deps.print(secret);
  return 0;
}

/** Middle-masks a secret for confirmation output: keeps the first/last 4 chars. */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '*'.repeat(secret.length);
  return `${secret.slice(0, 4)}${'*'.repeat(secret.length - 8)}${secret.slice(-4)}`;
}

export interface SecretRotateDeps {
  envPath: string;
  stateFile: string;
  readFile(p: string): Promise<string>;
  writeFile(p: string, text: string): Promise<void>;
  randomSecret(): string;
  print(l: string): void;
  confirm(q: string): Promise<boolean>;
}

/**
 * Generates a fresh 32-byte base64url `OWNER_SECRET`, writes it into `.env`
 * (replacing any existing value), and offers to revoke all outstanding
 * tokens in the same breath — since they were minted under the old secret's
 * trust boundary, keeping them alive after a rotation defeats the point.
 */
export async function runSecretRotate(deps: SecretRotateDeps): Promise<number> {
  const text = await deps.readFile(deps.envPath);
  const newSecret = deps.randomSecret();
  const { text: updated } = upsertEnv(text, { OWNER_SECRET: newSecret }, { onlyIfEmpty: false });
  await deps.writeFile(deps.envPath, updated);
  deps.print(`OWNER_SECRET rotated: ${maskSecret(newSecret)}`);

  if (await deps.confirm('Also revoke all existing tokens?')) {
    await runRevokeAll(
      {},
      { stateFile: deps.stateFile, print: deps.print, confirm: async () => true },
    );
  }

  deps.print('Restart the app to pick up the new secret: ./brainstem up');
  return 0;
}
