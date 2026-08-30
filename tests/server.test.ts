import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthDeps } from '../src/auth/mount.ts';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { startServer } from '../src/server.ts';
import { createLocalRuntime, type VaultRuntime } from '../src/vault/runtime.ts';
import { createTestAuth } from './helpers/auth.ts';
import { baseEnv } from './helpers/env.ts';

let runtime: VaultRuntime;
let vaultRoot: string;
let auth: AuthDeps;

beforeEach(async () => {
  vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-server-'));
  runtime = await createLocalRuntime({ vaultPath: vaultRoot, ripgrepPath: null });
  const config = loadConfig(baseEnv());
  ({ auth } = await createTestAuth(config, vaultRoot));
});

afterEach(async () => {
  await runtime.close();
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

describe('startServer', () => {
  it('listens with proxy-friendly keep-alive settings and closes cleanly', async () => {
    const config = loadConfig(baseEnv());
    const running = await startServer(config, createLogger('fatal'), async () => runtime, auth, 0);
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
    const config = loadConfig(baseEnv());
    const running = await startServer(config, createLogger('fatal'), async () => runtime, auth, 0);
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

  it('aborts a still-open exchange after the drain window', async () => {
    const config = loadConfig(baseEnv());
    const running = await startServer(config, createLogger('fatal'), async () => runtime, auth, 0, {
      drainMs: 300,
    });
    const { port } = running.httpServer.address() as AddressInfo;

    const socket = net.connect({ host: '127.0.0.1', port });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    let socketClosed = false;
    const socketClosedPromise = new Promise<void>((resolve) => {
      socket.once('close', () => {
        socketClosed = true;
        resolve();
      });
    });
    // Start a request but never finish the body: a permanently in-flight exchange.
    socket.write(
      'POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"jsonrpc"',
    );

    const start = performance.now();
    const closed = await Promise.race([
      running.close().then(() => 'closed' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5_000)),
    ]);
    const elapsed = performance.now() - start;
    // The FIN triggered by closeAllConnections() reaches the client socket asynchronously
    // (a loopback round trip after the server side has already resolved close()).
    await Promise.race([socketClosedPromise, new Promise((resolve) => setTimeout(resolve, 1_000))]);

    expect(closed).toBe('closed');
    expect(socketClosed).toBe(true);
    expect(running.httpServer.listening).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(250);

    socket.destroy();
  });
});
