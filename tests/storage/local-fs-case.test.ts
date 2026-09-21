import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareCaseSpelling, LocalFSAdapter } from '../../src/storage/local-fs.ts';
import { VaultError } from '../../src/storage/types.ts';

// A vault path is exact on every platform (AGENTS.md / decision A of the Windows CI triage):
// reading, writing or moving under a spelling that differs only by letter case from what is
// really on disk must behave the same everywhere, not silently resolve (a read) or clobber under
// a second index entry (a write) on the case-insensitive filesystems Windows and macOS default
// to. The comparison itself (`compareCaseSpelling`) is a pure function, tested directly below.
//
// The adapter-level tests fake `realpath.native` (the one call the new check makes) so the check
// is exercised on this case-sensitive CI runner too; the real end-to-end proof is the
// macOS/Windows CI legs. A wrinkle: the *pre-existing* existence check every mutating/reading
// method already had (a plain `fs.stat`) is real, not faked, and ext4 does not fold case — so for
// a method whose own pre-existing stat already gates the new check (read, exists, hashOf, list, a
// softDelete or a move's source), exercising the new logic here needs BOTH spellings to genuinely
// exist as two distinct real files (impossible on an actually case-insensitive filesystem: there
// they would be one file). For a write-type method (write, writeBinary, append, a move's target)
// the new check runs unconditionally, before any pre-existing stat, so one real file is enough.

describe('compareCaseSpelling', () => {
  it('the exact same spelling: exact', () => {
    expect(compareCaseSpelling('/root/notes/Report.md', '/root/notes/Report.md')).toBe('exact');
  });

  it('a case-only difference in the file name: case-only', () => {
    expect(compareCaseSpelling('/root/notes/report.md', '/root/notes/Report.md')).toBe('case-only');
  });

  it('a case-only difference in a folder segment: case-only', () => {
    expect(compareCaseSpelling('/root/Notes/report.md', '/root/notes/report.md')).toBe('case-only');
  });

  it('a difference that is not case (a symlink resolving elsewhere): other', () => {
    expect(compareCaseSpelling('/root/a/b.md', '/root/c/b.md')).toBe('other');
  });

  it('NFC and NFD forms of the same name are the same name, not a difference', () => {
    // macOS (HFS+/APFS) commonly stores and returns file names decomposed (NFD: "e" + a
    // combining acute accent U+0301), regardless of which form the caller typed or another
    // program wrote with. Folding both sides through NFC before comparing means the precomposed
    // "café" a caller types and the decomposed form realpath.native hands back compare equal —
    // never flagged as a case (or any other) difference.
    const precomposed = 'notes/café.md'; // NFC: é as one code point
    const decomposed = 'notes/café.md'; // NFD: e + combining acute accent
    expect(compareCaseSpelling(precomposed, decomposed)).toBe('exact');
  });
});

/**
 * Fakes what `fs.realpath.native` reports on a case-insensitive filesystem, using nothing but
 * real directory listings on this (case-sensitive) machine: for each segment of `absPath` it
 * looks, under `root`, for a real entry whose name matches case-insensitively, and descends into
 * its real spelling — or throws ENOENT exactly like the real call when no entry matches even case
 * -insensitively. When two real entries happen to match the same segment case-insensitively (only
 * possible in this test, on a case-sensitive filesystem, standing in for the one file a real
 * case-insensitive filesystem would actually have), the one that sorts first by plain string
 * comparison wins — deterministic, and, since an uppercase letter sorts before its lowercase
 * counterpart, the tests below always name the entry they mean as "the real one" starting with a
 * capital.
 */
