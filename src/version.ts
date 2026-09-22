import { readFileSync } from 'node:fs';

interface PackageJson {
  name: string;
  version: string;
}

/**
 * `../package.json` relative to THIS file works from `src/` (dev), `dist/` (the Docker image's
 * `tsc` build — one directory under the package root either way) and would still work from
 * `bundle/dist/` if it ever needed to (one directory under `bundle/`, which is where a
 * `bundle:build`-produced `bundle/package.json` would have to live) — but the bundle never
 * reaches this call in practice, because `process.env.BRAINSTEM_BUNDLE_VERSION` (below) is
 * defined at build time instead: esbuild's `packages: 'bundle'` inlines everything reachable
 * from `import.meta.url`-relative reads too, so a bundled `readFileSync(new URL('../package.json',
 * import.meta.url))` would look for a `package.json` the bundle doesn't ship — resolving the
 * version at BUILD time, not at import time, sidesteps that entirely.
 */
function readPackageVersion(): string {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as PackageJson;
  return pkg.version;
}

/**
 * The version a server reports: the package version, plus the commit the image was built from as
 * semver build metadata (`0.4.0+3c421e3`) when the build said which one. Images are published for
 * every commit on main, so between two releases the package version alone does not say what is
 * running, and a client that keys a cache on the version would never see a deploy.
 */
export function serverVersion(packageVersion: string, buildSha: string | undefined): string {
  const sha = /^[0-9a-f]{7,40}$/.test(buildSha ?? '') ? (buildSha as string).slice(0, 7) : '';
  return sha === '' ? packageVersion : `${packageVersion}+${sha}`;
}

// scripts/bundle-build.ts sets this with esbuild's `define`, so the version a bundled
// dist/stdio-main.js reports is fixed at build time, from package.json at that moment — the
// bundle carries no package.json of its own to read at runtime. Everywhere else (dev, the Docker
// image's tsc build, tests) this is unset, and the version is read from package.json as before.
const packageVersion = process.env.BRAINSTEM_BUNDLE_VERSION || readPackageVersion();

export const SERVER_INFO = {
  name: 'brainstem-mcp' as const,
  version: serverVersion(packageVersion, process.env.BRAINSTEM_BUILD_SHA),
};
