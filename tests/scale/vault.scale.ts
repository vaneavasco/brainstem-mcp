import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENT_SAFE_RESULT_CHARS } from '../../src/storage/limits.ts';
import { type Harness, startHarness } from '../tools/harness.ts';

/**
 * The scale run. Every problem of scale this server has had (an index that held the text of the
 * whole vault, list results a client refused, a watcher that lost events) was found on one real
 * vault of about 37,000 long notes, after the code had shipped with green tests over a handful
 * of notes. This run gives CI a vault of that shape: 40,000 notes of ~3.5 KB in 200 folders,
 * a dozen frontmatter fields, 3,000 tags, six links each and one hub that every note links to.
 *
 * It asserts what this seed measures, with about 1.4x of headroom on memory (time bounds are loose:
 * a CI runner is several times slower than a workstation):
 *   index    ~2.0 KB serialized per note                          → under 2.8 KB
 *   memory   ~3.4 KB of heap per note, ~5.8 KB with the graph     → under 4.8 KB and 8 KB
 *   heap / serialized ~1.7                                        → under 2.5
 *   build    17–28 s                                              → under 240 s
 *   idle reconcile pass 2–5 s, re-reads nothing                   → under 30 s, 0 changes
 * A second review showed the first version of this run passing with the retention bug put back:
 * its names were under 13 characters (V8 copies those) and its scalars quoted (already copies).
 *   every list-shaped tool result fits the strictest client (CLIENT_SAFE_RESULT_CHARS)
 * The numbers are logged on every run, so drift shows long before a bound trips.
 */
const NOTES = 40_000;
const FOLDERS = 200;
const TAGS = 3_000;
const BODY_CHARS = 3_000;

// 18 characters: V8 copies a substring under 13, and a copy cannot show a retention bug
const name = (i: number): string => `working-note-${String(i).padStart(5, '0')}`;
const folder = (i: number): string => `area-${String(i % FOLDERS).padStart(3, '0')}`;
const notePath = (i: number): string => `${folder(i)}/${name(i)}.md`;

/** Deterministic PRNG (mulberry32): the same vault on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noteText(i: number, rand: () => number): string {
  const pick = (n: number): number => Math.floor(rand() * n);
  const links = Array.from({ length: 5 }, () => `[[${name(pick(NOTES))}]]`);
  const tags = Array.from({ length: 3 }, () => `topic-${pick(TAGS)}`);
  const status = ['open', 'waiting', 'done', 'archived'][pick(4)];
  const day = `2026-${String(1 + pick(12)).padStart(2, '0')}-${String(1 + pick(28)).padStart(2, '0')}`;
  const frontmatter = [
    '---',
    // unquoted on purpose: a plain scalar is a slice of the note, a quoted one is already a copy
    `title: ${name(i)} with a title of ordinary length for a working note`,
    `status: ${status}`,
    `date: ${day}`,
    `owner: person-${pick(40)}`,
    `priority: ${1 + pick(5)}`,
    `summary: what this note is about in one sentence of the usual length and number ${i}`,
    `related:\n  - "[[${name(pick(NOTES))}]]"\n  - "[[${name(pick(NOTES))}]]"`,
    `tags:\n${tags.map((t) => `  - ${t}`).join('\n')}`,
    `estimate: ${pick(100)}`,
    `reviewed: ${pick(2) === 0}`,
    '---',
  ].join('\n');
  const paragraph = `Paragraph of note ${i} with ordinary words in it, neither short nor long. `;
  const sections = ['Context', 'Notes', 'Decisions', 'Next'].map(
    (h, k) =>
      `## ${h} of ${name(i)}\n\n${paragraph.repeat(Math.ceil(BODY_CHARS / 4 / paragraph.length))}\n` +
      `See ${links[k]} and [[hub]].\n`,
  );
  return `${frontmatter}\n\n# ${name(i)}\n\n${sections.join('\n')}\nAlso ${links[4]}. #inline-${pick(50)}\n`;
}

async function seed(root: string): Promise<void> {
  const rand = mulberry32(0x5ca1e);
  for (let f = 0; f < FOLDERS; f += 1)
    await fs.mkdir(path.join(root, folder(f)), { recursive: true });
  await fs.writeFile(path.join(root, 'hub.md'), '# hub\n\nEvery note links here.\n');
  const CHUNK = 500;
  for (let start = 0; start < NOTES; start += CHUNK) {
    const writes: Promise<void>[] = [];
    for (let i = start; i < Math.min(start + CHUNK, NOTES); i += 1) {
      writes.push(fs.writeFile(path.join(root, notePath(i)), noteText(i, rand)));
    }
    await Promise.all(writes);
  }
}

/** Runs in a child with an exposed GC: heap can only be measured honestly there. */
const MEASURE = `
import { performance } from 'node:perf_hooks';
import { createLocalRuntime } from ${JSON.stringify(path.resolve('src/vault/runtime.ts'))};
const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed; };
const before = heap();
const t0 = performance.now();
const runtime = await createLocalRuntime({ vaultPath: process.argv[1], ripgrepPath: null, reconcileMs: 0 });
const buildMs = performance.now() - t0;
const afterIndex = heap();
runtime.graph.backlinks('hub.md');
const afterGraph = heap();
const pass = await runtime.index.reconcile(runtime.adapter);
const out = {
  notes: runtime.index.size(), buildMs, indexBytes: runtime.index.byteSize(),
  indexHeap: afterIndex - before, withGraphHeap: afterGraph - before, pass,
};
await runtime.close();
console.log(JSON.stringify(out));
`;

