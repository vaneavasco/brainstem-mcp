import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../../src/cli/catalog.ts';

const README_PATH = path.resolve(import.meta.dirname, '..', '..', 'README.md');
const FOR_DEVELOPERS_HEADING = '## For developers';

async function readReadme(): Promise<string> {
  return fs.readFile(README_PATH, 'utf8');
}

describe('README ↔ catalog consistency', () => {
  it('mentions every catalog command as `./brainstem <name>`', async () => {
    const readme = await readReadme();
    for (const { name } of COMMANDS) {
      expect(readme).toContain(`./brainstem ${name}`);
    }
  });

  it('leads with `./brainstem start` before any `npm install`', async () => {
    const readme = await readReadme();
    const startIndex = readme.indexOf('./brainstem start');
    const npmInstallIndex = readme.indexOf('npm install');
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(npmInstallIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeLessThan(npmInstallIndex);
  });

  it('keeps `npm run`/`npm install` confined to the "For developers" section', async () => {
    const readme = await readReadme();
    const headingIndex = readme.indexOf(FOR_DEVELOPERS_HEADING);
    expect(headingIndex).toBeGreaterThan(0);

    const beforeDevelopers = readme.slice(0, headingIndex);
    expect(beforeDevelopers).not.toContain('npm run');
    expect(beforeDevelopers).not.toContain('npm install');
  });

  it('tells Windows readers to swap `./brainstem` for `.\\brainstem`', async () => {
    const readme = await readReadme();
    // Every command in the README is written `./brainstem …`; without this one
    // sentence a Windows reader has nothing that runs.
    expect(readme).toContain('.\\brainstem start');
    expect(readme).toMatch(/On Windows, replace `\.\/brainstem` with `\.\\brainstem`/);
  });

  it('has a command table for every catalog group', async () => {
    const readme = await readReadme();
    for (const group of ['Everyday', 'Configuration', 'Maintenance']) {
      expect(readme).toContain(group);
    }
  });
});
