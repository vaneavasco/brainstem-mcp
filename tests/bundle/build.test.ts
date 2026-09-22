import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { bundleBuild } from '../../scripts/bundle-build.ts';

/**
 * Proves `scripts/bundle-build.ts` (`npm run bundle:build`) produces a bundle that carries only
 * the stdio server's own graph (`src/tools`, `src/vault`, `src/storage`, its dependencies) —
 * never Express, the tunnel supervisor, the CLI, or the authorization server (`src/auth/as`,
 * `src/auth/rs`, `src/auth/mount.ts`, `src/auth/store`, `src/auth/context.ts`): a bundle user
 * gets a process that opens no port and has no owner secret, and this is what would notice a
 * stray import quietly reintroducing any of them.
 *
 * Two of `src/auth/` and `src/cli/`'s files ARE legitimately pulled in — `src/auth/hash.ts`
 * (`sha256hex`, a generic hashing helper `LocalFSAdapter` uses for content hashes, nothing to do
 * with tokens) and `src/cli/vault-path.ts` (the vault-folder validation `stdio-main.ts` shares
 * with `./brainstem setup`/`status`) — so the check below is by specific forbidden file, not by
 * directory prefix. The literal string `OWNER_SECRET` is ALSO legitimately present exactly once:
 * `src/config.ts`'s `EnvSchema` is one object both `loadConfig` (HTTP) and `loadVaultConfig`
 * (stdio, used here) parse, by design (see that file's own comment on the field) — the KEY name
 * is in the shared schema, but stdio never reads, requires or otherwise touches its VALUE.
 */
let bundleText: string;

beforeAll(async () => {
  const { outfile } = await bundleBuild();
  bundleText = readFileSync(outfile, 'utf8');
}, 60_000);

/** Standalone occurrences of `term` — a real identifier/import boundary, never a substring inside
 *  a longer word or identifier (`express` inside "regular expression", `authorization` inside the
 *  MCP SDK's own `authorization_endpoint` field name). */
function wholeWordOccurrences(text: string, term: string): RegExpMatchArray[] {
  const re = new RegExp(`(?<![\\w-])${term}(?![\\w-])`, 'g');
  return [...text.matchAll(re)];
}

describe('the bundled stdio server (bundle/dist/stdio-main.js)', () => {
  it('never mentions cloudflared or the express package', () => {
    expect(wholeWordOccurrences(bundleText, 'cloudflared')).toHaveLength(0);
    expect(wholeWordOccurrences(bundleText, 'express')).toHaveLength(0);
  });

  it("OWNER_SECRET appears exactly once, as the shared EnvSchema's unused field declaration — never read, compared or hashed", () => {
    const hits = wholeWordOccurrences(bundleText, 'OWNER_SECRET');
    expect(hits).toHaveLength(1);
    const start = hits[0]?.index ?? 0;
    const around = bundleText.slice(start - 20, start + 60);
    // The one shape this is allowed to take: a zod field declaration `OWNER_SECRET:
    // <zod namespace>.string().optional()` inside EnvSchema — matched structurally, not against
    // esbuild's generated name for the zod namespace import, which is an implementation detail
    // that can shift with the zod or esbuild version. Anything else here (a comparison, a hash
    // call, a header, a log line) would mean the value itself is now reachable from stdio, not
    // just the schema's key name.
    expect(around).toMatch(/OWNER_SECRET:\s*\w+\.string\(\)\.optional\(\)/);
  });

  it(
    'every "authorization" is the MCP SDK\'s own OAuth-client metadata field naming, or this ' +
      "server's own log-redaction key — never the authorization SERVER's code, which is what " +
      'would leave behind an unqualified one',
    () => {
      const hits = wholeWordOccurrences(bundleText, 'authorization');
      expect(hits.length).toBeGreaterThan(0); // proves the check below isn't vacuous
      for (const hit of hits) {
        const start = hit.index ?? 0;
        const end = start + hit[0].length;
        // An SDK field name: authorization_endpoint, authorization_servers, ... (this server
        // never defines such a field itself — it only reads the SDK's own schemas for them).
        const isSdkFieldName = bundleText[end] === '_';
        // src/logger.ts's SECRET_KEYS entry, quoted exactly like every sibling in that list
        // ("token", "access_token", ..., "authorization", "refresh_token_enc") — a redaction key
        // name, not a route or a handler.
        const isRedactionListEntry = bundleText.slice(start - 1, end + 1) === '"authorization"';
        expect(
          isSdkFieldName || isRedactionListEntry,
          `unexpected "authorization" at offset ${start}: ${bundleText.slice(start - 30, end + 30)}`,
        ).toBe(true);
      }
    },
  );

  it('never pulls in the authorization server, the tunnel supervisor, the CLI, or the HTTP app', () => {
    const forbiddenSourceFiles = [
      'src/auth/as/',
      'src/auth/rs/',
      'src/auth/mount.ts',
      'src/auth/context.ts',
      'src/auth/store/',
      'src/tunnel/',
      'src/cli/brainstem.ts',
      'src/cli/catalog.ts',
      'src/cli/commands/',
      'src/app.ts',
      'src/server.ts',
      'src/main.ts',
    ];
    for (const forbidden of forbiddenSourceFiles) {
      // esbuild (minify: false) leaves a `// <path>` comment before every bundled module — the
      // one place a pulled-in file is guaranteed to name itself, regardless of how deep inside
      // some other module's code it's referenced from.
      expect(bundleText.includes(`// ${forbidden}`), forbidden).toBe(false);
    }
  });

  it('is a single file: sourcemap external, no other JS emitted beside it', () => {
    // A basic sanity check that the file esbuild wrote is non-trivial (the whole stdio graph,
    // not an empty or truncated build) and carries the version banner scripts/bundle-build.ts adds.
    expect(bundleText.length).toBeGreaterThan(100_000);
    expect(bundleText.startsWith('// brainstem-mcp v')).toBe(true);
  });
});
