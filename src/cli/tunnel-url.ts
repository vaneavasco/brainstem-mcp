import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Where compose mounts the vault inside the containers (`compose.yaml`). */
const CONTAINER_VAULT = '/vault/';

/**
 * Reads the hostname the quick tunnel reports, from the host side. The tunnel writes it to
 * `PUBLIC_URL_FILE`, a path inside the container (`/vault/_brainstem/public-url`), and removes the
 * file before every start; on the host that is the same file under `VAULT_PATH`. Returns `null`
 * while there is no usable value (no file yet, not a quick tunnel, a path outside the vault).
 */
export function tunnelUrlReader(
  env: Map<string, string>,
  readFile: (p: string) => Promise<string> = (p) => fs.readFile(p, 'utf8'),
): () => Promise<string | null> {
  return async () => {
    const vault = env.get('VAULT_PATH') ?? '';
    const file = env.get('PUBLIC_URL_FILE') ?? '';
    if (vault === '' || !file.startsWith(CONTAINER_VAULT)) return null;
    try {
      const text = (await readFile(path.join(vault, file.slice(CONTAINER_VAULT.length)))).trim();
      return /^https:\/\/[^\s/]+\/?$/.test(text) ? text : null;
    } catch {
      return null;
    }
  };
}
