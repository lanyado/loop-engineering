import { errorMessage } from '@loop-engineering/core';

/** Server settings, read from the environment (see .env.example). */
export interface ServerConfig {
  /** Interface to bind. Default 127.0.0.1; use 0.0.0.0 behind a tunnel or on a public host. */
  host: string;
  /** Default 8787. 0 picks a free port (tests). */
  port: number;
  /** SQLite file holding orchestrator state. Relative paths are resolved by the caller (main.ts: repo root). */
  dbPath: string;
  /** Bearer token for /api/* (dashboard). */
  dashboardToken: string;
  /** Bearer token for /mcp (agents calling ask_human). */
  mcpToken: string;
  /** Origins allowed to call /api/* from a browser. Default: the local dashboard (127.0.0.1 and localhost on DASHBOARD_PORT). */
  corsOrigins: string[];
  /** Public URL sessions use to reach the server; informational (logged at start). */
  publicUrl: string | null;
  /**
   * Also accept the raw MCP_TOKEN on /mcp (MCP_ALLOW_SHARED_TOKEN=on), for manual testing. Off by
   * default: each session must present its own token, sessionToken(MCP_TOKEN, id).
   */
  allowSharedMcpToken?: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** True for 127.0.0.0/8, ::1 and localhost: addresses only this machine can reach. */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** The loud warning for a non-loopback bind, or null when the host is local. */
export function nonLocalBindWarning(host: string): string | null {
  if (isLoopbackHost(host)) return null;
  return (
    `WARNING: SERVER_HOST=${host} is not a loopback address. Other devices on the network can reach ` +
    'this server (and the ask_human MCP endpoint and /api). Use 127.0.0.1 unless you really mean it.'
  );
}

const MIN_TOKEN_LENGTH = 16;
// What an RFC 6750 bearer token may contain; hono's bearerAuth answers 400 to anything else.
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/;

/** Reads and validates the config. Throws ConfigError listing every problem at once. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const problems: string[] = [];
  const read = (name: string) => env[name]?.trim() ?? '';

  const token = (name: string) => {
    const value = read(name);
    if (value.length < MIN_TOKEN_LENGTH) {
      problems.push(
        `${name} must be set to a random string of at least ${MIN_TOKEN_LENGTH} characters ` +
          '(an unquoted # in .env starts a comment and cuts the value short)',
      );
    } else if (!TOKEN_PATTERN.test(value)) {
      problems.push(
        `${name} may only contain letters, digits and . _ ~ + / - (optionally ending in =), e.g. \`openssl rand -hex 32\``,
      );
    }
    return value;
  };

  const portText = read('SERVER_PORT') || '8787';
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    problems.push(`SERVER_PORT must be a port number, got "${portText}"`);
  }

  // Brackets (`[::1]`) are URL syntax; listen() wants the bare address.
  const host = (read('SERVER_HOST') || '127.0.0.1').replace(/^\[(.*)\]$/, '$1');
  if (!isLoopbackHost(host) && read('ALLOW_NON_LOCAL_BIND') !== 'on') {
    problems.push(
      `SERVER_HOST=${host} would expose the server beyond this machine. Use 127.0.0.1, or set ALLOW_NON_LOCAL_BIND=on to allow it`,
    );
  }
  const dashboardPortText = read('DASHBOARD_PORT') || '3737';
  const dashboardPort = Number(dashboardPortText);
  if (!Number.isInteger(dashboardPort) || dashboardPort < 1 || dashboardPort > 65535) {
    problems.push(`DASHBOARD_PORT must be a port number, got "${dashboardPortText}"`);
  }
  const explicitOrigins = read('CORS_ORIGINS')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const config: ServerConfig = {
    host,
    port,
    dbPath: read('LOOP_DB_PATH') || './data/loop.db',
    dashboardToken: token('DASHBOARD_TOKEN'),
    mcpToken: token('MCP_TOKEN'),
    corsOrigins:
      explicitOrigins.length > 0
        ? explicitOrigins
        : [`http://127.0.0.1:${dashboardPort}`, `http://localhost:${dashboardPort}`],
    publicUrl: read('SERVER_URL') || null,
    allowSharedMcpToken: read('MCP_ALLOW_SHARED_TOKEN') === 'on',
  };
  if (config.allowSharedMcpToken && read('NODE_ENV') === 'production') {
    problems.push(
      'MCP_ALLOW_SHARED_TOKEN=on is for manual testing only and is refused with NODE_ENV=production: ' +
        'every agent could act as any session',
    );
  }
  if (config.dashboardToken && config.dashboardToken === config.mcpToken) {
    problems.push('DASHBOARD_TOKEN and MCP_TOKEN must differ, so an agent token cannot answer questions');
  }
  if (problems.length > 0) throw new ConfigError(`Invalid server config:\n- ${problems.join('\n- ')}`);
  return config;
}

/** One clear line for a failed listen(), instead of an uncaught stack trace. */
export function describeListenError(error: unknown, host: string, port: number): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const where = `${host}:${port}`;
  switch (code) {
    case 'EADDRNOTAVAIL':
      return `Cannot listen on ${where}: that address is not available on this machine (EADDRNOTAVAIL). Use SERVER_HOST=127.0.0.1.`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Cannot listen on ${where}: the host name does not resolve (${code}). Use SERVER_HOST=127.0.0.1.`;
    case 'EADDRINUSE':
      return `Cannot listen on ${where}: the port is already in use (EADDRINUSE). Stop the other process or change SERVER_PORT.`;
    default:
      return `Cannot listen on ${where}: ${errorMessage(error)}`;
  }
}
