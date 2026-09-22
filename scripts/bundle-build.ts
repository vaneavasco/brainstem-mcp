/**
 * `npm run bundle:build` — bundles `src/stdio-main.ts` into `bundle/dist/stdio-main.js` with
 * esbuild: one JavaScript file carrying everything the stdio server needs (tools, vault, storage,
 * its dependencies) and nothing it doesn't. This is the Claude Desktop bundle's whole server: no
 * Express, no authorization server, no tunnel supervisor, no CLI — `tests/bundle/build.test.ts`
 * greps the output for each of those and fails on a hit, so a stray import can't reintroduce
 * them silently.
 *
 * The version a bundled server reports is fixed HERE, at build time (`define`), from
 * package.json at this moment — see `src/version.ts` for why (the bundle carries no
 * package.json of its own to read at import time). `BRAINSTEM_BUILD_SHA`, read from the
 * environment same as the Docker build, still works at runtime for the `+<commit>` suffix.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const repoRoot = path.resolve(import.meta.dirname, '..');

interface PackageJson {
  version: string;
}

export async function bundleBuild(): Promise<{ version: string; outfile: string }> {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as PackageJson;
  const outfile = path.join(repoRoot, 'bundle', 'dist', 'stdio-main.js');

  const result = await build({
    entryPoints: [path.join(repoRoot, 'src', 'stdio-main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    // Everything reachable from stdio-main.ts is inlined — no runtime node_modules to carry, and
    // (together with the grep test) proof that only the stdio graph's own dependency tree is in
    // here, not the whole package's (Express, the auth server, the tunnel supervisor, the CLI).
    packages: 'bundle',
    sourcemap: 'external',
    minify: false,
    banner: {
      // Two things, both required for a CJS dependency (pino, in practice) bundled into ESM
      // output: the version comment, and a REAL `require` in module scope. esbuild's own CJS
      // interop shim falls back to `typeof require !== 'undefined' ? require : throw(...)` for a
      // `require(...)` call it could not statically resolve into an import (pino.js's own,
      // lazily-wrapped `require('node:os')` among them) — under `format: 'esm'` there is no
      // ambient `require`, so that throws at runtime ("Dynamic require of ... is not supported")
      // the first time such a module is touched. `createRequire(import.meta.url)` is Node's own
      // documented way to hand an ESM module a working `require`; declaring it as a top-level
      // `const require` here makes every one of esbuild's internal `typeof require` checks true,
      // for the whole bundle, with no per-dependency special-casing.
      js:
        `// brainstem-mcp v${pkg.version} — bundled stdio server (Claude Desktop extension / MCPB). Built from src/stdio-main.ts by scripts/bundle-build.ts; do not edit directly.\n` +
        "import { createRequire as __brainstemCreateRequire } from 'node:module';\n" +
        'const require = __brainstemCreateRequire(import.meta.url);',
    },
    define: {
      'process.env.BRAINSTEM_BUNDLE_VERSION': JSON.stringify(pkg.version),
    },
    logLevel: 'info',
    metafile: true,
  });

  if (result.warnings.length > 0) {
    for (const w of result.warnings) console.warn(w.text);
  }

  return { version: pkg.version, outfile };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const started = Date.now();
  const { version, outfile } = await bundleBuild();
  console.log(
    `bundled stdio-main.ts v${version} -> ${path.relative(repoRoot, outfile)} in ${Date.now() - started}ms`,
  );
}