function fakeCaseFoldingRealpath(root: string): (absPath: string) => Promise<string> {
  return async (absPath: string) => {
    const rel = path.relative(root, absPath);
    if (rel === '' || rel.startsWith('..')) {
      await fs.stat(absPath); // outside the walk this fakes — behave like a plain existence check
      return absPath;
    }
    let dir = root;
    for (const segment of rel.split(path.sep)) {
      const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
      const match = entries.find((e) => e.name.toLowerCase() === segment.toLowerCase());
      if (!match) {
        const error = new Error(
          `ENOENT: no such file or directory, stat '${absPath}'`,
        ) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      dir = path.join(dir, match.name); // the real on-disk spelling, whatever case was asked for
    }
    return dir;
  };
}

let root: string;
let vault: LocalFSAdapter;

beforeEach(async () => {
  // `LocalFSAdapter.create` stores `await fs.realpath(rootDir)`, not `rootDir` itself — on
  // Windows CI, `os.tmpdir()` can hand back a short (8.3) name (`RUNNER~1`) that `fs.realpath`
  // resolves to the long form, a DIFFERENT string for the same directory. The fake below computes
  // `path.relative(root, …)` against whatever `root` this closure captured, so it must match the
  // adapter's own `this.root` exactly, or every probe looks like it walked outside the vault and
  // the fake's harmless fallback (return the path unchanged) silently defeats the whole test.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-vault-case-')));
  vault = await LocalFSAdapter.create(root, {
    ripgrepPath: null,
    caseInsensitive: true,
    realpathNative: fakeCaseFoldingRealpath(root),
  });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof VaultError) return e.code;
    throw e;
  }
  throw new Error('expected a VaultError');
}

/** Two real files existing under both spellings — the only way to reach a read-type method's new
 *  case check on this (case-sensitive) machine: its own pre-existing `fs.stat` gate needs the
 *  wrongly-cased query to genuinely exist too, exactly as it would on a real folding filesystem. */
async function seedDualCase(real: string, impostor: string, content = 'real\n'): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, real)), { recursive: true });
  await fs.writeFile(path.join(root, real), content);
  await fs.writeFile(path.join(root, impostor), 'impostor — must never be read as such\n');
}

