import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';

const base = { PUBLIC_URL: 'https://brainstem.example.com' };

describe('loadConfig', () => {
  it('parses a minimal valid environment with defaults', () => {
    const cfg = loadConfig(base);
    expect(cfg.publicUrl.href).toBe('https://brainstem.example.com/');
    expect(cfg.mcpUrl.href).toBe('https://brainstem.example.com/mcp');
    expect(cfg.port).toBe(3000);
    expect(cfg.logLevel).toBe('info');
    expect(cfg.legacyMode).toBe('stateless');
    expect(cfg.databaseUrl).toBeUndefined();
  });

  it('strips a trailing slash and preserves a path prefix in mcpUrl', () => {
    const cfg = loadConfig({ PUBLIC_URL: 'https://example.com/brain/' });
    expect(cfg.mcpUrl.href).toBe('https://example.com/brain/mcp');
  });

  it('fails closed when PUBLIC_URL is missing and names the variable without leaking values', () => {
    let error: unknown;
    try {
      loadConfig({ PORT: '8080' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const ce = error as ConfigError;
    expect(ce.missing).toEqual(['PUBLIC_URL']);
    expect(ce.message).toContain('PUBLIC_URL');
    expect(ce.message).not.toContain('8080');
  });

  it('rejects a non-https PUBLIC_URL unless explicitly allowed', () => {
    expect(() => loadConfig({ PUBLIC_URL: 'http://localhost:3000' })).toThrow(ConfigError);
    const cfg = loadConfig({
      PUBLIC_URL: 'http://localhost:3000',
      ALLOW_INSECURE_PUBLIC_URL: 'true',
    });
    expect(cfg.mcpUrl.href).toBe('http://localhost:3000/mcp');
  });

  it('pins the ConfigError.invalid contract: bare variable names only', () => {
    let error: unknown;
    try {
      loadConfig({ PUBLIC_URL: 'http://localhost:3000' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const ce = error as ConfigError;
    expect(ce.invalid).toEqual(['PUBLIC_URL']);
    expect(ce.missing).toEqual([]);
    expect(ce.message).toContain('ALLOW_INSECURE_PUBLIC_URL');
  });

  it('rejects invalid PORT, LOG_LEVEL and MCP_LEGACY_MODE values', () => {
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, LOG_LEVEL: 'loud' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, MCP_LEGACY_MODE: 'sessions' })).toThrow(ConfigError);
  });

  it('accepts legacy mode reject and a database url', () => {
    const cfg = loadConfig({
      ...base,
      MCP_LEGACY_MODE: 'reject',
      DATABASE_URL: 'postgres://u:p@h/db',
    });
    expect(cfg.legacyMode).toBe('reject');
    expect(cfg.databaseUrl).toBe('postgres://u:p@h/db');
  });
});

describe('storage and vault settings', () => {
  it('defaults to the drive backend and UTC daily notes', () => {
    const cfg = loadConfig(base);
    expect(cfg.storage).toEqual({ backend: 'drive' });
    expect(cfg.vaultSettings).toEqual({
      dailyNotes: { folder: '', format: 'yyyy-MM-dd', template: null, timezone: 'UTC' },
      requiredFrontmatter: [],
    });
  });

  it('requires VAULT_PATH for localfs and parses vault settings', () => {
    let err: unknown;
    try {
      loadConfig({ ...base, STORAGE_BACKEND: 'localfs' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).missing).toEqual(['VAULT_PATH']);
    expect((err as ConfigError).invalid).toEqual([]);
    expect((err as ConfigError).message).toContain('STORAGE_BACKEND=localfs');
    const cfg = loadConfig({
      ...base,
      STORAGE_BACKEND: 'localfs',
      VAULT_PATH: '/tmp/vault',
      DAILY_NOTES_FOLDER: 'journal',
      DAILY_NOTES_FORMAT: '%Y-%m-%d',
      DAILY_NOTES_TEMPLATE: '# {{title}}',
      VAULT_TIMEZONE: 'Europe/Chisinau',
      REQUIRED_FRONTMATTER: 'type, status',
    });
    expect(cfg.storage).toEqual({ backend: 'localfs', vaultPath: '/tmp/vault' });
    expect(cfg.vaultSettings).toEqual({
      dailyNotes: {
        folder: 'journal',
        format: '%Y-%m-%d',
        template: '# {{title}}',
        timezone: 'Europe/Chisinau',
      },
      requiredFrontmatter: ['type', 'status'],
    });
  });

  it('rejects an unknown timezone or backend', () => {
    let err: unknown;
    try {
      loadConfig({ ...base, VAULT_TIMEZONE: 'Mars/Olympus' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).invalid).toEqual(['VAULT_TIMEZONE']);
    expect((err as ConfigError).missing).toEqual([]);
    expect((err as ConfigError).message).toContain('IANA');
    expect(() => loadConfig({ ...base, STORAGE_BACKEND: 's3' })).toThrow(ConfigError);
  });

  it("accepts a moment-style DAILY_NOTES_FORMAT like Obsidian's own default", () => {
    const cfg = loadConfig({ ...base, DAILY_NOTES_FORMAT: 'YYYY-MM-DD' });
    expect(cfg.vaultSettings.dailyNotes.format).toBe('YYYY-MM-DD');
  });

  it('rejects a DAILY_NOTES_FORMAT that is not a valid date-fns/strftime pattern', () => {
    // date-fns escapes literal text with 'quotes', not moment's [brackets]; an unescaped letter
    // inside brackets is therefore an invalid token, not a literal.
    let err: unknown;
    try {
      loadConfig({ ...base, DAILY_NOTES_FORMAT: 'YYYY-MM-DD [note]' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const ce = err as ConfigError;
    expect(ce.invalid).toEqual(['DAILY_NOTES_FORMAT']);
    expect(ce.missing).toEqual([]);
    expect(ce.message).toContain('DAILY_NOTES_FORMAT');
  });

  it('rejects a DAILY_NOTES_FOLDER that would escape the vault or reach a hidden folder', () => {
    for (const folder of ['../x', '.obsidian']) {
      let err: unknown;
      try {
        loadConfig({ ...base, DAILY_NOTES_FOLDER: folder });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConfigError);
      const ce = err as ConfigError;
      expect(ce.invalid).toEqual(['DAILY_NOTES_FOLDER']);
      expect(ce.missing).toEqual([]);
      expect(ce.message).toContain('DAILY_NOTES_FOLDER');
    }
  });
});
