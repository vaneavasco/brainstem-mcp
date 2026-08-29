import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { createLocalRuntime, type VaultRuntime } from '../src/vault/runtime.ts';
import { baseEnv } from './helpers/env.ts';

const config = loadConfig(baseEnv());
const logger = createLogger('fatal');

let server: Server;
let baseUrl: string;
let port: number;
let runtime: VaultRuntime;
let vaultRoot: string;

beforeAll(async () => {
  vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-app-'));
  runtime = await createLocalRuntime({ vaultPath: vaultRoot, ripgrepPath: null });
  const { app } = createApp(config, logger, async () => runtime);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  ({ port } = server.address() as AddressInfo);
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await runtime.close();
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

describe('GET /health', () => {
  it('reports ok with server identity and no secrets', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'ok', name: 'brainstem-mcp' });
    expect(typeof body.version).toBe('string');
  });
});

describe('/mcp with a 2026-07-28 (modern) client', () => {
  it('lists brainstem_ping with annotations and calls it', async () => {
    const client = new Client(
      { name: 'test-modern', version: '0.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    try {
      const { tools } = await client.listTools();
      const ping = tools.find((t) => t.name === 'brainstem_ping');
      expect(ping).toBeDefined();
      expect(ping?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      const result = await client.callTool({ name: 'brainstem_ping', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ server: 'brainstem-mcp', era: 'modern' });
    } finally {
      await client.close();
    }
  });

  it('advertises tools/list cache hints (ttlMs 1h, public) on a raw modern request', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { ttlMs?: number; cacheScope?: string } };
    expect(body.result.ttlMs).toBe(3_600_000);
    expect(body.result.cacheScope).toBe('public');
  });

  it('rejects a modern request whose Mcp-Method header disagrees with the body', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'prompts/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32020);
  });
});

describe('/mcp with a 2025-era (legacy) client', () => {
  it('completes the initialize handshake statelessly and calls the tool', async () => {
    const client = new Client({ name: 'test-legacy', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('brainstem_ping');
      const result = await client.callTool({ name: 'brainstem_ping', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ era: 'legacy' });
    } finally {
      await client.close();
    }
  });

  it('answers legacy GET (standalone SSE) and DELETE with 405', async () => {
    const get = await fetch(`${baseUrl}/mcp`, { headers: { accept: 'text/event-stream' } });
    expect(get.status).toBe(405);
    const del = await fetch(`${baseUrl}/mcp`, { method: 'DELETE' });
    expect(del.status).toBe(405);
  });
});

describe('error shaping', () => {
  it('returns a JSON-RPC parse error for malformed JSON, never the Express HTML/stack page', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    const text = await res.text();
    expect(text).not.toContain('node_modules');
    expect(text).not.toContain('SyntaxError');
    const body = JSON.parse(text) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it('returns a JSON-RPC error for an oversized body instead of the Express HTML page', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(3 * 1024 * 1024) }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32600);
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });
});

describe('transport hardening', () => {
  it('rejects a browser Origin that is not allowed with 403', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        origin: 'https://evil.example',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/list',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects an unexpected Host header with 403', async () => {
    // Node's built-in fetch (undici) silently drops/overrides a custom `host`
    // header, so this exercises the real HTTP wire via node:http instead.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/health', headers: { Host: 'attacker.example' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});

describe('legacy mode reject', () => {
  const rejectConfig = loadConfig(baseEnv({ MCP_LEGACY_MODE: 'reject' }));

  let rejectServer: Server;
  let rejectBaseUrl: string;

  beforeAll(async () => {
    const { app } = createApp(rejectConfig, logger, async () => runtime);
    rejectServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port: rejectPort } = rejectServer.address() as AddressInfo;
    rejectBaseUrl = `http://127.0.0.1:${rejectPort}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      rejectServer.close((e) => (e ? reject(e) : resolve())),
    );
  });

  it('still serves a modern client', async () => {
    const client = new Client(
      { name: 'test-modern-reject', version: '0.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`${rejectBaseUrl}/mcp`)));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('brainstem_ping');
    } finally {
      await client.close();
    }
  });

  it('rejects a legacy (default) client', async () => {
    const client = new Client({ name: 'test-legacy-reject', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${rejectBaseUrl}/mcp`));
    await expect(client.connect(transport)).rejects.toThrow();
  });
});
