import { readFileSync } from 'node:fs';

interface PackageJson {
  name: string;
  version: string;
}

// Works from both src/ (dev) and dist/ (prod): package.json is one level above either directory.
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageJson;

export const SERVER_INFO = { name: 'brainstem-mcp' as const, version: pkg.version };
