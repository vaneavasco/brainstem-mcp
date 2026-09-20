import { defineConfig } from 'vitest/config';

/** `npm run test:scale`: the 40,000-note run. Its own config because it writes ~150 MB of notes
 *  and takes minutes; `npm test` must stay quick, so these files are not named `*.test.ts`. */
export default defineConfig({
  test: {
    include: ['tests/scale/**/*.scale.ts'],
    environment: 'node',
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    // the measurements are the point of the run: print them when it passes too
    reporters: ['verbose'],
    silent: false,
  },
});
