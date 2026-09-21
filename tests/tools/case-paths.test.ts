import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness, text } from './harness.ts';

/**
 * A vault path is exact on every platform — the server behaves the same whether the underlying
 * filesystem folds letter case (Windows, and macOS by default) or not (Linux). Unlike
 * `tests/storage/local-fs-case.test.ts` (which forces and fakes case-insensitivity to exercise
 * the check's logic on this CI runner), these run everywhere with real, detected sensitivity and
 * assert the outcome each platform is supposed to produce: `h.runtime.adapter.caseInsensitive`
 * says which.
 */

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

describe('a vault path is exact on every platform', () => {
  it('reading a different case than what is on disk never returns the wrong note', async () => {
    await h.call('vault_write', { path: 'notes/Report.md', content: '# real\n' });
    const r = await h.call('vault_read', { path: 'notes/report.md' });
    if (h.runtime.adapter.caseInsensitive) {
      // Windows, macOS: the OS would otherwise silently resolve this to notes/Report.md.
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/^NOT_FOUND: /);
      expect(text(r)).toContain('Did you mean: "notes/Report.md"?');
    } else {
      // Linux: notes/report.md genuinely does not exist — same NOT_FOUND, same suggestion, for
      // the ordinary reason.
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/^NOT_FOUND: /);
      expect(text(r)).toContain('Did you mean: "notes/Report.md"?');
    }
  });

  it("writing a different case than an existing note never changes that note's bytes", async () => {
    const first = await h.call('vault_write', { path: 'notes/Report.md', content: 'first\n' });
    expect(first.isError).toBeFalsy();
    const second = await h.call('vault_write', { path: 'notes/report.md', content: 'second\n' });
    const original = text(await h.call('vault_read', { path: 'notes/Report.md' }));
    expect(original).toContain('first');

    if (h.runtime.adapter.caseInsensitive) {
      // Windows, macOS: refused outright — the alternative would be two index entries for one
      // on-disk file, and a note changed under a name the caller never read.
      expect(second.isError).toBe(true);
      expect(text(second)).toMatch(/^CONFLICT: /);
      expect(text(second)).toContain('differs only by letter case');
    } else {
      // Linux: a second, distinct file — legitimate there.
      expect(second.isError).toBeFalsy();
      const createdSeparately = text(await h.call('vault_read', { path: 'notes/report.md' }));
      expect(createdSeparately).toContain('second');
    }
  });
});
