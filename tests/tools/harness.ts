import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { createLogger } from '../../src/logger.ts';
import {
  createLocalRuntime,
  type LocalRuntimeOptions,
  type VaultRuntime,
} from '../../src/vault/runtime.ts';
import { baseEnv } from '../helpers/env.ts';

export interface Harness {
  client: Client;
  runtime: VaultRuntime;
  root: string;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export async function startHarness(overrides?: LocalRuntimeOptions['settings']): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-tools-'));
  const runtime = await createLocalRuntime({
    vaultPath: root,
    ripgrepPath: null,
    settings: overrides,
  });
  const config = loadConfig(baseEnv());
  const { app } = createApp(config, createLogger('fatal'), async () => runtime);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const client = new Client(
    { name: 'harness', version: '0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return {
    client,
    runtime,
    root,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    async close() {
      await client.close();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await runtime.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

export function text(result: CallToolResult): string {
  const first = result.content[0];
  return first && first.type === 'text' ? first.text : '';
}
