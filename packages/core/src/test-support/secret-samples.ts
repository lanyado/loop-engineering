/**
 * Fake credentials of every shape the redaction knows, for tests. Each is built by concatenation so
 * no complete token-shaped literal sits in the source (secret scanners would flag it).
 * `prefix`: how many leading characters are the public, fixed start of the shape.
 */
export interface SecretSample {
  name: string;
  token: string;
  prefix: number;
}

const j = (...parts: string[]) => parts.join('');

export const SECRET_SAMPLES: readonly SecretSample[] = [
  { name: 'GitHub classic', token: j('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'), prefix: 4 },
  {
    name: 'GitHub fine-grained',
    token: j('github', '_pat_', '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzAB'),
    prefix: 11,
  },
  { name: 'Anthropic', token: j('sk-', 'ant-api03-', 'AbCdEf0123456789_GhIjKlMnOpQrStUv-wxyz'), prefix: 3 },
  { name: 'OpenAI', token: j('sk-', 'proj-', 'AbCdEf0123456789GhIjKlMnOpQrStUv'), prefix: 3 },
  { name: 'Slack bot', token: j('xox', 'b-', '1234567890-0987654321-AbCdEfGhIjKlMnOp'), prefix: 5 },
  { name: 'Slack app', token: j('xa', 'pp-', '1-A0123456789-0123456789-abcdef0123456789'), prefix: 5 },
  {
    name: 'Slack webhook',
    token: j('https://hooks.', 'slack.com/services/', 'T0AAAAAAA/B0BBBBBBB/', 'Xk9pQ2mZ7rT4vW1yB6nC3dF8'),
    prefix: 0,
  },
  {
    name: 'Discord webhook',
    token: j('https://discord.com/api/', 'webhooks/', '123456789012345678/', 'AbCdEf-0123456789_xyzQWERTY'),
    prefix: 0,
  },
  { name: 'AWS access key', token: j('AK', 'IA', 'IOSFODNN7EXAMPLE'), prefix: 4 },
  { name: 'AWS secret key', token: j('wJalrXUtnFEMI/', 'K7MDENG/bPxRfiCYEXAMPLEKEY'), prefix: 0 },
  { name: 'Stripe live', token: j('sk', '_live_', 'abcdefghijklmnop1234'), prefix: 3 },
  { name: 'Stripe test', token: j('sk', '_test_', '51AbCdEf0123456789'), prefix: 3 },
  { name: 'Stripe restricted', token: j('rk', '_live_', 'abcdefghijklmnop1234'), prefix: 3 },
  { name: 'Stripe webhook', token: j('wh', 'sec_', 'AbCdEf0123456789GhIjKl'), prefix: 6 },
  { name: 'Google API key', token: j('AI', 'za', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'), prefix: 4 },
  { name: 'Google OAuth', token: j('ya', '29.', 'a0AfH6SMBx0123456789abcdefghij'), prefix: 5 },
  { name: 'GitLab', token: j('gl', 'pat-', 'abcdefghij0123456789'), prefix: 6 },
  { name: 'npm', token: j('np', 'm_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'), prefix: 4 },
  { name: 'Hugging Face', token: j('h', 'f_', 'AbCdEfGhIjKlMnOpQrStUvWxYz01234567'), prefix: 3 },
  { name: 'Vercel', token: j('vc', 'p_', '1234567890abcdefghijklmnopqrstuvwxyzABCDEF'), prefix: 4 },
  { name: 'Notion', token: j('nt', 'n_', '123456789012345678901234567890123456789012345'), prefix: 4 },
  { name: 'Tavily', token: j('tv', 'ly-', 'dev-AbCdEf0123456789xyz'), prefix: 5 },
  { name: 'Telegram bot', token: j('7712345678', ':', 'AAHk3jXyZq9vL0pQwErTyUiOpAsDfGhJkLz'), prefix: 11 },
  {
    name: 'JWT',
    token: j(
      'ey',
      'JhbGciOiJIUzI1NiJ9',
      '.eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      '.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ),
    prefix: 3,
  },
  { name: 'SendGrid', token: j('S', 'G.', 'AbCdEf0123456789xyzw.GhIjKl0123456789mnopqr'), prefix: 3 },
  { name: 'Linear', token: j('lin', '_api_', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'), prefix: 8 },
];

/** A fake private key block (PEM body lines included). */
export const PRIVATE_KEY = [
  j('-----BEGIN OPENSSH ', 'PRIVATE KEY-----'),
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQyNTUxOQAAACDKEYBODYONE',
  'AAAAC3NzaC1lZDI1NTE5AAAAIKEYBODYTWO0123456789abcdefABCDEF',
  j('-----END OPENSSH ', 'PRIVATE KEY-----'),
].join('\n');

/** True when no 8-character piece of the token's secret part (its last 16 characters) is in `text`. */
export function holdsNoPieceOf(text: string, token: string): boolean {
  const secret = token.slice(-16);
  for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) return false;
  return true;
}
