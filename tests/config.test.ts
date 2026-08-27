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
