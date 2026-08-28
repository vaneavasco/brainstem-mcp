import { describe, expect, it } from 'vitest';
import {
  assertBatchSize,
  assertWithinSize,
  extensionAllowedFor,
  MAX_BATCH,
  MAX_FILE_BYTES,
} from '../../src/storage/limits.ts';
import { VaultError } from '../../src/storage/types.ts';

describe('limits', () => {
  it('accepts sizes up to the cap and rejects above it with TOO_LARGE', () => {
    expect(() => assertWithinSize(MAX_FILE_BYTES, 'file')).not.toThrow();
    let err: unknown;
    try {
      assertWithinSize(MAX_FILE_BYTES + 1, 'file');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VaultError);
    expect((err as VaultError).code).toBe('TOO_LARGE');
    expect((err as VaultError).message).toContain('1048576');
  });

  it('caps batch sizes at MAX_BATCH', () => {
    expect(() => assertBatchSize(MAX_BATCH)).not.toThrow();
    expect(() => assertBatchSize(MAX_BATCH + 1)).toThrow(VaultError);
    expect(() => assertBatchSize(0)).toThrow(VaultError);
  });

  it('matches binary extensions to their mime type', () => {
    expect(extensionAllowedFor('image/png', 'img/a.png')).toBe(true);
    expect(extensionAllowedFor('image/jpeg', 'img/a.JPG')).toBe(true);
    expect(extensionAllowedFor('image/jpeg', 'img/a.jpeg')).toBe(true);
    expect(extensionAllowedFor('application/pdf', 'docs/a.pdf')).toBe(true);
    expect(extensionAllowedFor('image/png', 'img/a.jpg')).toBe(false);
    expect(extensionAllowedFor('application/x-msdownload', 'a.exe')).toBe(false);
    expect(extensionAllowedFor('text/html', 'a.html')).toBe(false);
  });
});
