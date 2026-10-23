import { describe, expect, it } from 'vitest';
import { maskEdgeFragments, redactSecrets, REDACTION_REGEXES } from './secrets.js';

/*
 * Redaction runs on the server's event loop (transcript sweep, search_history, /api/history), so
 * every regex must stay linear. Each input is about 1 MB of text built to make a careless regex
 * backtrack: long runs of separators, near-miss tokens, unclosed blocks.
 */
const MB = 1024 * 1024;
const fill = (unit: string, size = MB) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
let seed = 42;
const random = (alphabet: string, size: number) => {
  let out = '';
  for (let i = 0; i < size; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    out += alphabet[seed % alphabet.length];
  }
  return out;
};
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const INPUTS: [string, string][] = [
  ['dots', fill('a.')],
  ['underscores', fill('a_')],
  ['dashes', fill('a-')],
  ['slashes', fill('a/')],
  ['double slashes', fill('//')],
  ['equals', fill('=')],
  ['a=', fill('a=')],
  ['random base64url', random(B64URL, MB)],
  ['random base64 with / and +', random(`${B64URL.slice(0, 62)}/+`, MB)],
  ['random base64url, 2 MB', random(B64URL, 2 * MB)],
  ['Bearer', fill('Bearer ')],
  ['Bearer glued', fill('Bearer\t')],
  ['short ghp_', fill('ghp_short ')],
  ['eyJ run', fill('eyJ-')],
  ['eyJ no dot', fill('eyJabcdefghijk_')],
  ['sk- run', fill('sk-')],
  ['telegram near miss', fill(`1234567:${'a'.repeat(29)} `)],
  ['telegram colons', fill('1234567:')],
  ['unclosed key blocks', fill('-----BEGIN PRIVATE KEY-----.\n')],
  ['BEGIN headers', fill('-----BEGIN ')],
  ['END lines', fill('-----END PRIVATE KEY-----')],
  ['token=', fill('token=')],
  ['token.token', fill('token.')],
  ['token then spaces', `token${' '.repeat(MB)}`],
  ['password is', fill('password is ')],
  ['quoted value never closed', `password="${'a'.repeat(MB)}`],
  ['url scheme near miss', fill('a://a:')],
  ['scheme run', fill('a.b+c-')],
  ['user:pass no @', fill('https://user:')],
  ['authorization', fill('authorization: ')],
  ['SG.', fill('SG.')],
  ['AKIA', fill('AKIA')],
  ['mixed run (generic rule accept)', fill('aB3')],
  ['camel words', fill('handleCheckoutForm2')],
  ['newlines between token chars', fill('a\n')],
  ['escaped newlines', fill('a\\n')],
  ['indented breaks', fill('ab\n    ')],
  ['sha256- anchors', fill('sha256-')],
  ['prose', fill('The quick brown fox, token: none; password is unset. ')],
];

describe('redaction stays linear', () => {
  it.each(INPUTS)(
    '%s: every regex and redactSecrets well under a second',
    (_name, text) => {
      const slow: string[] = [];
      for (const re of REDACTION_REGEXES) {
        const t0 = performance.now();
        for (const m of text.matchAll(re)) void m;
        const ms = performance.now() - t0;
        if (ms > 500) slow.push(`${re.source.slice(0, 60)}: ${Math.round(ms)} ms`);
      }
      expect(slow).toEqual([]);
      const t0 = performance.now();
      redactSecrets(text, ['plainvalue99']);
      maskEdgeFragments(text);
      expect(performance.now() - t0).toBeLessThan(1000);
    },
    60_000,
  );
});
