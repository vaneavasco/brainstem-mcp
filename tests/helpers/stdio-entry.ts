import path from 'node:path';

/**
 * The stdio entrypoint every test that spawns a real child process runs: `src/stdio-main.ts`
 * (Node's native TypeScript support) by default, or the esbuild-bundled
 * `bundle/dist/stdio-main.js` when `BRAINSTEM_STDIO_ENTRY` is set in the environment.
 * `npm run test:bundle` (`vitest.bundle.config.ts`) sets it before running `tests/stdio/**`, so
 * the exact same tests prove the BUNDLED file behaves like the source, not just that the source
 * does — including `import.meta.dirname`/`pathToFileURL(process.argv[1])` usage (the `isMain`
 * check) surviving the bundle. One constant, so no spawn site can point at the source by mistake
 * while `test:bundle` is proving the bundle.
 */
export const STDIO_ENTRY =
  process.env.BRAINSTEM_STDIO_ENTRY ??
  path.resolve(import.meta.dirname, '..', '..', 'src', 'stdio-main.ts');
