import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { serverVersion } from '../../src/version.ts';

/**
 * A release is three edits and a tag, made by hand. Four pull requests that changed the tool
 * surface were merged and deployed while the server went on calling itself 0.3.1, because nothing
 * checked. These tests fail on a half-made release; CI fails on a tag that disagrees with
 * package.json (see .github/workflows/ci.yml).
 */
const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const pkgVersion = (JSON.parse(read('package.json')) as { version: string }).version;

describe('the version says the same thing everywhere', () => {
  it('package-lock.json agrees with package.json', () => {
    const lock = JSON.parse(read('package-lock.json')) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    expect(lock.version).toBe(pkgVersion);
    expect(lock.packages['']?.version).toBe(pkgVersion);
  });

  it('the newest numbered CHANGELOG section is this version, dated, with a compare link', () => {
    const changelog = read('CHANGELOG.md');
    const first = /^## \[(\d+\.\d+\.\d+)\] — (\d{4}-\d{2}-\d{2})$/m.exec(changelog);
    expect(first?.[1]).toBe(pkgVersion);
    expect(changelog).toContain(`[${pkgVersion}]: https://github.com/`);
    expect(changelog.indexOf('## [Unreleased]')).toBeLessThan(
      changelog.indexOf(`## [${pkgVersion}]`),
    );
  });

  it('the README names this version', () => {
    expect(read('README.md')).toContain(`**v${pkgVersion} — beta.**`);
  });
});

describe('the version a server reports', () => {
  it('is the package version alone when the build did not say which commit it is', () => {
    expect(serverVersion(pkgVersion, undefined)).toBe(pkgVersion);
    expect(serverVersion(pkgVersion, '')).toBe(pkgVersion);
  });

  it('carries the commit as build metadata, so two builds of one release can be told apart', () => {
    expect(serverVersion('1.2.3', '3c421e3b348cc5bea05e1feb502175c28c2b495f')).toBe(
      '1.2.3+3c421e3',
    );
    expect(serverVersion('1.2.3', '3c421e3')).toBe('1.2.3+3c421e3');
  });

  it('ignores a value that is not a commit id', () => {
    expect(serverVersion('1.2.3', 'not a sha; rm -rf')).toBe('1.2.3');
  });
});