let root: string;
let h: Harness | undefined;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-scale-'));
  const t0 = performance.now();
  await seed(root);
  console.log(`[scale] seeded ${NOTES} notes in ${Math.round(performance.now() - t0)} ms`);
});

afterAll(async () => {
  if (h) await h.close();
  else await fs.rm(root, { recursive: true, force: true });
});

describe(`a vault of ${NOTES} notes`, () => {
  it('builds in bounded time and memory, and an idle reconcile pass re-reads nothing', async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--expose-gc', '--input-type=module', '-e', MEASURE, root],
      { maxBuffer: 1 << 20 },
    );
    const m = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as {
      notes: number;
      buildMs: number;
      indexBytes: number;
      indexHeap: number;
      withGraphHeap: number;
      pass: { refreshed: number; removed: number; added: number; durationMs: number };
    };
    const perNote = (n: number): number => Math.round(n / m.notes);
    console.log(
      `[scale] build ${Math.round(m.buildMs)} ms · index ${perNote(m.indexBytes)} B/note serialized, ` +
        `${perNote(m.indexHeap)} B/note heap, ${perNote(m.withGraphHeap)} B/note with the graph · ` +
        `idle reconcile ${Math.round(m.pass.durationMs)} ms`,
    );
    expect(m.notes).toBe(NOTES + 1);
    expect(m.buildMs).toBeLessThan(240_000);
    // Bounds sit about 1.4x above what this seed measures (2.0 KB serialized, 3.4 KB and 5.8 KB
    // of heap). With the copy in FrontmatterIndex.fromNote disabled the same seed measures
    // 11.4 KB and 13.9 KB, so the retention bug fails all three heap assertions.
    expect(perNote(m.indexBytes)).toBeLessThan(2_800);
    expect(perNote(m.indexHeap)).toBeLessThan(4_800);
    expect(perNote(m.withGraphHeap)).toBeLessThan(8_000);
    expect(m.indexHeap / m.indexBytes).toBeLessThan(2.5);
    expect(m.pass).toMatchObject({ refreshed: 0, removed: 0, added: 0 });
    expect(m.pass.durationMs).toBeLessThan(30_000);
  });

  it('answers every list-shaped call within what the strictest client accepts', async () => {
    h = await startHarness(undefined, null, root);
    const harness = h;
    const calls: [string, Record<string, unknown>][] = [
      ['vault_list', { path: '', depth: 3 }],
      ['vault_tags', {}],
      ['vault_links', { path: 'hub.md' }],
      ['vault_query', { where: [{ field: 'status', op: 'eq', value: 'open' }], limit: 500 }],
      ['vault_query', { groupBy: 'owner', countOnly: true }],
      ['vault_query', { groupBy: 'tags' }],
      ['vault_recent', { limit: 200 }],
      ['vault_search', { query: 'ordinary words', limit: 50 }],
      ['vault_search_frontmatter', { field: 'status', equals: 'open' }],
      ['vault_batch_read', { paths: Array.from({ length: 20 }, (_, i) => notePath(i * 1_000)) }],
      ['vault_analytics_findings', { category: 'orphan_notes', limit: 100 }],
    ];
    for (const [tool, args] of calls) {
      const t0 = performance.now();
      const r = await harness.call(tool, args);
      const ms = Math.round(performance.now() - t0);
      const chars = JSON.stringify(r.structuredContent ?? r.content).length;
      console.log(
        `[scale] ${tool} ${JSON.stringify(args).slice(0, 60)} → ${chars} chars in ${ms} ms`,
      );
      expect(r.isError, `${tool}: ${JSON.stringify(r.content).slice(0, 300)}`).toBeFalsy();
      expect(chars, tool).toBeLessThanOrEqual(CLIENT_SAFE_RESULT_CHARS);
      expect(ms, `${tool} took ${ms} ms`).toBeLessThan(30_000);
    }
  });
});
