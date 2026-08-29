import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cacheTtlMs, createCimdResolver, validateClientIdUrl } from '../../src/auth/as/cimd.ts';
import { assertPublicAddress, fetchClientMetadataDocument } from '../../src/auth/as/net.ts';
import { FileTokenStore } from '../../src/auth/store/file-store.ts';
import { createLogger } from '../../src/logger.ts';

describe('assertPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:10.0.0.1',
  ])('rejects %s', (ip) => {
    expect(() => assertPublicAddress(ip)).toThrow(/special-use/);
  });
  it.each(['104.16.1.1', '2606:4700::1111'])('accepts %s', (ip) => {
    expect(() => assertPublicAddress(ip)).not.toThrow();
  });
});

describe('validateClientIdUrl', () => {
  it('requires https with an explicit path and no credentials/fragment/dot segments', () => {
    expect(
      validateClientIdUrl('https://claude.ai/oauth/claude-code-client-metadata').pathname,
    ).toBe('/oauth/claude-code-client-metadata');
    for (const bad of [
      'http://claude.ai/x',
      'https://claude.ai',
      'https://claude.ai/',
      'https://u:p@claude.ai/x',
      'https://claude.ai/x#f',
      'https://claude.ai/a/../x',
      'not a url',
    ]) {
      expect(() => validateClientIdUrl(bad)).toThrow();
    }
  });
});

describe('cacheTtlMs', () => {
  it('prefers s-maxage, then max-age, then Expires; no-store/private disable caching', () => {
    expect(cacheTtlMs({ 'cache-control': 'public, max-age=60, s-maxage=120' }, 0)).toBe(120_000);
    expect(cacheTtlMs({ 'cache-control': 'max-age=60' }, 0)).toBe(60_000);
    expect(cacheTtlMs({ expires: new Date(30_000).toUTCString() }, 0)).toBe(30_000);
    expect(cacheTtlMs({ 'cache-control': 'no-store' }, 0)).toBe(0);
    expect(cacheTtlMs({ 'cache-control': 'private, max-age=60' }, 0)).toBe(0);
    expect(cacheTtlMs({}, 0)).toBe(3_600_000);
  });
});

describe('fetchClientMetadataDocument + resolver', () => {
  let server: http.Server;
  let port: number;
  let mode = 'ok';
  const doc = (clientId: string) =>
    JSON.stringify({
      client_id: clientId,
      client_name: 'Test Client',
      redirect_uris: ['http://localhost/callback', 'https://claude.ai/api/mcp/auth_callback'],
      token_endpoint_auth_method: 'none',
    });
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const clientId = `https://claude.ai${req.url}`;
      if (mode === 'redirect') {
        res.writeHead(302, { location: 'https://evil.example/x' });
        return res.end();
      }
      if (mode === 'html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<html>');
      }
      if (mode === 'big') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(`{"pad":"${'x'.repeat(6000)}"}`);
      }
      if (mode === 'mismatch') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(doc('https://claude.ai/other'));
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=300' });
      res.end(doc(clientId));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const mk = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-cimd-'));
    const store = await FileTokenStore.open(path.join(dir, 'state.json'));
    let now = 1_000_000;
    const resolver = createCimdResolver({
      allowedHosts: ['claude.ai'],
      store,
      now: () => now,
      logger: createLogger('fatal'),
      lookup: async () => '104.16.1.1',
      fetchDocument: (url, o) =>
        fetchClientMetadataDocument(new URL(`http://127.0.0.1:${port}${url.pathname}`), {
          ...o,
          ip: '127.0.0.1',
          allowInsecureHttp: true,
        }),
    });
    return {
      resolver,
      store,
      tick: (ms: number) => {
        now += ms;
      },
    };
  };

  it('resolves, validates and caches an allowed client', async () => {
    mode = 'ok';
    const { resolver, store, tick } = await mk();
    const rec = await resolver.resolveClient('https://claude.ai/oauth/test-client');
    expect(rec).toMatchObject({
      clientName: 'Test Client',
      redirectUris: expect.arrayContaining(['http://localhost/callback']),
    });
    expect((await store.getClient('https://claude.ai/oauth/test-client'))?.expiresAt).toBe(
      1_000_000 + 300_000,
    );
    mode = 'html'; // cached copy must be used, so the html server is never consulted
    tick(1_000);
    expect((await resolver.resolveClient('https://claude.ai/oauth/test-client')).clientName).toBe(
      'Test Client',
    );
  });
  it('rejects hosts outside the allowlist without fetching', async () => {
    const { resolver } = await mk();
    await expect(resolver.resolveClient('https://evil.example/c')).rejects.toMatchObject({
      code: 'invalid_client',
    });
  });
  it.each(['redirect', 'html', 'big', 'mismatch'])('rejects a %s document', async (m) => {
    mode = m;
    const { resolver } = await mk();
    await expect(resolver.resolveClient(`https://claude.ai/oauth/${m}`)).rejects.toMatchObject({
      code: 'invalid_client',
    });
  });
  it('negative-caches a failure for 5 minutes', async () => {
    mode = 'html';
    const { resolver, store } = await mk();
    await expect(resolver.resolveClient('https://claude.ai/oauth/neg')).rejects.toBeDefined();
    expect((await store.getClient('https://claude.ai/oauth/neg'))?.negative).toBe(true);
    mode = 'ok';
    await expect(resolver.resolveClient('https://claude.ai/oauth/neg')).rejects.toBeDefined(); // still negative
  });
});