describe('LocalFSAdapter on a filesystem faked as case-insensitive', () => {
  it('detected (or forced) case-insensitivity is exposed on the adapter', () => {
    expect(vault.caseInsensitive).toBe(true);
  });

  it('read: a case-only near-miss is NOT_FOUND, worded exactly like a plain missing file', async () => {
    await seedDualCase('notes/Report.md', 'notes/report.md');
    expect(await code(vault.read('notes/report.md'))).toBe('NOT_FOUND');
    const err = await vault
      .read('notes/report.md')
      .then(() => null)
      .catch((e: VaultError) => e);
    expect(err?.message).toBe('notes/report.md does not exist.');
    expect((await vault.read('notes/Report.md')).content).toBe('real\n');
  });

  it('exists: false for a case-only near-miss, true for the real spelling', async () => {
    await seedDualCase('notes/Report.md', 'notes/report.md');
    expect(await vault.exists('notes/report.md')).toBe(false);
    expect(await vault.exists('notes/Report.md')).toBe(true);
  });

  it('hashOf: null for a case-only near-miss, a real hash for the real spelling', async () => {
    await seedDualCase('notes/Report.md', 'notes/report.md');
    expect(await vault.hashOf('notes/report.md')).toBeNull();
    expect(await vault.hashOf('notes/Report.md')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('list: a folder spelled with the wrong case is NOT_FOUND, the real one lists normally', async () => {
    await fs.mkdir(path.join(root, 'Notes'), { recursive: true });
    await fs.mkdir(path.join(root, 'notes'), { recursive: true }); // stands in for the one real folder
    await fs.writeFile(path.join(root, 'Notes', 'a.md'), 'x');
    expect(await code(vault.list('notes'))).toBe('NOT_FOUND');
    expect((await vault.list('Notes')).map((e) => e.path)).toEqual(['Notes/a.md']);
  });

  it('softDelete: a case-only near-miss is NOT_FOUND; the real file is left untouched', async () => {
    await seedDualCase('notes/Report.md', 'notes/report.md');
    expect(await code(vault.softDelete('notes/report.md', true))).toBe('NOT_FOUND');
    expect((await vault.read('notes/Report.md')).content).toBe('real\n');
  });

  it("move: a source spelled with the wrong case is NOT_FOUND, the real file doesn't move", async () => {
    await seedDualCase('notes/Report.md', 'notes/report.md');
    expect(await code(vault.move('notes/report.md', 'elsewhere.md'))).toBe('NOT_FOUND');
    expect((await vault.read('notes/Report.md')).content).toBe('real\n');
  });

  it('a genuinely missing path (no case-insensitive match either) is a plain NOT_FOUND', async () => {
    expect(await code(vault.read('nowhere/nothing.md'))).toBe('NOT_FOUND');
  });

  it('write: overwriting under a different case is refused (CONFLICT), the real file is untouched', async () => {
    await vault.write('notes/Report.md', 'first\n');
    const err = await vault
      .write('notes/report.md', 'second\n')
      .then(() => null)
      .catch((e: VaultError) => e);
    expect(err?.code).toBe('CONFLICT');
    expect(err?.message).toBe(
      'notes/report.md differs only by letter case from the existing "notes/Report.md": use that path.',
    );
    expect((await vault.read('notes/Report.md')).content).toBe('first\n');
    // Only the one file exists — the wrongly-cased write never created a second one.
    expect(await fs.readdir(path.join(root, 'notes'))).toEqual(['Report.md']);
  });

  it('write: a new file inside an existing, differently-cased folder is refused (CONFLICT)', async () => {
    await vault.write('notes/Report.md', 'x\n');
    const err = await vault
      .write('Notes/other.md', 'x\n')
      .then(() => null)
      .catch((e: VaultError) => e);
    expect(err?.code).toBe('CONFLICT');
    expect(err?.message).toContain(
      'differs only by letter case from the existing "notes/other.md"',
    );
    expect(await fs.readdir(root)).toEqual(['notes']); // no "Notes" folder was ever created
  });

  it('writeBinary: overwriting under a different case is refused the same way', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await vault.writeBinary('img/A.png', png, 'image/png');
    expect(await code(vault.writeBinary('img/a.png', png, 'image/png'))).toBe('CONFLICT');
  });

  it('append: never silently creates a second, wrongly-cased file', async () => {
    await vault.write('notes/Report.md', 'first\n');
    expect(await code(vault.append('notes/report.md', 'more'))).toBe('CONFLICT');
    expect((await vault.read('notes/Report.md')).content).toBe('first\n');
    expect(await fs.readdir(path.join(root, 'notes'))).toEqual(['Report.md']);
  });

  it('edit: a case-only near-miss is NOT_FOUND (it reads before it ever writes)', async () => {
    await vault.write('notes/Report.md', 'alpha\n');
    expect(await code(vault.edit('notes/report.md', [{ find: 'alpha', replace: 'beta' }]))).toBe(
      'NOT_FOUND',
    );
  });

  it('move: a target that collides only by case is CONFLICT, not ALREADY_EXISTS', async () => {
    await vault.write('a.md', 'a\n');
    await vault.write('B.md', 'b\n');
    expect(await code(vault.move('a.md', 'b.md'))).toBe('CONFLICT');
  });

  it('move: a target inside an existing, differently-cased folder is CONFLICT', async () => {
    await vault.write('notes/a.md', 'a\n');
    await vault.write('src.md', 'x\n');
    expect(await code(vault.move('src.md', 'Notes/src.md'))).toBe('CONFLICT');
  });
});

describe('LocalFSAdapter.create case detection', () => {
  it("a fresh tmp directory on this machine is detected honestly — this platform's real default, not a hardcoded guess", async () => {
    const detectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstem-vault-detect-'));
    try {
      const detected = await LocalFSAdapter.create(detectRoot, { ripgrepPath: null });
      // The whole point of detection is not needing this per platform — but there is no other
      // way, on CI, to check the checker: this is what every runner has reliably proven so far
      // (Windows/NTFS and macOS/APFS fold case by default; Linux/ext4 and tmpfs do not), and it
      // is the same fallback `detectCaseInsensitive` itself uses when the stat-based probe can't
      // decide, so a runner where this ever disagrees is exactly the case worth seeing fail.
      const platformDefault = process.platform === 'win32' || process.platform === 'darwin';
      expect(detected.caseInsensitive).toBe(platformDefault);
    } finally {
      await fs.rm(detectRoot, { recursive: true, force: true });
    }
  });
});
