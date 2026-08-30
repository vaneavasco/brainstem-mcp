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
    const r = upsertEnv('VAULT_PATH=\n', { VAULT_PATH: 'C:\\Users\\ana\\Obsidian Vault' });
    expect(r.text).toBe("VAULT_PATH='C:\\Users\\ana\\Obsidian Vault'\n");
    expect(parseEnv(r.text).get('VAULT_PATH')).toBe('C:\\Users\\ana\\Obsidian Vault');
  });

  it('falls back to escaped double quotes when the value itself contains an apostrophe', () => {
    const value = "C:\\Users\\Ana's PC\\Obsidian Vault";
    const r = upsertEnv('VAULT_PATH=\n', { VAULT_PATH: value });
    expect(r.text).toBe('VAULT_PATH="C:\\\\Users\\\\Ana\'s PC\\\\Obsidian Vault"\n');
    expect(parseEnv(r.text).get('VAULT_PATH')).toBe(value);
  });

  it('single-quotes a value containing $ so neither Compose nor Node interpolates it', () => {
    const r = upsertEnv('OWNER_SECRET=\n', { OWNER_SECRET: '$HOME-ish$ecret' });
    expect(r.text).toBe("OWNER_SECRET='$HOME-ish$ecret'\n");
    expect(parseEnv(r.text).get('OWNER_SECRET')).toBe('$HOME-ish$ecret');
  });

  // Residual, verified against both parsers: compose-go undoes `\$` (and `\\`, `\"`)
  // inside double quotes, while Node's `--env-file` strips the quotes and keeps
  // everything between them literal — so this value reads `it's $5 …` under Docker
  // but `it's \$5 …` under `npm run dev`. Single quotes would avoid it, but neither
  // parser splices `'\''` the way a shell does, so the double-quote form is the only
  // round-trippable fallback. `parseEnv` below matches the compose-go reading.
  it('double-quotes a value containing an apostrophe (escaping \\ " $) — a value with \' plus \\ or $ still differs between Node --env-file and Compose', () => {
    const value = 'it\'s $5 C:\\Users "x"';
    const r = upsertEnv('A=\n', { A: value });
    expect(r.text).toBe('A="it\'s \\$5 C:\\\\Users \\"x\\""\n');
    expect(parseEnv(r.text).get('A')).toBe(value);
  });

  it('round-trips a quoted value with a space through parseEnv', () => {
    const r = upsertEnv('VAULT_PATH=\n', { VAULT_PATH: 'C:\\Users\\u\\Obsidian Vault' });
    expect(parseEnv(r.text).get('VAULT_PATH')).toBe('C:\\Users\\u\\Obsidian Vault');
  });
});
