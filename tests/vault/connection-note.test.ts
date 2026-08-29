import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  renderConnectionNote,
  writeConnectionNote,
  writeInstanceFile,
} from '../../src/vault/connection-note.ts';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-connection-note-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('renderConnectionNote', () => {
  it('renders the connector URL, the claude mcp add command and reconnect steps', () => {
    const md = renderConnectionNote({
      publicUrl: 'https://x.trycloudflare.com',
      mcpUrl: 'https://x.trycloudflare.com/mcp',
      tunnelMode: 'quick',
      updatedAt: '2026-08-28T10:00:00Z',
    });
    expect(md).toContain('https://x.trycloudflare.com/mcp');
    expect(md).toContain(
      'claude mcp add --transport http brainstem https://x.trycloudflare.com/mcp',
    );
    expect(md).toMatch(/remove.*add/i);
    expect(md.startsWith('---\n')).toBe(true); // frontmatter with updatedAt + mode
  });
});

describe('writeConnectionNote', () => {
  it('writes connection.md atomically into stateDir', async () => {
    await writeConnectionNote(dir, {
      publicUrl: 'https://x.trycloudflare.com',
      mcpUrl: 'https://x.trycloudflare.com/mcp',
      tunnelMode: 'quick',
      updatedAt: '2026-08-28T10:00:00Z',
    });
    const text = await fs.readFile(path.join(dir, 'connection.md'), 'utf8');
    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toContain('https://x.trycloudflare.com/mcp');
    // no leftover tmp files
    const entries = await fs.readdir(dir);
    expect(entries).toEqual(['connection.md']);
  });
});

describe('writeInstanceFile', () => {
  it('reports another live host', async () => {
    await writeInstanceFile(dir, {
      hostname: 'laptop',
      startedAt: 'a',
      heartbeatAt: new Date().toISOString(),
    });
    const r = await writeInstanceFile(dir, {
      hostname: 'desktop',
      startedAt: 'b',
      heartbeatAt: new Date().toISOString(),
    });
    expect(r.otherHost).toBe('laptop');
    const stale = await writeInstanceFile(dir, {
      hostname: 'laptop',
      startedAt: 'c',
      heartbeatAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    expect(stale.otherHost).toBe('desktop'); // desktop's heartbeat is < 5 min old
  });

  it('treats a corrupt existing file as absent', async () => {
    await fs.writeFile(path.join(dir, 'instance.json'), 'not json{{{');
    const r = await writeInstanceFile(dir, {
      hostname: 'laptop',
      startedAt: 'a',
      heartbeatAt: new Date().toISOString(),
    });
    expect(r.otherHost).toBeNull();
  });
});
