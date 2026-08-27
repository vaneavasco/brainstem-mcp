import http from 'node:http';
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

  it('closes promptly even when an idle keep-alive connection is open', async () => {
    const config = loadConfig({ PUBLIC_URL: 'https://brainstem.example.com' });
    const running = await startServer(config, createLogger('fatal'), 0);
    const { port } = running.httpServer.address() as AddressInfo;
    const agent = new http.Agent({ keepAlive: true });
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/health', agent }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end();
    });
    const closed = await Promise.race([
      running.close().then(() => 'closed' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3_000)),
    ]);
    agent.destroy();
    expect(closed).toBe('closed');
    expect(running.httpServer.listening).toBe(false);
  });
});
