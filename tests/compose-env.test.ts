import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * compose.yaml whitelists the environment of the app container: a setting documented in
 * .env.example that is not passed through is dead configuration under Docker, and nothing else
 * notices. Settings that are deliberately not passed (or are not the app's) are listed here.
 */
const NOT_FOR_THE_APP = new Set([
  'TUNNEL_TOKEN', // the tunnel container's
  'HOST_UID', // compose `user:`
  'HOST_GID',
  'BRAINSTEM_IMAGE', // image selection
  'BRAINSTEM_IMAGE_TAG',
  'BRAINSTEM_TUNNEL_IMAGE',
  'BRAINSTEM_STATE_HOME', // stdio only — the HTTP server (this container) always keeps its
  // state inside the bind-mounted vault, never in a machine-local folder
  'BRAINSTEM_INDEX_CACHE', // stdio only — the HTTP server never builds an index cache
  'BRAINSTEM_CACHE_HOME', // stdio only — same reasoning as BRAINSTEM_STATE_HOME above
]);

describe('compose.yaml passes every documented setting to the app', () => {
  it('each key of .env.example is in the app environment, or deliberately excluded', () => {
    const keys = [
      ...readFileSync('.env.example', 'utf8').matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm),
    ].map((m) => m[1] as string);
    expect(keys.length).toBeGreaterThan(10);
    const compose = readFileSync('compose.yaml', 'utf8');
    const app = compose.slice(compose.indexOf('  app:'), compose.indexOf('  tunnel:'));
    const missing = keys.filter(
      (k) => !NOT_FOR_THE_APP.has(k) && !new RegExp(`^\\s+${k}:`, 'm').test(app),
    );
    expect(missing).toEqual([]);
  });
});
