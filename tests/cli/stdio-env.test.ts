import { describe, expect, it } from 'vitest';
import { stdioEnv } from '../../src/cli/stdio-env.ts';

/**
 * Found by running stdio against a real vault next to the HTTP server: the daily note came out at
 * the vault root instead of `Daily/`, because `./brainstem stdio` never read the install's `.env`.
 */
describe('stdioEnv', () => {
  const file = new Map([
    ['VAULT_PATH', '/home/u/vault'],
    ['DAILY_NOTES_FOLDER', 'Daily'],
    ['VAULT_TIMEZONE', 'Europe/Bucharest'],
    ['OWNER_SECRET', 'from-file'],
  ]);

  it('starts from the .env of the install, so the vault settings reach the server', () => {
    const env = stdioEnv(file, {});
    expect(env.VAULT_PATH).toBe('/home/u/vault');
    expect(env.DAILY_NOTES_FOLDER).toBe('Daily');
    expect(env.VAULT_TIMEZONE).toBe('Europe/Bucharest');
  });

  it('lets the process environment win, so a client can override one setting', () => {
    const env = stdioEnv(file, { DAILY_NOTES_FOLDER: 'Journal', UNRELATED: 'x' });
    expect(env.DAILY_NOTES_FOLDER).toBe('Journal');
    expect(env.VAULT_PATH).toBe('/home/u/vault');
  });

  it('ignores an empty value in the process environment (an unset variable passed through)', () => {
    expect(stdioEnv(file, { DAILY_NOTES_FOLDER: '' }).DAILY_NOTES_FOLDER).toBe('Daily');
  });

  it('works without a .env at all: --vault alone is a valid way to start', () => {
    expect(stdioEnv(null, { LOG_LEVEL: 'warn' })).toMatchObject({ LOG_LEVEL: 'warn' });
  });

  it('never hands the HTTP secrets to the stdio server', () => {
    const env = stdioEnv(file, { TUNNEL_TOKEN: 'from-process' });
    expect(env.OWNER_SECRET).toBeUndefined();
    expect(env.TUNNEL_TOKEN).toBeUndefined();
  });
});
