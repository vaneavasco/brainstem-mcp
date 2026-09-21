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
    if (env.get('TUNNEL_MODE') !== 'quick') return null; // only a quick tunnel writes this file
    const vault = env.get('VAULT_PATH') ?? '';
    const file = env.get('PUBLIC_URL_FILE') ?? '';
    if (vault === '' || !file.startsWith(CONTAINER_VAULT)) return null;
    // `..` in the configured path must not walk out of the vault
    const root = path.resolve(vault);
    const target = path.resolve(root, file.slice(CONTAINER_VAULT.length));
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
    try {
      const text = (await readFile(target)).replace(/^\ufeff/, '').trim();
      // one bare https origin: no credentials, no path, no second line
      return /^https:\/\/[^\s/@]+\/?$/.test(text) ? text : null;
    } catch {
      return null;
    }
  };
}
