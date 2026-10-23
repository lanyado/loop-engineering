import { Server } from 'node:net';
import { accessConfig } from '../access';

type Env = Record<string, string | undefined>;

/**
 * The hostname Next was told to bind: `-H`/`--hostname` on the command line (`next start|dev`), or
 * HOSTNAME (the standalone server.js). Undefined when none is given: Next then binds every interface.
 */
export function requestedHostname(argv: readonly string[], env: Env): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-H' || arg === '--hostname') found = argv[i + 1] ?? '';
    else if (arg.startsWith('--hostname=')) found = arg.slice('--hostname='.length);
    else if (arg.startsWith('-H=')) found = arg.slice(3);
  }
  // The last flag wins, as in Next's own parser.
  return found ?? (env.HOSTNAME || undefined);
}

/**
 * Addresses this process actually listens on ("::", "0.0.0.0", "127.0.0.1", ...), read from its
 * live TCP servers. `next start` and the forked `next dev` worker have bound their port by the time
 * instrumentation runs; empty if not (then requestedHostname is the evidence).
 */
export function listeningAddresses(): string[] {
  const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
  const addresses: string[] = [];
  for (const handle of handles) {
    if (!(handle instanceof Server) || !handle.listening) continue;
    const address = handle.address();
    if (address && typeof address === 'object') addresses.push(address.address);
  }
  return addresses;
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * The host the access rules are judged on. A real non-loopback socket beats any flag; then the
 * hostname Next was given; a missing one means "every interface".
 */
export function effectiveBindHost(argv: readonly string[], env: Env, addresses: readonly string[]): string {
  const open = addresses.find((a) => !LOOPBACK_ADDRESSES.has(a));
  if (open !== undefined) return open === '' ? '0.0.0.0' : open;
  if (addresses.length > 0) return addresses[0] === '::1' ? '::1' : '127.0.0.1';
  const requested = requestedHostname(argv, env);
  if (requested === undefined || requested === '') return '0.0.0.0';
  return requested;
}

/**
 * Exits the process with one clear line when the dashboard's access setup is refused. The rules
 * are judged on the address it really binds, not just DASHBOARD_HOST: with no login, the loopback
 * bind is the only thing keeping other machines out (they can forge Host and Origin headers).
 */
export function refuseUnsafeStart(
  env: Env,
  bind: { argv: readonly string[]; addresses: readonly string[] } = {
    argv: process.argv,
    addresses: listeningAddresses(),
  },
  exit: (code: number) => never = (code) => process.exit(code),
  log: (line: string) => void = (line) => console.error(line),
): void {
  const host = effectiveBindHost(bind.argv, env, bind.addresses);
  // Password mode may bind anywhere; accessConfig then also demands its password and secret.
  const { problem } = accessConfig({ ...env, DASHBOARD_HOST: host });
  if (problem) {
    log(
      `[dashboard] refusing to start: ${problem} (bound to ${host}; run it with npm run start, or -H 127.0.0.1)`,
    );
    exit(1);
    return;
  }
  // From here on, the per-request checks judge the same host the server really binds.
  env.DASHBOARD_HOST = host;
}
