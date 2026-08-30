import { describe, expect, it } from 'vitest';
import {
  assertBatchSize,
  assertWithinSize,
  extensionAllowedFor,
  MAX_BATCH,
  MAX_BINARY_BYTES,
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

  it('accepts a custom limit and reports it in the message', () => {
    expect(() => assertWithinSize(100, 'blob', 100)).not.toThrow();
    let err: unknown;
    try {
      assertWithinSize(101, 'blob', 100);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VaultError);
    expect((err as VaultError).code).toBe('TOO_LARGE');
    expect((err as VaultError).message).toContain('100 bytes');
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

  it("matches Obsidian's extended attachment formats, including the dual-MIME .webm case", () => {
    expect(extensionAllowedFor('image/avif', 'img/a.avif')).toBe(true);
    expect(extensionAllowedFor('image/bmp', 'img/a.bmp')).toBe(true);
    expect(extensionAllowedFor('image/svg+xml', 'img/a.svg')).toBe(true);
    expect(extensionAllowedFor('audio/mpeg', 'audio/a.mp3')).toBe(true);
    expect(extensionAllowedFor('audio/mp4', 'audio/a.m4a')).toBe(true);
    expect(extensionAllowedFor('audio/ogg', 'audio/a.ogg')).toBe(true);
    expect(extensionAllowedFor('audio/wav', 'audio/a.wav')).toBe(true);
    expect(extensionAllowedFor('audio/flac', 'audio/a.flac')).toBe(true);
    expect(extensionAllowedFor('audio/3gpp', 'audio/a.3gp')).toBe(true);
    expect(extensionAllowedFor('video/mp4', 'video/a.mp4')).toBe(true);
    expect(extensionAllowedFor('video/quicktime', 'video/a.mov')).toBe(true);
    expect(extensionAllowedFor('video/x-matroska', 'video/a.mkv')).toBe(true);
    expect(extensionAllowedFor('video/ogg', 'video/a.ogv')).toBe(true);
    // .webm is listed under both audio/webm and video/webm — either MIME accepts it.
    expect(extensionAllowedFor('audio/webm', 'audio/a.webm')).toBe(true);
    expect(extensionAllowedFor('video/webm', 'video/a.webm')).toBe(true);
    // But a mismatched extension is still rejected under either MIME.
    expect(extensionAllowedFor('audio/webm', 'audio/a.mp4')).toBe(false);
    expect(extensionAllowedFor('video/webm', 'video/a.mp3')).toBe(false);
  });

  it('MAX_BINARY_BYTES defaults to 8 MiB', () => {
    expect(MAX_BINARY_BYTES).toBe(8 * 1024 * 1024);
  });
});
