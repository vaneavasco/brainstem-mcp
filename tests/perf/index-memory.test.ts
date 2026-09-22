import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The index keeps small pieces of every note (link targets, headings, frontmatter values). In V8 a
 * piece cut out of a larger string keeps the WHOLE string alive, so an index made of such pieces
 * silently holds the text of the entire vault: measured on a 37,000-note vault, 940 MB of heap
 * for 264 MB of index. This guard builds an index over long notes in a child process (the heap
 * can only be measured honestly with --expose-gc) and fails if the note texts are retained.
 */
const NOTES = 300;
const FILLER_CHARS = 300_000; // ~90 MB of note text in all

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-mem-'));
  for (let i = 0; i < NOTES; i += 1) {
    const filler = `unique filler ${i} `.repeat(Math.ceil(FILLER_CHARS / 18));
    const content = `---\nstatus: open\ntitle: "note number ${i} with a reasonably long title"\n---\n# Heading of note ${i}\n\nsee [[note-${(i + 1) % NOTES}|the next note]] and #tag-${i}\n\n${filler}\n`;
    await fs.writeFile(path.join(root, `note-${i}.md`), content);
  }
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// node -e --input-type=module resolves a bare absolute path as an ESM import specifier, and on
// Windows an absolute path ("D:\\...") is not a valid file:// URL — pathToFileURL is what turns
// either platform's path into one Node's loader accepts.
const SCRIPT = `
import { LocalFSAdapter } from ${JSON.stringify(pathToFileURL(path.resolve('src/storage/local-fs.ts')).href)};
import { FrontmatterIndex } from ${JSON.stringify(pathToFileURL(path.resolve('src/vault/frontmatter-index.ts')).href)};
const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed; };
const before = heap();
const adapter = await LocalFSAdapter.create(process.argv[1], { ripgrepPath: null });
const index = await FrontmatterIndex.build(adapter);
const after = heap();
console.log(JSON.stringify({ notes: index.size(), heldMiB: (after - before) / 1048576 }));
`;

describe('index memory', () => {
  it('does not keep the text of the notes alive through the pieces it stores', async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--expose-gc', '--input-type=module', '-e', SCRIPT, root],
      { maxBuffer: 1 << 20 },
    );
    const { notes, heldMiB } = JSON.parse(stdout.trim().split('\n').at(-1) as string) as {
      notes: number;
      heldMiB: number;
    };
    expect(notes).toBe(NOTES);
    console.log(`index over ${NOTES} notes (~90 MB of text) holds ${heldMiB.toFixed(1)} MiB`);
    // The entries themselves are well under 1 MiB; retaining the texts would cost ~90 MiB.
    expect(heldMiB).toBeLessThan(20);
  }, 120_000);
});
