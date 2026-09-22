import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadVaultConfig } from '../src/config.ts';
import { baseEnv, TEST_OWNER_SECRET } from './helpers/env.ts';

const base = baseEnv();

describe('loadConfig', () => {
  it('parses a minimal valid environment with defaults', () => {
    const cfg = loadConfig(base);
    expect(cfg.publicUrl.href).toBe('https://brainstem.example.com/');
    expect(cfg.mcpUrl.href).toBe('https://brainstem.example.com/mcp');
    expect(cfg.port).toBe(3000);
    expect(cfg.logLevel).toBe('info');
    expect(cfg.legacyMode).toBe('stateless');
  });

  it('rejects a PUBLIC_URL carrying a path prefix, and keeps a bare origin usable', () => {
    // A path prefix only half-worked (the tunnel/compose wiring, the CIMD
    // redirect checks and the PRM URL all assume a bare origin), so it is a
    // configuration error rather than a silent half-feature.
    let error: unknown;
    try {
      loadConfig(baseEnv({ PUBLIC_URL: 'https://example.com/brain/' }));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).invalid).toEqual(['PUBLIC_URL']);
    expect((error as ConfigError).message).toContain('bare origin');

    const cfg = loadConfig(baseEnv({ PUBLIC_URL: 'https://example.com/' }));
    expect(cfg.publicUrl.href).toBe('https://example.com/');
    expect(cfg.mcpUrl.href).toBe('https://example.com/mcp');
  });

  it('fails closed when PUBLIC_URL is missing and names the variable without leaking values', () => {
    let error: unknown;
    try {
      loadConfig(baseEnv({ PUBLIC_URL: '', PORT: '8080' }));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const ce = error as ConfigError;
    expect(ce.missing).toEqual(['PUBLIC_URL']);
    expect(ce.message).toContain('PUBLIC_URL');
    expect(ce.message).not.toContain('8080');
    expect(ce.message).toContain('./brainstem setup');
  });

  it('rejects a non-https PUBLIC_URL unless explicitly allowed', () => {
    expect(() => loadConfig(baseEnv({ PUBLIC_URL: 'http://localhost:3000' }))).toThrow(ConfigError);
    const cfg = loadConfig(
      baseEnv({
        PUBLIC_URL: 'http://localhost:3000',
        ALLOW_INSECURE_PUBLIC_URL: 'true',
      }),
    );
    expect(cfg.mcpUrl.href).toBe('http://localhost:3000/mcp');
  });

  it('pins the ConfigError.invalid contract: bare variable names only', () => {
    let error: unknown;
    try {
      loadConfig(baseEnv({ PUBLIC_URL: 'http://localhost:3000' }));
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

  it('accepts legacy mode reject', () => {
    const cfg = loadConfig({ ...base, MCP_LEGACY_MODE: 'reject' });
    expect(cfg.legacyMode).toBe('reject');
    expect('databaseUrl' in cfg).toBe(false);
  });
});

describe('v2 variables', () => {
  it('requires OWNER_SECRET and rejects short or non-base64url values', () => {
    expect(() => loadConfig(baseEnv({ OWNER_SECRET: '' }))).toThrow(/OWNER_SECRET/);
    expect(() => loadConfig(baseEnv({ OWNER_SECRET: 'short' }))).toThrow(/at least 32 bytes/);
    expect(() => loadConfig(baseEnv({ OWNER_SECRET: 'not base64url!!' }))).toThrow(/OWNER_SECRET/);
    expect(loadConfig(base).ownerSecret).toBe(TEST_OWNER_SECRET);
  });
  it('defaults the new knobs', () => {
    const cfg = loadConfig(base);
    expect(cfg.cimdAllowedHosts).toEqual(['claude.ai', 'claude.com']);
    expect(cfg.accessTokenTtlS).toBe(3600);
    expect(cfg.refreshTokenTtlS).toBe(90 * 24 * 3600);
    expect(cfg.watchPollMs).toBeNull();
    expect(cfg.publicUrlFile).toBeNull();
    expect(cfg.stateDir).toBeNull();
    expect(cfg.tunnelMode).toBe('none');
    expect(cfg.storage).toEqual({ backend: 'localfs', vaultPath: '/tmp/unused' });
    expect(cfg.reconcileMs).toBe(300_000);
    expect(cfg.readOnly).toBe(false);
    expect('databaseUrl' in cfg).toBe(false);
  });
  it('parses the knobs', () => {
    const cfg = loadConfig(
      baseEnv({
        CIMD_ALLOWED_HOSTS: ' claude.ai, example.org ',
        ACCESS_TOKEN_TTL_S: '600',
        REFRESH_TOKEN_TTL_S: '86400',
        VAULT_WATCH_POLL_MS: '2000',
        VAULT_RECONCILE_MS: '60000',
        PUBLIC_URL_FILE: '/vault/_brainstem/public-url',
        STATE_DIR: '/tmp/state',
        TUNNEL_MODE: 'quick',
      }),
    );
    expect(cfg.cimdAllowedHosts).toEqual(['claude.ai', 'example.org']);
    expect(cfg.accessTokenTtlS).toBe(600);
    expect(cfg.refreshTokenTtlS).toBe(86400);
    expect(cfg.watchPollMs).toBe(2000);
    expect(cfg.reconcileMs).toBe(60_000);
    expect(cfg.publicUrlFile).toBe('/vault/_brainstem/public-url');
    expect(cfg.stateDir).toBe('/tmp/state');
    expect(cfg.tunnelMode).toBe('quick');
  });
  it('VAULT_RECONCILE_MS=0 disables the background reconcile timer', () => {
    expect(loadConfig(baseEnv({ VAULT_RECONCILE_MS: '0' })).reconcileMs).toBe(0);
  });
  it('reads VAULT_READ_ONLY in every spelling an install form may substitute', () => {
    // Claude Desktop puts a boolean from the install form into env; its spelling is undocumented
    for (const v of ['true', 'True', 'TRUE', '1', 'yes', 'on', ' true ']) {
      expect(loadConfig(baseEnv({ VAULT_READ_ONLY: v })).readOnly, v).toBe(true);
    }
    for (const v of ['false', 'False', '0', 'no', 'off', '']) {
      expect(loadConfig(baseEnv({ VAULT_READ_ONLY: v })).readOnly, v).toBe(false);
    }
  });

  it('parses VAULT_READ_ONLY and rejects a nonsense value', () => {
    expect(loadConfig(baseEnv({ VAULT_READ_ONLY: 'true' })).readOnly).toBe(true);
    expect(loadConfig(baseEnv({ VAULT_READ_ONLY: 'false' })).readOnly).toBe(false);
    expect(() => loadConfig(baseEnv({ VAULT_READ_ONLY: 'maybe' }))).toThrow(/VAULT_READ_ONLY/);
  });
  it('rejects nonsense knobs by name', () => {
    expect(() => loadConfig(baseEnv({ VAULT_WATCH_POLL_MS: '-5' }))).toThrow(/VAULT_WATCH_POLL_MS/);
    expect(() => loadConfig(baseEnv({ VAULT_RECONCILE_MS: '-5' }))).toThrow(/VAULT_RECONCILE_MS/);
    // every pass lists the whole vault: 1 ms would be a busy loop
    expect(() => loadConfig(baseEnv({ VAULT_RECONCILE_MS: '1' }))).toThrow(/VAULT_RECONCILE_MS/);
    expect(loadConfig(baseEnv({ VAULT_RECONCILE_MS: '10000' })).reconcileMs).toBe(10_000);
    expect(() => loadConfig(baseEnv({ TUNNEL_MODE: 'ngrok' }))).toThrow(/TUNNEL_MODE/);
    expect(() => loadConfig(baseEnv({ CIMD_ALLOWED_HOSTS: 'https://claude.ai' }))).toThrow(
      /CIMD_ALLOWED_HOSTS/,
    );
  });

  it('defaults MAX_BINARY_BYTES to 8 MiB when unset or empty', () => {
    expect(loadConfig(base).maxBinaryBytes).toBe(8 * 1024 * 1024);
    expect(loadConfig(baseEnv({ MAX_BINARY_BYTES: '' })).maxBinaryBytes).toBe(8 * 1024 * 1024);
  });

  it('parses a custom MAX_BINARY_BYTES', () => {
    expect(loadConfig(baseEnv({ MAX_BINARY_BYTES: '1048576' })).maxBinaryBytes).toBe(1_048_576);
  });

  it('rejects a non-positive or non-numeric MAX_BINARY_BYTES', () => {
    for (const bad of ['0', '-5', 'abc']) {
      let err: unknown;
      try {
        loadConfig(baseEnv({ MAX_BINARY_BYTES: bad }));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).invalid).toEqual(['MAX_BINARY_BYTES']);
    }
  });
});

describe('storage and vault settings', () => {
  it('defaults to the localfs backend and UTC daily notes', () => {
    const cfg = loadConfig(baseEnv({ STORAGE_BACKEND: '' }));
    expect(cfg.storage).toEqual({ backend: 'localfs', vaultPath: '/tmp/unused' });
    expect(cfg.vaultSettings).toEqual({
      dailyNotes: { folder: '', format: 'yyyy-MM-dd', template: null, timezone: 'UTC' },
      requiredFrontmatter: [],
    });
  });

  it('requires VAULT_PATH for localfs and parses vault settings', () => {
    let err: unknown;
    try {
      loadConfig(baseEnv({ VAULT_PATH: '' }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).missing).toEqual(['VAULT_PATH']);
    expect((err as ConfigError).invalid).toEqual([]);
    expect((err as ConfigError).message).toContain('STORAGE_BACKEND=localfs');
    const cfg = loadConfig(
      baseEnv({
        VAULT_PATH: '/tmp/vault',
        DAILY_NOTES_FOLDER: 'journal',
        DAILY_NOTES_FORMAT: '%Y-%m-%d',
        DAILY_NOTES_TEMPLATE: '# {{title}}',
        VAULT_TIMEZONE: 'Europe/Chisinau',
        REQUIRED_FRONTMATTER: 'type, status',
      }),
    );
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
      loadConfig(baseEnv({ VAULT_TIMEZONE: 'Mars/Olympus' }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).invalid).toEqual(['VAULT_TIMEZONE']);
    expect((err as ConfigError).missing).toEqual([]);
    expect((err as ConfigError).message).toContain('IANA');
    expect(() => loadConfig(baseEnv({ STORAGE_BACKEND: 's3' }))).toThrow(ConfigError);
  });

  it("accepts a moment-style DAILY_NOTES_FORMAT like Obsidian's own default", () => {
    const cfg = loadConfig(baseEnv({ DAILY_NOTES_FORMAT: 'YYYY-MM-DD' }));
    expect(cfg.vaultSettings.dailyNotes.format).toBe('YYYY-MM-DD');
  });

  it('rejects a DAILY_NOTES_FORMAT that is not a valid date-fns/strftime pattern', () => {
    // date-fns escapes literal text with 'quotes', not moment's [brackets]; an unescaped letter
    // inside brackets is therefore an invalid token, not a literal.
    let err: unknown;
    try {
      loadConfig(baseEnv({ DAILY_NOTES_FORMAT: 'YYYY-MM-DD [note]' }));
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
        loadConfig(baseEnv({ DAILY_NOTES_FOLDER: folder }));
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

describe('loadVaultConfig', () => {
  it('needs only VAULT_PATH — no PUBLIC_URL, no OWNER_SECRET, no tunnel settings', () => {
    const cfg = loadVaultConfig({ VAULT_PATH: '/tmp/my-vault' });
    expect(cfg.vaultPath).toBe('/tmp/my-vault');
    expect(cfg.vaultSettings).toEqual({
      dailyNotes: { folder: '', format: 'yyyy-MM-dd', template: null, timezone: 'UTC' },
      requiredFrontmatter: [],
    });
    expect(cfg.watchPollMs).toBeNull();
    expect(cfg.maxBinaryBytes).toBe(8 * 1024 * 1024);
    expect(cfg.reconcileMs).toBe(300_000);
    expect(cfg.logLevel).toBe('info');
    expect(cfg.stateDir).toBeNull();
    expect(cfg.readOnly).toBe(false);
    expect('storage' in cfg).toBe(false);
    expect('ownerSecret' in cfg).toBe(false);
    expect('publicUrl' in cfg).toBe(false);
  });

  it('parses VAULT_READ_ONLY the same way loadConfig does', () => {
    expect(loadVaultConfig({ VAULT_PATH: '/tmp/my-vault', VAULT_READ_ONLY: 'true' }).readOnly).toBe(
      true,
    );
    expect(loadVaultConfig({ VAULT_PATH: '/tmp/my-vault' }).readOnly).toBe(false);
    expect(() => loadVaultConfig({ VAULT_PATH: '/tmp/my-vault', VAULT_READ_ONLY: 'nope' })).toThrow(
      ConfigError,
    );
  });

  it('is unaffected by an invalid or missing PUBLIC_URL/OWNER_SECRET in the environment', () => {
    // A real process.env for a stdio session has neither set at all; a leftover, malformed
    // PUBLIC_URL from an unrelated .env in the same shell must not break vault loading either.
    const cfg = loadVaultConfig({
      VAULT_PATH: '/tmp/my-vault',
      PUBLIC_URL: 'not a url at all',
      OWNER_SECRET: '',
    });
    expect(cfg.vaultPath).toBe('/tmp/my-vault');
  });

  it('requires VAULT_PATH (unconditionally — no STORAGE_BACKEND concept here)', () => {
    let err: unknown;
    try {
      loadVaultConfig({});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).missing).toEqual(['VAULT_PATH']);
    expect((err as ConfigError).invalid).toEqual([]);
  });

  it('parses the same daily-notes / timezone / reconcile / binary knobs loadConfig does, with the same validation', () => {
    const cfg = loadVaultConfig({
      VAULT_PATH: '/tmp/vault',
      DAILY_NOTES_FOLDER: 'journal',
      DAILY_NOTES_FORMAT: '%Y-%m-%d',
      DAILY_NOTES_TEMPLATE: '# {{title}}',
      VAULT_TIMEZONE: 'Europe/Chisinau',
      REQUIRED_FRONTMATTER: 'type, status',
      VAULT_WATCH_POLL_MS: '2000',
      VAULT_RECONCILE_MS: '60000',
      MAX_BINARY_BYTES: '1048576',
      LOG_LEVEL: 'debug',
      STATE_DIR: '/tmp/state',
    });
    expect(cfg.vaultSettings).toEqual({
      dailyNotes: {
        folder: 'journal',
        format: '%Y-%m-%d',
        template: '# {{title}}',
        timezone: 'Europe/Chisinau',
      },
      requiredFrontmatter: ['type', 'status'],
    });
    expect(cfg.watchPollMs).toBe(2000);
    expect(cfg.reconcileMs).toBe(60_000);
    expect(cfg.maxBinaryBytes).toBe(1_048_576);
    expect(cfg.logLevel).toBe('debug');
    expect(cfg.stateDir).toBe('/tmp/state');
  });

  it('rejects an unknown timezone the same way loadConfig does', () => {
    let err: unknown;
    try {
      loadVaultConfig({ VAULT_PATH: '/tmp/vault', VAULT_TIMEZONE: 'Mars/Olympus' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).invalid).toEqual(['VAULT_TIMEZONE']);
    expect((err as ConfigError).message).toContain('IANA');
  });

  it('rejects a DAILY_NOTES_FOLDER that would escape the vault, the same way loadConfig does', () => {
    let err: unknown;
    try {
      loadVaultConfig({ VAULT_PATH: '/tmp/vault', DAILY_NOTES_FOLDER: '../x' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).invalid).toEqual(['DAILY_NOTES_FOLDER']);
  });

  it('defaults to process.env when called with no argument', () => {
    const prevVaultPath = process.env.VAULT_PATH;
    process.env.VAULT_PATH = '/tmp/env-default-vault';
    try {
      expect(loadVaultConfig().vaultPath).toBe('/tmp/env-default-vault');
    } finally {
      if (prevVaultPath === undefined) delete process.env.VAULT_PATH;
      else process.env.VAULT_PATH = prevVaultPath;
    }
  });
});
