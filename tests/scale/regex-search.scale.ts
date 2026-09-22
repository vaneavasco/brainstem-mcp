import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalFSAdapter } from '../../src/storage/local-fs.ts';

/**
 * Regex search without ripgrep (`src/vault/safe-regex.ts`'s `compileSafeSearch`) at the scale the
 * Claude Desktop bundle actually runs at — a vault with no `rg` on PATH is the whole point of
 * that fallback. This seeds its own 40,000-note vault of realistic prose (deliberately different
 * shape from `vault.scale.ts`'s note fixture — plain paragraphs, not frontmatter-heavy — because
 * a regex search reads every LINE of every candidate file, and that's what dominates its cost)
 * and times six patterns chosen to cover what the required-literal prefilter can and cannot help
 * with: a plain literal, an optional character, two anchor-free structural patterns (a date, an
 * email address), a catastrophic-backtracking pattern (proving no exponential blowup, still true
 * after the prefilter/hot-path rework), and the alternation-of-literals case the prefilter
 * targets most directly (`(invoice|receipt)[- ]?(number|no\.?)\s*[0-9]{3,}`).
 *
 * Bounds here are deliberately loose and about the SHAPE of the result (a well-filtered pattern
 * finishes quickly; a pattern with no derivable literal — `(a+)+b` — does not get materially
 * worse) rather than a tight absolute number: full-vault regex search reads every candidate file
 * from disk one at a time (`LocalFSAdapter.searchJs`), so on a machine/filesystem with higher
 * per-file I/O latency (measured here: reading all 40,000 files alone costs ~3.5 s, independent
 * of anything this module does) the floor is I/O, not the NFA — a CI runner or a sandboxed
 * filesystem can be meaningfully slower than a workstation's local disk at that specific thing.
 * `vault_search`'s own advice (tags/where/glob to narrow candidates first) is the real answer to
 * a slow full-vault scan; this test measures the unscoped worst case on purpose.
 */
const NOTES = 40_000;
const FOLDERS = 200;

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

const name = (i: number): string => `working-note-${String(i).padStart(5, '0')}`;
const folder = (i: number): string => `area-${String(i % FOLDERS).padStart(3, '0')}`;
const notePath = (i: number): string => `${folder(i)}/${name(i)}.md`;

const WORDS = [
  'the',
  'quick',
  'brown',
  'fox',
  'jumps',
  'over',
  'lazy',
  'dog',
  'server',
  'vault',
  'note',
  'project',
  'plan',
  'review',
  'meeting',
];

/** One note of ordinary prose, a frontmatter date, and — in one note per thousand — a line
 *  carrying a rare literal (an email address, an invoice/receipt mention) so the well-filtered
 *  patterns have real, sparse hits to find rather than always scanning to a limit or to nothing. */
function noteText(i: number, rand: () => number): string {
  const pick = (n: number): number => Math.floor(rand() * n);
  const day = `2026-${String(1 + pick(12)).padStart(2, '0')}-${String(1 + pick(28)).padStart(2, '0')}`;
  const paragraph = Array.from({ length: 60 }, () => WORDS[pick(WORDS.length)]).join(' ');
  const rare =
    pick(1000) === 0
      ? ' Contact jane.doe@example.com about invoice number 48213 or receipt no. 991.'
      : '';
  return `---\ntitle: ${name(i)}\ndate: ${day}\n---\n\n# ${name(i)}\n\n${paragraph}\n${paragraph}\n${paragraph}${rare}\n`;
}

async function seed(root: string): Promise<void> {
  const rand = mulberry32(0x5ca1e);
  for (let f = 0; f < FOLDERS; f += 1)
    await fs.mkdir(path.join(root, folder(f)), { recursive: true });
  const CHUNK = 500;
  for (let start = 0; start < NOTES; start += CHUNK) {
    const writes: Promise<void>[] = [];
    for (let i = start; i < Math.min(start + CHUNK, NOTES); i += 1) {
      writes.push(fs.writeFile(path.join(root, notePath(i)), noteText(i, rand)));
    }
    await Promise.all(writes);
  }
}

interface PatternCase {
  name: string;
  pattern: string;
  /** Loose ceiling on a CI-scale run; see the module doc comment on why this is generous. */
  maxMs: number;
  /** When set, the match count must be at least this many (proves the pattern really did find
   *  its sprinkled rare hits, not just "ran fast because it matched nothing"). */
  minHits?: number;
}

const PATTERNS: PatternCase[] = [
  { name: 'literal ("invoice")', pattern: 'invoice', maxMs: 20_000, minHits: 1 },
  { name: 'colou?r (optional char)', pattern: 'colou?r', maxMs: 20_000 },
  {
    name: 'dates (\\d{4}-\\d{2}-\\d{2})',
    pattern: '\\d{4}-\\d{2}-\\d{2}',
    maxMs: 20_000,
    minHits: 1,
  },
  {
    name: 'email-like',
    pattern: '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}',
    maxMs: 20_000,
    minHits: 1,
  },
  // No derivable required literal ('a' alone is far too common to filter anything): this is the
  // linear-time guarantee at vault scale, not a prefilter win. Its own ceiling is looser.
  { name: 'pathological (a+)+b', pattern: '(a+)+b', maxMs: 30_000 },
  {
    name: 'invoice-or-receipt (real example)',
    pattern: '(invoice|receipt)[- ]?(number|no\\.?)\\s*[0-9]{3,}',
    maxMs: 20_000,
    minHits: 1,
  },
];

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-regex-scale-'));
  const t0 = performance.now();
  await seed(root);
  console.log(`[regex-scale] seeded ${NOTES} notes in ${Math.round(performance.now() - t0)} ms`);
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe(`regex search (builtin engine, no ripgrep) over ${NOTES} notes`, () => {
  it('the required-literal prefilter keeps every pattern within a loose, I/O-dominated bound', async () => {
    const adapter = await LocalFSAdapter.create(root, { ripgrepPath: null });
    expect(adapter.capabilities().nativeSearch).toBe(false); // proves this really exercises the fallback

    const results: string[] = [];
    for (const { name: patternName, pattern, maxMs, minHits } of PATTERNS) {
      const started = performance.now();
      const matches = await adapter.search(pattern, { regex: true, limit: 2000 });
      const elapsedMs = performance.now() - started;
      results.push(
        `${patternName.padEnd(34)} ${Math.round(elapsedMs)
          .toString()
          .padStart(6)} ms  hits=${matches.length}`,
      );
      expect(elapsedMs, patternName).toBeLessThan(maxMs);
      if (minHits !== undefined)
        expect(matches.length, patternName).toBeGreaterThanOrEqual(minHits);
    }
    console.log(`[regex-scale]\n${results.join('\n')}`);
  }, 300_000);
});
