import { describe, expect, it } from 'vitest';
import { parseEnv, upsertEnv } from '../../src/cli/env-file.ts';

describe('parseEnv', () => {
  it('reads KEY=VALUE lines, strips surrounding quotes, ignores comments and blanks', () => {
    const env = parseEnv('# header\nA="q v"\nB=\'s\'\n#C=1\n\nD=plain\n');
    expect(env.get('A')).toBe('q v');
    expect(env.get('B')).toBe('s');
    expect(env.get('C')).toBeUndefined();
    expect(env.get('D')).toBe('plain');
  });
});

describe('upsertEnv', () => {
  it('keeps comments and order, fills only empty keys, appends missing ones behind a marker', () => {
    const src = '# header\nA=1\nB=\n# tail\n';
    const r = upsertEnv(src, { A: 'x', B: 'y', C: 'z' }, { onlyIfEmpty: true });
    expect(r.text).toBe('# header\nA=1\nB=y\n# tail\n# added by setup\nC=z\n');
    expect(r.changed).toEqual(['B', 'C']);
    expect(r.kept).toEqual(['A']);
    expect(upsertEnv('A=1\r\n', { A: '2' }).text).toBe('A=2\n');
    expect(parseEnv('A="q v"\nB=\'s\'\n#C=1\n').get('A')).toBe('q v');
  });

  it('emits a single "# added by setup" marker before appended keys, once', () => {
    const r = upsertEnv('A=1\n', { A: 'x', B: 'y' });
    expect(r.text.endsWith('# added by setup\nB=y\n')).toBe(true);
    expect(r.text).toBe('A=x\n# added by setup\nB=y\n');
  });

  it('does not emit the marker when nothing is appended', () => {
    const r = upsertEnv('A=1\n', { A: 'x' });
    expect(r.text).not.toContain('# added by setup');
    expect(r.text).toBe('A=x\n');
  });

  it('overwrites non-empty values when onlyIfEmpty is not set (defaults to false)', () => {
    const r = upsertEnv('A=old\n', { A: 'new' });
    expect(r.text).toBe('A=new\n');
    expect(r.changed).toEqual(['A']);
    expect(r.kept).toEqual([]);
  });

  it('single-quotes values that contain a space or a hash, leaves other values raw', () => {
    const r = upsertEnv('A=\nB=\nC=\n', { A: 'has space', B: 'has#hash', C: 'plain' });
    expect(r.text).toBe("A='has space'\nB='has#hash'\nC=plain\n");
  });

  it('keeps a Windows vault path literal — single quotes, no backslash expansion', () => {
    // compose-go (and Node's --env-file) expand \a \b \f \n \r \t \v \\ \" \$ inside
    // DOUBLE quotes, which would mangle this path; inside single quotes every
    // character is literal.
    const r = upsertEnv('VAULT_PATH=\n', { VAULT_PATH: 'C:\\Users\\vanea\\Obsidian Vault' });
    expect(r.text).toBe("VAULT_PATH='C:\\Users\\vanea\\Obsidian Vault'\n");
    expect(parseEnv(r.text).get('VAULT_PATH')).toBe('C:\\Users\\vanea\\Obsidian Vault');
  });

  it('falls back to escaped double quotes when the value itself contains an apostrophe', () => {
    const value = "C:\\Users\\Vanea's PC\\Obsidian Vault";
    const r = upsertEnv('VAULT_PATH=\n', { VAULT_PATH: value });
    expect(r.text).toBe('VAULT_PATH="C:\\\\Users\\\\Vanea\'s PC\\\\Obsidian Vault"\n');
    expect(parseEnv(r.text).get('VAULT_PATH')).toBe(value);
  });

  it('round-trips a quoted value with a space through parseEnv', () => {
    const r = upsertEnv('VAULT_PATH=\n', { VAULT_PATH: 'C:\\Users\\u\\Obsidian Vault' });
    expect(parseEnv(r.text).get('VAULT_PATH')).toBe('C:\\Users\\u\\Obsidian Vault');
  });
});
