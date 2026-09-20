import { readFileSync } from 'node:fs';

interface PackageJson {
  name: string;
  version: string;
}

// Works from both src/ (dev) and dist/ (prod): package.json is one level above either directory.
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageJson;

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

export const SERVER_INFO = {
  name: 'brainstem-mcp' as const,
  version: serverVersion(pkg.version, process.env.BRAINSTEM_BUILD_SHA),
};
