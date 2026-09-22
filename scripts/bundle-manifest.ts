/**
 * `npm run bundle:manifest` (part of `npm run bundle`) — generates `bundle/manifest.json` from
 * `package.json` plus a static template. The version is never hand-edited: it is read from
 * `package.json` at generation time, the same source `tests/release/version-consistency.test.ts`
 * checks against. The `tools` list is generated too, from the real tool registry
 * (`registerVaultTools`, the same function `src/mcp/factory.ts` calls) rather than typed out by
 * hand, so it cannot drift from what the bundle actually serves.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { registerVaultTools } from '../src/tools/register.ts';
import { createLocalRuntime, type VaultRuntime } from '../src/vault/runtime.ts';
import { renderIconPng } from './bundle-icon.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');

interface PackageJson {
  version: string;
  description: string;
  license: string;
  author: string;
  repository: { type: string; url: string };
  homepage: string;
}

export interface ManifestTool {
  name: string;
  description?: string;
}

/**
 * Boots a real (throwaway) vault runtime and registers the real vault tools onto a fresh
 * `McpServer` — no HTTP, no stdio, just an in-memory transport pair — so this list is exactly
 * what `registerVaultTools` produces, the same call `createVaultServer` makes for both the HTTP
 * and the stdio server. `brainstem_ping`/`brainstem_guide` are registered directly by
 * `src/mcp/factory.ts`, not by `registerVaultTools`, and are intentionally left out here: they
 * are server plumbing, not vault tools a user picks the extension for.
 */
export async function generateToolList(): Promise<ManifestTool[]> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-manifest-'));
  let runtime: VaultRuntime | undefined;
  try {
    runtime = await createLocalRuntime({
      vaultPath: tmpDir,
      ripgrepPath: null,
      stateDir: path.join(tmpDir, '_brainstem'),
    });
    const server = new McpServer({ name: 'brainstem-mcp-manifest-gen', version: '0.0.0' });
    registerVaultTools(server, { runtime, log: () => {}, readOnly: false });

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: 'bundle-manifest-generator', version: '0.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    await client.close();
    await server.close();
    return tools
      .map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    if (runtime) await runtime.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/** Pure — takes everything it needs as arguments, so `tests/release/version-consistency.test.ts`
 *  (and any other test) can check its shape without touching the filesystem or booting a vault. */
export function buildManifest(pkg: PackageJson, tools: ManifestTool[]): Record<string, unknown> {
  return {
    manifest_version: '0.3',
    name: 'brainstem-mcp',
    display_name: 'Brainstem',
    version: pkg.version,
    // package.json describes the whole repository (Docker, the tunnel): this file describes what
    // is installed, which is the stdio server alone.
    description:
      'Read and write an Obsidian vault on this machine from Claude Desktop: search, query, edit — ' +
      'no server, no account, no network.',
    long_description:
      'Read and write your Obsidian vault from Claude Desktop: search, query by frontmatter, edit notes, canvases and bases, keep links intact on rename, and stay safe with optimistic-concurrency writes. Runs entirely on your machine — no server, no account, no network port. Regex search works either way; installing ripgrep (recommended, not required) gives it the full regular-expression syntax and makes it faster.',
    author: { name: pkg.author, url: pkg.homepage },
    repository: pkg.repository,
    homepage: pkg.homepage,
    license: pkg.license,
    icon: 'icon.png',
    keywords: ['obsidian', 'vault', 'notes', 'knowledge-base', 'markdown', 'search'],
    server: {
      type: 'node',
      entry_point: 'dist/stdio-main.js',
      // Every `${...}` below is MCPB's OWN placeholder syntax (substituted by Claude Desktop at
      // launch — see `getMcpConfigForManifest` in @anthropic-ai/mcpb's shared/config.js), not a
      // JS template literal: these must stay plain, single-quoted strings.
      mcp_config: {
        command: 'node',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: MCPB placeholder, not JS
        args: ['${__dirname}/dist/stdio-main.js', '--vault', '${user_config.vault}'],
        env: {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: MCPB placeholder, not JS
          VAULT_READ_ONLY: '${user_config.read_only}',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: MCPB placeholder, not JS
          VAULT_TIMEZONE: '${user_config.timezone}',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: MCPB placeholder, not JS
          DAILY_NOTES_FOLDER: '${user_config.daily_notes_folder}',
        },
      },
    },
    tools,
    tools_generated: false,
    user_config: {
      vault: {
        type: 'directory',
        title: 'Vault folder',
        description:
          'The Obsidian vault folder this server reads and writes. Any folder works, including an empty one — this creates nothing outside it.',
        required: true,
      },
      read_only: {
        type: 'boolean',
        title: 'Read-only',
        description:
          'Offer only the tools that read, search and list — nothing that can change a note, canvas or file. Recommended for a vault you only want to ask questions about, or one synced between people.',
        required: false,
        default: false,
      },
      timezone: {
        type: 'string',
        title: 'Timezone',
        description:
          'For daily notes. An IANA name from the tz database, region/city, such as Europe/Berlin, Europe/Bucharest or America/New_York; not an abbreviation like EET or CET, which is ignored. Leave as UTC if unsure.',
        required: false,
        default: 'UTC',
      },
      daily_notes_folder: {
        type: 'string',
        title: 'Daily notes folder',
        description:
          'Vault-relative folder daily notes are read from and appended to (e.g. Daily). Leave blank for the vault root.',
        required: false,
        default: '',
      },
    },
    compatibility: {
      // Measured 2026-09-21 (Phase 0 of the Claude Desktop integration plan): the first Desktop
      // build seen carrying Node 24, on Windows 11 (Claude_2.2553.1.0_x64) and confirmed on
      // macOS/Apple silicon the same day.
      claude_desktop: '>=2.2553.1',
      platforms: ['darwin', 'win32', 'linux'],
      runtimes: { node: '>=24' },
    },
  };
}

export async function writeManifest(outPath: string): Promise<Record<string, unknown>> {
  const pkg = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'),
  ) as PackageJson;
  const tools = await generateToolList();
  const manifest = buildManifest(pkg, tools);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

/** 512×512 is `mcpb validate`'s own recommended size for the best display in Claude Desktop. */
export async function writeIcon(outPath: string): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, renderIconPng(512));
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const manifestPath = path.join(repoRoot, 'bundle', 'manifest.json');
  const iconPath = path.join(repoRoot, 'bundle', 'icon.png');
  const manifest = await writeManifest(manifestPath);
  await writeIcon(iconPath);
  console.log(
    `wrote ${path.relative(repoRoot, manifestPath)} (v${(manifest as { version: string }).version}, ${(manifest.tools as unknown[]).length} tools) and ${path.relative(repoRoot, iconPath)}`,
  );
}
