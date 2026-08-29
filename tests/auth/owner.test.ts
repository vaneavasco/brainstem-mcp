import { describe, expect, it } from 'vitest';
import { createOwnerAuth } from '../../src/auth/owner.ts';

describe('createOwnerAuth', () => {
  it('accepts the exact secret and rejects everything else', () => {
    const auth = createOwnerAuth('s3cret-s3cret-s3cret-s3cret-s3cret');
    expect(auth.verify('s3cret-s3cret-s3cret-s3cret-s3cret')).toEqual({ ok: true });
    expect(auth.verify('s3cret-s3cret-s3cret-s3cret-s3creT').ok).toBe(false);
    expect(auth.verify('').ok).toBe(false);
  });
  it('locks after 5 failures within a minute and unlocks after the lockout', () => {
    let t = 0;
    const auth = createOwnerAuth('right', { now: () => t });
    for (let i = 0; i < 4; i++)
      expect(auth.verify('wrong')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(auth.verify('wrong')).toMatchObject({ ok: false, reason: 'locked', retryAfterS: 900 }); // 5th failure trips the lock
    expect(auth.verify('right')).toMatchObject({ ok: false, reason: 'locked' });
    expect(auth.isLocked()).toBe(true);
    t = 15 * 60_000;
    expect(auth.verify('right')).toEqual({ ok: true });
  });
  it('forgets failures older than the window', () => {
    let t = 0;
    const auth = createOwnerAuth('right', { now: () => t });
    for (let i = 0; i < 4; i++) auth.verify('wrong');
    t = 61_000;
    auth.verify('wrong');
    expect(auth.verify('right')).toEqual({ ok: true });
  });
});
