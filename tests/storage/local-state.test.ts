import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256hex } from '../../src/auth/hash.ts';
import {
  type LocalStateDeps,
  resolveBaseStateDir,
  resolveLocalStateDir,
} from '../../src/storage/local-state.ts';

/** A `LocalStateDeps.fs` backed by an in-memory map, so path-resolution tests never touch the
 *  real filesystem. `realpath` is identity unless a test overrides it (see the symlink test,
 *  which uses the real filesystem instead, because the whole point there is real symlink
 *  resolution). */
function fakeFs(): LocalStateDeps['fs'] & { written: Map<string, string> } {
  const written = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    written,
    async mkdir(p) {
      dirs.add(p);
      return undefined;
    },
    async realpath(p) {
      return p;
    },
    async stat(p) {
      if (written.has(p)) return {};
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    async readFile(p) {
      const data = written.get(p);
      if (data === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return data;
    },
    async writeFile(p, data) {
      written.set(p, data);
    },
    async rename(a, b) {
      const data = written.get(a);
      if (data === undefined) throw new Error(`no such tmp file: ${a}`);
      written.delete(a);
      written.set(b, data);
    },
  };
}

function deps(over: Partial<LocalStateDeps> = {}): LocalStateDeps {
  return {
    env: {},
    platform: 'linux',
    homedir: () => '/home/tester',
    fs: fakeFs(),
    ...over,
  };
}

describe('resolveBaseStateDir', () => {
  it('defaults to ~/.local/state/brainstem on linux', () => {
    const result = resolveBaseStateDir(deps({ platform: 'linux', env: {} }));
    expect(result).toEqual({ ok: true, dir: '/home/tester/.local/state/brainstem' });
  });

  it('honours XDG_STATE_HOME on linux', () => {
    const result = resolveBaseStateDir(
      deps({ platform: 'linux', env: { XDG_STATE_HOME: '/custom/xdg' } }),
    );
    expect(result).toEqual({ ok: true, dir: '/custom/xdg/brainstem' });
  });

  it('defaults to ~/Library/Application Support/brainstem on darwin', () => {
    const result = resolveBaseStateDir(deps({ platform: 'darwin', env: {} }));
    expect(result).toEqual({
      ok: true,
      dir: '/home/tester/Library/Application Support/brainstem',
    });
  });

  it('uses %LOCALAPPDATA%\\brainstem\\State on win32', () => {
    const result = resolveBaseStateDir(
      deps({
        platform: 'win32',
        homedir: () => 'C:\\Users\\tester',
        env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
      }),
    );
    expect(result).toEqual({
      ok: true,
      dir: 'C:\\Users\\tester\\AppData\\Local\\brainstem\\State',
    });
  });

  it('falls back to ~/AppData/Local/brainstem/State on win32 when LOCALAPPDATA is unset', () => {
    const result = resolveBaseStateDir(
      deps({ platform: 'win32', homedir: () => 'C:\\Users\\tester', env: {} }),
    );
    expect(result).toEqual({
      ok: true,
      dir: 'C:\\Users\\tester\\AppData\\Local\\brainstem\\State',
    });
  });

  it('BRAINSTEM_STATE_HOME wins on every platform when absolute', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const result = resolveBaseStateDir(
        deps({ platform, env: { BRAINSTEM_STATE_HOME: '/opt/brainstem-state' } }),
      );
      expect(result, platform).toEqual({ ok: true, dir: '/opt/brainstem-state' });
    }
  });

  it('rejects a relative BRAINSTEM_STATE_HOME with a clear error naming the variable', () => {
    const result = resolveBaseStateDir(deps({ env: { BRAINSTEM_STATE_HOME: 'relative/path' } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('BRAINSTEM_STATE_HOME');
      expect(result.error).toContain('relative/path');
    }
  });
});

describe('resolveLocalStateDir (deps injected, no real filesystem)', () => {
  it('creates <base>/<16 hex of sha256(realpath)> with mode 0700', async () => {
    const fs_ = fakeFs();
    const mkdirSpy = vi.spyOn(fs_, 'mkdir');
    const result = await resolveLocalStateDir('/vaults/mine', deps({ fs: fs_ }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expectedHash = sha256hex('/vaults/mine').slice(0, 16);
    expect(result.dir).toBe(`/home/tester/.local/state/brainstem/${expectedHash}`);
    expect(mkdirSpy).toHaveBeenCalledWith(result.dir, { recursive: true, mode: 0o700 });
  });

  it('hashes the realpath, not the raw input — two spellings of one vault share a folder', async () => {
    const fs_ = fakeFs();
    fs_.realpath = async (p) => (p.includes('symlink') ? '/vaults/real' : p);
    const a = await resolveLocalStateDir('/vaults/real', deps({ fs: fs_ }));
    const b = await resolveLocalStateDir('/somewhere/symlink-to-vault', deps({ fs: fs_ }));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.dir).toBe(b.dir);
  });

  it('writes vault.json once, with vaultPath and createdAt, and never rewrites it', async () => {
    const fs_ = fakeFs();
    const writeSpy = vi.spyOn(fs_, 'writeFile');
    const first = await resolveLocalStateDir('/vaults/mine', deps({ fs: fs_ }));
    expect(first.ok).toBe(true);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    if (!first.ok) return;
    const marker = fs_.written.get(path.posix.join(first.dir, 'vault.json'));
    expect(marker).toBeDefined(); // written under a tmp name, then renamed into place
    const [tmpPath] = writeSpy.mock.calls[0] as [string, string];
    expect(tmpPath).toContain('vault.json');
    expect(tmpPath).not.toBe(path.posix.join(first.dir, 'vault.json')); // via a tmp name
    const parsed = JSON.parse(marker as string) as { vaultPath: string; createdAt: string };
    expect(parsed.vaultPath).toBe('/vaults/mine');
    expect(parsed.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // A second resolution against the same vault must not write again.
    await resolveLocalStateDir('/vaults/mine', deps({ fs: fs_ }));
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('returns ok:false, without falling back anywhere, when the base directory cannot be created', async () => {
    const fs_ = fakeFs();
    fs_.mkdir = async () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    };
    const writeSpy = vi.spyOn(fs_, 'writeFile');
    const result = await resolveLocalStateDir('/vaults/mine', deps({ fs: fs_ }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('BRAINSTEM_STATE_HOME');
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('propagates a BRAINSTEM_STATE_HOME error instead of resolving a folder', async () => {
    const result = await resolveLocalStateDir(
      '/vaults/mine',
      deps({ env: { BRAINSTEM_STATE_HOME: 'not-absolute' } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('BRAINSTEM_STATE_HOME');
  });

  it('F7: a pre-existing vault.json naming a different vault is reported once and left untouched', async () => {
    const fs_ = fakeFs();
    const expectedHash = sha256hex('/vaults/mine').slice(0, 16);
    const markerFile = `/home/tester/.local/state/brainstem/${expectedHash}/vault.json`;
    const staleContent = JSON.stringify({
      vaultPath: '/vaults/old',
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    fs_.written.set(markerFile, staleContent);

    const calls: Array<{ file: string; recorded: string; actual: string }> = [];
    const result = await resolveLocalStateDir(
      '/vaults/mine',
      deps({ fs: fs_, onVaultMismatch: (info) => calls.push(info) }),
    );
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ file: markerFile, recorded: '/vaults/old', actual: '/vaults/mine' }]);
    // Left exactly as it was: never rewritten to the vault actually being served.
    expect(fs_.written.get(markerFile)).toBe(staleContent);
  });

  it('F7: no callback when vault.json already names the vault being resolved', async () => {
    const fs_ = fakeFs();
    const calls: unknown[] = [];
    await resolveLocalStateDir('/vaults/mine', deps({ fs: fs_ }));
    await resolveLocalStateDir(
      '/vaults/mine',
      deps({ fs: fs_, onVaultMismatch: (info) => calls.push(info) }),
    );
    expect(calls).toEqual([]);
  });
});

describe('resolveLocalStateDir against the real filesystem', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-local-state-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  function realDeps(base: string): LocalStateDeps {
    return {
      env: { BRAINSTEM_STATE_HOME: base },
      platform: process.platform,
      homedir: () => os.homedir(),
      fs: {
        mkdir: (p, opts) => fs.mkdir(p, opts),
        realpath: (p) => fs.realpath(p),
        stat: (p) => fs.stat(p),
        readFile: (p) => fs.readFile(p, 'utf8'),
        writeFile: (p, data, opts) => fs.writeFile(p, data, opts),
        rename: (a, b) => fs.rename(a, b),
      },
    };
  }

  it('resolves a symlinked vault path to the same folder as its real path', async () => {
    const realVault = path.join(tmp, 'real-vault');
    await fs.mkdir(realVault);
    const symlinkVault = path.join(tmp, 'symlink-vault');
    await fs.symlink(realVault, symlinkVault, process.platform === 'win32' ? 'junction' : 'dir');
    const base = path.join(tmp, 'state-home');

    const viaReal = await resolveLocalStateDir(realVault, realDeps(base));
    const viaSymlink = await resolveLocalStateDir(symlinkVault, realDeps(base));
    expect(viaReal.ok && viaSymlink.ok).toBe(true);
    if (viaReal.ok && viaSymlink.ok) expect(viaReal.dir).toBe(viaSymlink.dir);
  });

  it('actually creates the folder on disk, mode 0700, with a vault.json marker', async () => {
    const vault = path.join(tmp, 'vault');
    await fs.mkdir(vault);
    const base = path.join(tmp, 'state-home');
    const result = await resolveLocalStateDir(vault, realDeps(base));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stat = await fs.stat(result.dir);
    expect(stat.isDirectory()).toBe(true);
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o700);
    const marker = JSON.parse(await fs.readFile(path.join(result.dir, 'vault.json'), 'utf8'));
    expect(marker.vaultPath).toBe(await fs.realpath(vault));
  });

  it('F1: refuses a state base that resolves inside the vault, and creates nothing there', async () => {
    const vault = path.join(tmp, 'vault');
    await fs.mkdir(vault);
    // BRAINSTEM_STATE_HOME pointed at a folder under the vault — the base directory itself does
    // not exist yet, so the containment check must walk up to the nearest existing ancestor.
    const base = path.join(vault, 'not-yet-created', 'state-home');
    const result = await resolveLocalStateDir(vault, realDeps(base));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('BRAINSTEM_STATE_HOME');
    expect(result.error).toContain('inside');
    // Nothing was created under the vault at all.
    await expect(fs.readdir(vault)).resolves.toEqual([]);
  });

  it('F1: refuses a state base equal to the vault itself', async () => {
    const vault = path.join(tmp, 'vault');
    await fs.mkdir(vault);
    const result = await resolveLocalStateDir(vault, realDeps(vault));
    expect(result.ok).toBe(false);
  });

  it('F1 (reverse): refuses when the vault resolves inside the state base', async () => {
    const base = path.join(tmp, 'state-home');
    await fs.mkdir(base, { recursive: true });
    const vault = path.join(base, 'some-vault');
    await fs.mkdir(vault);
    const result = await resolveLocalStateDir(vault, realDeps(base));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('BRAINSTEM_STATE_HOME');
  });

  it('F1: a state base outside the vault, sharing only a name prefix, is still allowed', async () => {
    // Regression guard for a naive startsWith(parent) check without the separator: "vault-2"
    // must not be treated as "inside" "vault".
    const vault = path.join(tmp, 'vault');
    const sibling = path.join(tmp, 'vault-2-state-home');
    await fs.mkdir(vault);
    const result = await resolveLocalStateDir(vault, realDeps(sibling));
    expect(result.ok).toBe(true);
  });

  it('F7: no callback when vault.json already names the same vault', async () => {
    const vault = path.join(tmp, 'vault');
    await fs.mkdir(vault);
    const base = path.join(tmp, 'state-home');
    await resolveLocalStateDir(vault, realDeps(base));
    const calls: unknown[] = [];
    const again = realDeps(base);
    again.onVaultMismatch = (info) => calls.push(info);
    await resolveLocalStateDir(vault, again);
    expect(calls).toEqual([]);
  });
});
