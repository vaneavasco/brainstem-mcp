import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.ts';

function collect(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines: () => chunks.join('').trim().split('\n') };
}

describe('createLogger', () => {
  it('emits JSON lines at or above the configured level', () => {
    const sink = collect();
    const log = createLogger('info', sink.stream);
    log.debug('hidden');
    log.info({ requestId: 'r1' }, 'visible');
    const entries = sink.lines().map((l) => JSON.parse(l));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: 30, msg: 'visible', requestId: 'r1' });
  });

  it('redacts tokens, secrets and authorization headers anywhere in the payload', () => {
    const sink = collect();
    const log = createLogger('info', sink.stream);
    log.info(
      {
        token: 'tok-secret',
        access_token: 'acc-secret',
        refresh_token: 'ref-secret',
        req: { headers: { authorization: 'Bearer abc123' } },
        nested: { refresh_token: 'deep-secret', client_secret: 'cs-secret' },
      },
      'auth event',
    );
    const raw = sink.lines().join('\n');
    for (const secret of [
      'tok-secret',
      'acc-secret',
      'ref-secret',
      'abc123',
      'deep-secret',
      'cs-secret',
    ]) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).toContain('[REDACTED]');
  });
});
