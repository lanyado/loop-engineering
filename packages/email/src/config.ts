export interface EmailConfig {
  /** The Gmail address the loop reads and sends from (best a dedicated account). */
  address: string;
  /** A Google app password for it (16 letters; spaces are dropped). */
  password: string;
  /** Who may send tasks: exact addresses, or "@domain" for everyone at a domain. Lower case. */
  allowlist: string[];
  /** How often the inbox is read. */
  pollMs: number;
}

export type EmailConfigResult = { enabled: true; config: EmailConfig } | { enabled: false; reason: string };

export class EmailConfigError extends Error {
  override name = 'EmailConfigError';
}

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Reads the email channel's settings from the environment. With no EMAIL_ADDRESS it is disabled.
 * An address with missing or invalid companions throws, listing every problem, so a half-configured
 * channel fails at start instead of silently never reading mail.
 */
export function loadEmailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfigResult {
  const read = (name: string) => env[name]?.trim() ?? '';
  const address = read('EMAIL_ADDRESS').toLowerCase();
  if (!address) return { enabled: false, reason: 'EMAIL_ADDRESS is not set' };

  const problems: string[] = [];
  if (!ADDRESS.test(address)) problems.push(`EMAIL_ADDRESS is not an email address: "${address}"`);
  const password = read('EMAIL_APP_PASSWORD').replace(/\s+/g, '');
  if (!password) problems.push('EMAIL_APP_PASSWORD is not set (a Google app password for EMAIL_ADDRESS)');
  const allowlist = read('EMAIL_ALLOWLIST')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length === 0)
    problems.push(
      'EMAIL_ALLOWLIST is empty: list who may send tasks (addresses or @domain), comma separated',
    );
  for (const entry of allowlist)
    if (!(entry.startsWith('@') ? ADDRESS.test(`x${entry}`) : ADDRESS.test(entry)))
      problems.push(`EMAIL_ALLOWLIST has "${entry}": use an address or @domain`);
  const pollText = read('EMAIL_POLL_SECONDS') || '60';
  const pollSeconds = Number(pollText);
  if (!Number.isInteger(pollSeconds) || pollSeconds < 15 || pollSeconds > 3600)
    problems.push(`EMAIL_POLL_SECONDS must be a whole number from 15 to 3600, got "${pollText}"`);

  if (problems.length > 0) throw new EmailConfigError(`email channel: ${problems.join('; ')}`);
  return { enabled: true, config: { address, password, allowlist, pollMs: pollSeconds * 1000 } };
}
