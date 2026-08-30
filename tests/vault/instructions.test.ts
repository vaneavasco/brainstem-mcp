import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createInstructionsProvider,
  DEFAULT_INSTRUCTIONS,
  INSTRUCTIONS_FILE,
  MAX_OWNER_INSTRUCTIONS_CHARS,
  OWNER_INSTRUCTIONS_HEADING,
  renderInstructionsTemplate,
  writeInstructionsTemplateIfMissing,
} from '../../src/vault/instructions.ts';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-instructions-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const file = () => path.join(dir, INSTRUCTIONS_FILE);

describe('DEFAULT_INSTRUCTIONS', () => {
  it('names the conventions Claude needs on every connection', () => {
    for (const needle of ['vault_edit', 'vault_append', '.trash/', '_brainstem/', 'frontmatter']) {
      expect(DEFAULT_INSTRUCTIONS).toContain(needle);
    }
    expect(DEFAULT_INSTRUCTIONS.length).toBeLessThan(2_000);
  });
});

describe('createInstructionsProvider', () => {
  it('returns the defaults alone when the owner file does not exist', async () => {
    const provider = createInstructionsProvider(dir);
    expect(await provider.get()).toBe(DEFAULT_INSTRUCTIONS);
  });

  it('appends the owner text under its own heading, without frontmatter or HTML comments', async () => {
    await fs.writeFile(
      file(),
      '---\ntype: brainstem-instructions\n---\n<!-- private note to self -->\n# My vault\n- Projects live in `10-projects/`.\n\n<!-- another\nmulti-line comment -->\n- Always add `status:` to new notes.\n',
    );
    const text = await createInstructionsProvider(dir).get();
    expect(text.startsWith(DEFAULT_INSTRUCTIONS)).toBe(true);
    expect(text).toContain(OWNER_INSTRUCTIONS_HEADING);
    expect(text).toContain('- Projects live in `10-projects/`.');
    expect(text).toContain('- Always add `status:` to new notes.');
    expect(text).not.toContain('private note to self');
    expect(text).not.toContain('multi-line comment');
    expect(text).not.toContain('type: brainstem-instructions');
  });

  it('treats a file that is only frontmatter, comments and whitespace as unset', async () => {
    await fs.writeFile(file(), renderInstructionsTemplate());
    expect(await createInstructionsProvider(dir).get()).toBe(DEFAULT_INSTRUCTIONS);
  });

  it('re-reads the file when its mtime changes and caches otherwise', async () => {
    let stats = 0;
    const provider = createInstructionsProvider(dir, {
      stat: async (p) => {
        stats++;
        return fs.stat(p);
      },
    });
    await fs.writeFile(file(), 'one\n');
    expect(await provider.get()).toContain('one');
    const reads = provider.reads;
    await provider.get();
    expect(provider.reads).toBe(reads);
    // A later mtime — the owner edited the note in Obsidian.
    await fs.writeFile(file(), 'two\n');
    const later = new Date(Date.now() + 5_000);
    await fs.utimes(file(), later, later);
    const text = await provider.get();
    expect(text).toContain('two');
    expect(text).not.toContain('one\n');
    expect(provider.reads).toBe(reads + 1);
    expect(stats).toBeGreaterThanOrEqual(3);
  });

  it('caps the owner text and says so', async () => {
    await fs.writeFile(file(), 'x'.repeat(MAX_OWNER_INSTRUCTIONS_CHARS + 500));
    const text = await createInstructionsProvider(dir).get();
    expect(text.length).toBeLessThan(
      DEFAULT_INSTRUCTIONS.length + MAX_OWNER_INSTRUCTIONS_CHARS + 300,
    );
    expect(text).toMatch(/truncated/);
  });

  it('falls back to the defaults when the file cannot be read', async () => {
    const provider = createInstructionsProvider(dir, {
      stat: async () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    });
    expect(await provider.get()).toBe(DEFAULT_INSTRUCTIONS);
  });
});

describe('writeInstructionsTemplateIfMissing', () => {
  it('seeds the template once and never overwrites the owner text', async () => {
    expect(await writeInstructionsTemplateIfMissing(dir)).toBe(true);
    expect(await fs.readFile(file(), 'utf8')).toBe(renderInstructionsTemplate());
    await fs.writeFile(file(), 'mine\n');
    expect(await writeInstructionsTemplateIfMissing(dir)).toBe(false);
    expect(await fs.readFile(file(), 'utf8')).toBe('mine\n');
  });

  it('creates the state dir when needed', async () => {
    const nested = path.join(dir, 'a', '_brainstem');
    expect(await writeInstructionsTemplateIfMissing(nested)).toBe(true);
    await expect(fs.stat(path.join(nested, INSTRUCTIONS_FILE))).resolves.toBeTruthy();
  });
});

describe('renderInstructionsTemplate', () => {
  it('explains itself only in frontmatter and comments, so nothing reaches Claude until the owner writes', () => {
    const t = renderInstructionsTemplate();
    expect(t.startsWith('---\ntype: brainstem-instructions\n')).toBe(true);
    expect(t).toContain('<!--');
    expect(t).toContain('-->');
  });
});
