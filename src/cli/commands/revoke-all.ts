import { promises as fs } from 'node:fs';
import { FileTokenStore } from '../../auth/store/file-store.ts';

export interface RevokeAllDeps {
  stateFile: string;
  print(l: string): void;
  confirm(q: string): Promise<boolean>;
}

/**
 * Revokes every token in the auth state file (clients must re-authorize),
 * or — with `--reset` — deletes the state file outright (also clearing
 * registered clients/pending authorizations, not just tokens). The running
 * app picks either change up via its own reload-on-mtime check.
 */
export async function runRevokeAll(
  args: { reset?: boolean },
  deps: RevokeAllDeps,
): Promise<number> {
  const question = args.reset
    ? 'Delete the auth state file? All clients will need to reconnect.'
    : 'Revoke all tokens? All clients will need to reconnect.';
  if (!(await deps.confirm(question))) {
    deps.print('cancelled');
    return 0;
  }

  if (args.reset) {
    try {
      await fs.unlink(deps.stateFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    deps.print('state file removed');
    return 0;
  }

  const store = await FileTokenStore.open(deps.stateFile);
  const count = await store.revokeAll(Date.now());
  deps.print(`revoked ${count} tokens; all clients must reconnect`);
  return 0;
}
