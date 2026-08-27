import { describe, expect, it } from 'vitest';

describe('toolchain', () => {
  it('runs TypeScript tests under vitest', () => {
    const answer: number = 40 + 2;
    expect(answer).toBe(42);
  });
});
