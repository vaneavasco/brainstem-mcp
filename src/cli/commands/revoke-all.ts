import { FileTokenStore, writeEmptyStateFile } from '../../auth/store/file-store.ts';

export interface RevokeAllDeps {
  stateFile: string;
  print(l: string): void;
  confirm(q: string): Promise<boolean>;
}

/**
 * Revokes every token in the auth state file (clients must re-authorize), or
 * — with `--reset` — writes the empty document back over it, which also drops
 * registered clients and pending authorizations, and is the recovery path for
 * a corrupt state file. `--reset` writes rather than deletes on purpose: the
 * running app reloads the file when its mtime/size changes, so a deleted file
 * would leave its in-memory copy (tokens included) alive.
 */
export async function runRevokeAll(
  args: { reset?: boolean },
  deps: RevokeAllDeps,
): Promise<number> {
  const question = args.reset
    ? 'Reset the auth state file? All clients will need to reconnect.'
    : 'Revoke all tokens? All clients will need to reconnect.';
  if (!(await deps.confirm(question))) {
    deps.print('cancelled');
    return 0;
  }

  if (args.reset) {
    await writeEmptyStateFile(deps.stateFile);
    deps.print('state file reset — all clients must reconnect');
    return 0;
  }

  const store = await FileTokenStore.open(deps.stateFile);
  const count = await store.revokeAll(Date.now());
  deps.print(`revoked ${count} tokens; all clients must reconnect`);
  return 0;
}
