import path from 'node:path';
import { defineConfig } from 'vitest/config';

const repoRoot = import.meta.dirname;

/**
 * `npm run test:bundle` = `bundle:build` + this run: the exact same `tests/stdio/**` suite that
 * proves `src/stdio-main.ts`'s behaviour, run instead against the esbuild-bundled
 * `bundle/dist/stdio-main.js` — proof the BUNDLE behaves like the source (including
 * `import.meta.dirname`/`pathToFileURL(process.argv[1])` — the `isMain` check — surviving being
 * bundled), not only that the source does. `tests/helpers/stdio-entry.ts` reads
 * `BRAINSTEM_STDIO_ENTRY` and falls back to the source file when it's unset, so every other
 * `npm test` run (this config's sibling, `vitest.config.ts`) is unaffected.
 */
export default defineConfig({
  test: {
    include: ['tests/stdio/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    hookTimeout: 15_000,
    env: {
      BRAINSTEM_STDIO_ENTRY: path.join(repoRoot, 'bundle', 'dist', 'stdio-main.js'),
    },
  },
});
