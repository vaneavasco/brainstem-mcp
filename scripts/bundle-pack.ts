/**
 * `npm run bundle` — the whole Claude Desktop bundle: `bundle:build` + the manifest and icon +
 * a copied LICENSE and a short in-bundle README excerpt, `mcpb validate`, then `mcpb pack` into
 * `release/brainstem-mcp-<version>.mcpb`, a second copy at the fixed name
 * `release/brainstem-mcp.mcpb` (so `…/releases/latest/download/brainstem-mcp.mcpb` never
 * changes), and `release/SHA256SUMS` covering both.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundleBuild } from './bundle-build.ts';
import { writeIcon, writeManifest } from './bundle-manifest.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const bundleDir = path.join(repoRoot, 'bundle');
const releaseDir = path.join(repoRoot, 'release');
const mcpbBin = path.join(repoRoot, 'node_modules', '.bin', 'mcpb');

const BUNDLE_README = `# brainstem-mcp

A single-user, self-hosted MCP server giving Claude read/write access to your Obsidian vault —
search, query by frontmatter, edit notes/canvases/bases, safe concurrent writes.

This \`.mcpb\` is the **stdio** server only: no port, no account, no network — it runs as your
own OS user against the vault folder you choose during install. The path policy, size limits
and optimistic-concurrency checks that protect the vault from the model apply exactly as they
do everywhere else this server runs (Docker + a tunnel, or \`claude mcp add\`).

Regex search (\`vault_search({ regex: true })\`) works with or without ripgrep on \`PATH\`;
installing it (recommended, not required) gives the full syntax and is faster —
\`brainstem_ping\`'s \`search.regexEngine\` says which is active.

Full documentation, source and the changelog: <https://github.com/vaneavasco/brainstem-mcp>.
`;

interface PackageJson {
  version: string;
}

async function copyLicenseAndReadme(): Promise<void> {
  await fs.copyFile(path.join(repoRoot, 'LICENSE'), path.join(bundleDir, 'LICENSE'));
  await fs.writeFile(path.join(bundleDir, 'README.md'), BUNDLE_README, 'utf8');
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
}

export interface BundlePackResult {
  version: string;
  versionedPath: string;
  fixedPath: string;
  sumsPath: string;
}

export async function bundlePack(): Promise<BundlePackResult> {
  const { version } = await bundleBuild();
  await writeManifest(path.join(bundleDir, 'manifest.json'));
  await writeIcon(path.join(bundleDir, 'icon.png'));
  await copyLicenseAndReadme();

  // Fails loudly (non-zero exit, thrown by execFileSync) on a manifest the schema rejects —
  // exactly what a person running `npm run bundle` by hand would see.
  execFileSync(mcpbBin, ['validate', path.join(bundleDir, 'manifest.json')], { stdio: 'inherit' });

  await fs.mkdir(releaseDir, { recursive: true });
  const versionedName = `brainstem-mcp-${version}.mcpb`;
  const versionedPath = path.join(releaseDir, versionedName);
  execFileSync(mcpbBin, ['pack', bundleDir, versionedPath], { stdio: 'inherit' });

  const fixedPath = path.join(releaseDir, 'brainstem-mcp.mcpb');
  await fs.copyFile(versionedPath, fixedPath);

  const sumsPath = path.join(releaseDir, 'SHA256SUMS');
  const lines = [
    `${await sha256(versionedPath)}  ${versionedName}`,
    `${await sha256(fixedPath)}  brainstem-mcp.mcpb`,
  ];
  await fs.writeFile(sumsPath, `${lines.join('\n')}\n`, 'utf8');

  return { version, versionedPath, fixedPath, sumsPath };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const pkg = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'),
  ) as PackageJson;
  const started = Date.now();
  const result = await bundlePack();
  const [versionedStat, fixedStat] = await Promise.all([
    fs.stat(result.versionedPath),
    fs.stat(result.fixedPath),
  ]);
  console.log(
    `packed brainstem-mcp v${pkg.version} -> ${path.relative(repoRoot, result.versionedPath)} ` +
      `(${(versionedStat.size / 1024 / 1024).toFixed(2)} MiB) and ` +
      `${path.relative(repoRoot, result.fixedPath)} (${(fixedStat.size / 1024 / 1024).toFixed(2)} MiB) ` +
      `in ${Date.now() - started}ms`,
  );
}
