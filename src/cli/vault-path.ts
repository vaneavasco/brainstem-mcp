import path from 'node:path';
import pathPosix from 'node:path/posix';
import pathWin32 from 'node:path/win32';

export interface VaultPathContext {
  home: string;
  repoDir: string;
  platform: NodeJS.Platform;
  stat(p: string): Promise<{ isDirectory(): boolean } | null>;
  probeWrite(p: string): Promise<boolean>;
}

export type VaultPathVerdict =
  | { ok: true; path: string; warnings: string[] }
  | { ok: false; error: string };

function pathModule(platform: NodeJS.Platform): typeof pathPosix | typeof pathWin32 {
  return platform === 'win32' ? pathWin32 : pathPosix;
}

/** Case-insensitive comparison on win32 (paths there are case-insensitive), exact elsewhere. */
function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isRoot(p: string, mod: ReturnType<typeof pathModule>): boolean {
  return mod.normalize(p) === mod.parse(p).root;
}

function isInside(child: string, parent: string, mod: ReturnType<typeof pathModule>): boolean {
  return child.startsWith(parent.endsWith(mod.sep) ? parent : parent + mod.sep);
}

/**
 * Validates a candidate vault path: must be absolute, not the filesystem
 * root, not the user's home directory, not the running repository (or an
 * ancestor/descendant of it), must already exist as a writable directory.
 * Warns (without failing) when the directory has no `.obsidian` folder yet.
 */
export async function validateVaultPath(
  input: string,
  ctx: VaultPathContext,
): Promise<VaultPathVerdict> {
  const mod = pathModule(ctx.platform);

  if (!mod.isAbsolute(input)) {
    return { ok: false, error: `vault path must be absolute, got "${input}"` };
  }

  const candidate = mod.normalize(input);

  if (isRoot(candidate, mod)) {
    return { ok: false, error: `"${candidate}" is the filesystem root, not a vault folder` };
  }
  if (samePath(candidate, mod.normalize(ctx.home), ctx.platform)) {
    return { ok: false, error: `"${candidate}" is your home directory, not a vault folder` };
  }

  // Reject the repo itself or an ancestor of it (that would make Docker mount the running
  // repository, or worse, its parent, into the container). A vault *inside* the repo — e.g.
  // this project's own gitignored `vault-dev/` used for local testing — is fine.
  const repoDir = mod.normalize(ctx.repoDir);
  if (samePath(candidate, repoDir, ctx.platform) || isInside(repoDir, candidate, mod)) {
    return {
      ok: false,
      error: `"${candidate}" contains the brainstem-mcp repository — pick a separate folder`,
    };
  }

  const stat = await ctx.stat(candidate);
  if (!stat?.isDirectory()) {
    return { ok: false, error: `"${candidate}" does not exist or is not a directory` };
  }

  if (!(await ctx.probeWrite(candidate))) {
    return { ok: false, error: `"${candidate}" is not writable` };
  }

  const warnings: string[] = [];
  const obsidianDir = await ctx.stat(mod.join(candidate, '.obsidian'));
  if (!obsidianDir?.isDirectory()) {
    warnings.push(`"${candidate}" has no .obsidian folder yet — is this an Obsidian vault?`);
  }

  return { ok: true, path: candidate, warnings };
}

/** Suggests likely vault folders under `~/Obsidian*` and `~/Documents/Obsidian*`. */
export async function suggestVaultPaths(
  home: string,
  readdir: (p: string) => Promise<string[]>,
): Promise<string[]> {
  const suggestions: string[] = [];
  for (const dir of [home, path.join(home, 'Documents')]) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (/^Obsidian/i.test(entry)) suggestions.push(path.join(dir, entry));
    }
  }
  return suggestions;
}
