import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  describeListenError,
  isLoopbackHost,
  loadConfig,
  nonLocalBindWarning,
} from './config.js';

const tokens = { DASHBOARD_TOKEN: 'd'.repeat(32), MCP_TOKEN: 'm'.repeat(32) };

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(tokens)).toEqual({
      host: '127.0.0.1',
      port: 8787,
      dbPath: './data/loop.db',
      dashboardToken: tokens.DASHBOARD_TOKEN,
      mcpToken: tokens.MCP_TOKEN,
      corsOrigins: ['http://127.0.0.1:3737', 'http://localhost:3737'],
      publicUrl: null,
      allowSharedMcpToken: false,
    });
  });

  it('reads every variable', () => {
    const config = loadConfig({
      ...tokens,
      SERVER_HOST: '0.0.0.0',
      ALLOW_NON_LOCAL_BIND: 'on',
      SERVER_PORT: '9000',
      LOOP_DB_PATH: '/var/loop.db',
      CORS_ORIGINS: 'https://dash.example.com, https://preview.example.com,',
      SERVER_URL: 'https://loop.example.com',
      MCP_ALLOW_SHARED_TOKEN: 'on',
    });
    expect(config).toMatchObject({
      allowSharedMcpToken: true,
      host: '0.0.0.0',
      port: 9000,
      dbPath: '/var/loop.db',
      corsOrigins: ['https://dash.example.com', 'https://preview.example.com'],
      publicUrl: 'https://loop.example.com',
    });
  });

  it('lists every problem at once', () => {
    let error: unknown;
    try {
      loadConfig({ MCP_TOKEN: 'short', SERVER_PORT: 'eighty' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(/DASHBOARD_TOKEN must be set/);
    expect((error as Error).message).toMatch(/MCP_TOKEN must be set/);
    expect((error as Error).message).toMatch(/SERVER_PORT must be a port number/);
  });

  it('refuses tokens hono bearer auth would reject', () => {
    expect(() => loadConfig({ ...tokens, DASHBOARD_TOKEN: 'dash-token-0123456789#abc' })).toThrow(
      /DASHBOARD_TOKEN may only contain letters, digits/,
    );
    expect(() => loadConfig({ ...tokens, MCP_TOKEN: 'mcp token with spaces 0123' })).toThrow(
      /MCP_TOKEN may only/,
    );
    expect(loadConfig({ ...tokens, MCP_TOKEN: 'abcDEF0123456789._~+/-==' }).mcpToken).toBe(
      'abcDEF0123456789._~+/-==',
    );
  });

  it('refuses one token for both roles', () => {
    expect(() => loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(20), MCP_TOKEN: 'x'.repeat(20) })).toThrow(
      /must differ/,
    );
  });

  it('refuses MCP_ALLOW_SHARED_TOKEN=on in production', () => {
    expect(() => loadConfig({ ...tokens, MCP_ALLOW_SHARED_TOKEN: 'on', NODE_ENV: 'production' })).toThrow(
      /MCP_ALLOW_SHARED_TOKEN=on is for manual testing only/,
    );
    expect(
      loadConfig({ ...tokens, MCP_ALLOW_SHARED_TOKEN: 'on', NODE_ENV: 'development' }).allowSharedMcpToken,
    ).toBe(true);
  });
});

describe('local-only defaults', () => {
  it('recognises loopback hosts only', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]'])
      expect(isLoopbackHost(h)).toBe(true);
    for (const h of ['0.0.0.0', '::', '192.168.1.5', '127.0.0.1.evil.com', 'example.com']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
    expect(nonLocalBindWarning('127.0.0.1')).toBeNull();
    expect(nonLocalBindWarning('0.0.0.0')).toContain('WARNING');
  });

  it('refuses a non-loopback SERVER_HOST unless ALLOW_NON_LOCAL_BIND=on', () => {
    expect(() => loadConfig({ ...tokens, SERVER_HOST: '0.0.0.0' })).toThrow(/ALLOW_NON_LOCAL_BIND=on/);
    expect(() => loadConfig({ ...tokens, SERVER_HOST: '0.0.0.0', ALLOW_NON_LOCAL_BIND: 'yes' })).toThrow(
      ConfigError,
    );
    expect(loadConfig({ ...tokens, SERVER_HOST: '0.0.0.0', ALLOW_NON_LOCAL_BIND: 'on' }).host).toBe(
      '0.0.0.0',
    );
    expect(loadConfig({ ...tokens, SERVER_HOST: 'localhost' }).host).toBe('localhost');
  });

  it('defaults CORS to the local dashboard on DASHBOARD_PORT, and CORS_ORIGINS overrides it', () => {
    expect(loadConfig({ ...tokens, DASHBOARD_PORT: '4000' }).corsOrigins).toEqual([
      'http://127.0.0.1:4000',
      'http://localhost:4000',
    ]);
    expect(loadConfig({ ...tokens, CORS_ORIGINS: 'https://x.example' }).corsOrigins).toEqual([
      'https://x.example',
    ]);
    expect(() => loadConfig({ ...tokens, DASHBOARD_PORT: 'abc' })).toThrow(/DASHBOARD_PORT/);
  });

  it('strips brackets from SERVER_HOST', () => {
    expect(loadConfig({ ...tokens, SERVER_HOST: '[::1]' }).host).toBe('::1');
  });
});

describe('describeListenError', () => {
  const err = (code: string) => Object.assign(new Error(code), { code });
  it('names host, port and reason on one line', () => {
    expect(describeListenError(err('EADDRNOTAVAIL'), '127.0.0.2', 8787)).toMatch(
      /127\.0\.0\.2:8787.*EADDRNOTAVAIL/,
    );
    expect(describeListenError(err('ENOTFOUND'), 'nope.invalid', 8787)).toMatch(
      /nope\.invalid:8787.*ENOTFOUND/,
    );
    expect(describeListenError(err('EADDRINUSE'), '127.0.0.1', 8787)).toMatch(
      /127\.0\.0\.1:8787.*EADDRINUSE/,
    );
    expect(describeListenError(new Error('boom'), 'h', 1)).toContain('boom');
  });
});
