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
  it('keeps comments and order, fills only empty keys, appends missing ones', () => {
    const src = '# header\nA=1\nB=\n# tail\n';
    const r = upsertEnv(src, { A: 'x', B: 'y', C: 'z' }, { onlyIfEmpty: true });
    expect(r.text).toBe('# header\nA=1\nB=y\n# tail\nC=z\n');
    expect(r.changed).toEqual(['B', 'C']);
    expect(r.kept).toEqual(['A']);
    expect(upsertEnv('A=1\r\n', { A: '2' }).text).toBe('A=2\n');
    expect(parseEnv('A="q v"\nB=\'s\'\n#C=1\n').get('A')).toBe('q v');
  });

  it('overwrites non-empty values when onlyIfEmpty is not set (defaults to false)', () => {
    const r = upsertEnv('A=old\n', { A: 'new' });
    expect(r.text).toBe('A=new\n');
    expect(r.changed).toEqual(['A']);
    expect(r.kept).toEqual([]);
  });

  it('quotes values that contain a space or a hash, leaves other values raw', () => {
    const r = upsertEnv('A=\nB=\n', { A: 'has space', B: 'has#hash' });
    expect(r.text).toBe('A="has space"\nB="has#hash"\n');
  });

  it('round-trips a quoted value with a space through parseEnv', () => {
    const r = upsertEnv('VAULT_PATH=\n', { VAULT_PATH: 'C:\\Users\\u\\Obsidian Vault' });
    expect(parseEnv(r.text).get('VAULT_PATH')).toBe('C:\\Users\\u\\Obsidian Vault');
  });
});
