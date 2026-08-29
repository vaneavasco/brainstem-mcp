import { createHash, timingSafeEqual } from 'node:crypto';

export interface OwnerAuthOptions {
  now?: () => number;
  maxAttempts?: number;
  windowMs?: number;
  lockoutMs?: number;
}
export type OwnerVerdict =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'locked'; retryAfterS: number };
export interface OwnerAuth {
  verify(candidate: string): OwnerVerdict;
  isLocked(): boolean;
}

export function createOwnerAuth(secret: string, opts: OwnerAuthOptions = {}): OwnerAuth {
  const now = opts.now ?? Date.now;
  const maxAttempts = opts.maxAttempts ?? 5;
  const windowMs = opts.windowMs ?? 60_000;
  const lockoutMs = opts.lockoutMs ?? 15 * 60_000;
  const expected = createHash('sha256').update(secret, 'utf8').digest();
  let failures: number[] = [];
  let lockedUntil = 0;

  const isLocked = (): boolean => now() < lockedUntil;

  return {
    isLocked,
    verify(candidate) {
      const t = now();
      if (t < lockedUntil) {
        return { ok: false, reason: 'locked', retryAfterS: Math.ceil((lockedUntil - t) / 1000) };
      }
      const actual = createHash('sha256').update(candidate, 'utf8').digest();
      if (timingSafeEqual(actual, expected)) {
        failures = [];
        return { ok: true };
      }
      failures = failures.filter((f) => t - f < windowMs);
      failures.push(t);
      if (failures.length >= maxAttempts) {
        lockedUntil = t + lockoutMs;
        failures = [];
        return { ok: false, reason: 'locked', retryAfterS: Math.ceil(lockoutMs / 1000) };
      }
      return { ok: false, reason: 'invalid', retryAfterS: 0 };
    },
  };
}
