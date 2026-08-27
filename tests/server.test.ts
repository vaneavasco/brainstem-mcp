import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { startServer } from '../src/server.ts';

describe('startServer', () => {
  it('listens with Heroku-compatible keep-alive settings and closes cleanly', async () => {
    const config = loadConfig({ PUBLIC_URL: 'https://brainstem.example.com' });
    const running = await startServer(config, createLogger('fatal'), 0);
    try {
      const { port } = running.httpServer.address() as AddressInfo;
      expect(port).toBeGreaterThan(0);
      expect(running.httpServer.keepAliveTimeout).toBe(95_000);
      expect(running.httpServer.headersTimeout).toBeGreaterThan(95_000);
      expect(running.httpServer.requestTimeout).toBe(0);
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
    } finally {
      await running.close();
    }
    expect(running.httpServer.listening).toBe(false);
  });
});
