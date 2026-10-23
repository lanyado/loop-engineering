import { describe, expect, it } from 'vitest';
import { envFileValues, looksRandom, maskEdgeFragments, redactSecrets } from './secrets.js';
import { holdsNoPieceOf, PRIVATE_KEY, SECRET_SAMPLES } from './test-support/secret-samples.js';

describe('envFileValues', () => {
  it('keeps values under secret names or that look random, and leaves ordinary config out', () => {
    const env = [
      'NODE_ENV=production',
      'DB_HOST=localhost',
      'APP_NAME=shopfront',
      'PUBLIC_URL=https://shop.example.com',
      'LOG_LEVEL=warning',
      'CACHE_DIR=/var/cache/shop',
      'STRIPE_KEY=plainword', // secret name: kept even though it is a word
      'DB_PASSWORD="hunter22hunter"',
      'export SESSION_SALT=Zx9!q2Lr#7vB',
      'DATABASE_URL=postgres://app:s3cret@db:5432/shop',
      'BUILD_ID=a8f3e9c1b7d24f6e9a0c3b5d7e1f2a4c',
    ].join('\n');
    expect(envFileValues(env)).toEqual([
      'plainword',
      'hunter22hunter',
      'Zx9!q2Lr#7vB',
      'postgres://app:s3cret@db:5432/shop',
      'a8f3e9c1b7d24f6e9a0c3b5d7e1f2a4c',
    ]);
  });

  it('never counts common words, even under a secret name', () => {
    expect(envFileValues('AUTH_MODE=disabled\nAPI_ENV=production')).toEqual([]);
  });

  it('looksRandom', () => {
    expect(looksRandom('localhost')).toBe(false);
    expect(looksRandom('my-service-name')).toBe(false);
    expect(looksRandom('9fK2mQ7xL0pZ4wR8tY6u')).toBe(true);
  });
});

describe('token shapes', () => {
  it.each([
    ['Stripe', 'sk_live_abcdefghijklmnop1234'],
    ['Stripe restricted', 'rk_live_abcdefghijklmnop1234'],
    ['Google', `AIza${'B'.repeat(35)}`],
    ['GitLab', 'glpat-abcdefghij0123456789'],
    ['npm', `npm_${'a'.repeat(36)}`],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
  ])('redacts %s', (_label, token) => {
    expect(redactSecrets(`x = "${token}"`)).toBe('x = "***"');
  });
});

describe('redactSecrets', () => {
  it.each(SECRET_SAMPLES.map((s) => [s.name, s.token]))(
    'masks a %s token in prose, quotes and JSON',
    (_n, token) => {
      for (const text of [
        `use ${token} now`,
        `x = "${token}"`,
        JSON.stringify({ value: token }),
        `${token}`,
      ]) {
        const out = redactSecrets(text);
        expect(out).toContain('***');
        expect(holdsNoPieceOf(out, token)).toBe(true);
      }
    },
  );

  it.each(SECRET_SAMPLES.map((s) => [s.name, s.token]))(
    'masks a %s token wrapped across lines',
    (_n, token) => {
      for (const cut of [token.length >> 1, token.length - 5, 9]) {
        for (const brk of ['\n', '\r\n', '\n    ', '\\n']) {
          // A blank line ends it (a single line break after a token may take the next word with it).
          const out = redactSecrets(
            `token below:\n${token.slice(0, cut)}${brk}${token.slice(cut)}\n\nthanks`,
          );
          expect(holdsNoPieceOf(out, token), `${JSON.stringify(brk)} at ${cut}: ${out}`).toBe(true);
          expect(out).toContain('thanks');
        }
      }
    },
  );

  it('masks whole private key blocks: multi-line, JSON-escaped and cut off before END', () => {
    const body = ['KEYBODYONE', 'KEYBODYTWO0123456789abcdefABCDEF'];
    const check = (out: string) => {
      expect(out).not.toContain('KEYBODY');
      expect(out).not.toContain('b3BlbnNzaC1rZXktdjE');
    };
    check(redactSecrets(`here is my key\n${PRIVATE_KEY}\nkeep this line`));
    expect(redactSecrets(`here is my key\n${PRIVATE_KEY}\n. keep this`)).toContain('keep this');
    check(redactSecrets(JSON.stringify({ key: PRIVATE_KEY })));
    check(redactSecrets(PRIVATE_KEY.split('\n').slice(0, 3).join('\n')));
    for (const kind of ['RSA ', 'EC ', '', 'ENCRYPTED ', 'PGP ']) {
      const begin = `-----BEGIN ${kind}PRIVATE KEY${kind === 'PGP ' ? ' BLOCK' : ''}-----`;
      check(redactSecrets(`${begin}\n${body.join('\n')}\n-----END ${kind}PRIVATE KEY-----`));
    }
  });

  it('masks secret settings in env, YAML, JSON, code, URL query and prose forms', () => {
    const cases: [string, string][] = [
      ['password=Hunter2!SuperSecret99', 'Hunter2!SuperSecret99'],
      ['DB_PASSWORD="correct horse battery"', 'correct horse battery'],
      ["export API_KEY='k3y-v4lue-0001'", 'k3y-v4lue-0001'],
      ['passwd: s3cr3t-pa55', 's3cr3t-pa55'],
      ['client_secret: abcdEFGH1234', 'abcdEFGH1234'],
      ['{"api_key": "abc123def456"}', 'abc123def456'],
      ['{"accessToken":"tok-9988776655"}', 'tok-9988776655'],
      ['GET /v1?user=me&token=q1w2e3r4t5&x=1', 'q1w2e3r4t5'],
      ['https://api.example.com/data?api-key=zz99yy88xx77', 'zz99yy88xx77'],
      ['Authorization: Bearer abc.def-123_456~ghi', 'abc.def-123_456~ghi'],
      ['authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
      ['"Authorization": "tok_live_12345678"', 'tok_live_12345678'],
      ['curl -H "X-Auth-Token: 5f4dcc3b5aa765d6"', '5f4dcc3b5aa765d6'],
      ['my db password is Hunter2!Secret', 'Hunter2!Secret'],
      ['DATABASE_URL=postgres://admin:S3cr3tPa55w0rd@db.example.com/app', 'S3cr3tPa55w0rd'],
      ['clone https://x-access-token:abcdef123456@github.com/me/repo.git', 'abcdef123456'],
      ['aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI/K7MDENG'],
      ['private_key: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'],
      // Long random strings of no known shape.
      ['use Zx81QpLm0vNc7TyR2uWs4EoA9dGh6JkF3bVi5XqY', 'Zx81QpLm0vNc7TyR2uWs4EoA9dGh6JkF3bVi5XqY'],
    ];
    for (const [text, secret] of cases) expect(redactSecrets(text), text).not.toContain(secret);
    // The URL keeps its host; the setting keeps its name.
    expect(redactSecrets(cases[15]![0])).toBe('clone https://***@github.com/me/repo.git');
    expect(redactSecrets('password=Hunter2!SuperSecret99 ok')).toBe('password=*** ok');
  });

  it('masks a bare AWS secret access key in every form', () => {
    const key = SECRET_SAMPLES.find((x) => x.name === 'AWS secret key')!.token;
    for (const text of [
      `Please use ${key} for the deploy`,
      `"${key}"`,
      `'${key}'`,
      JSON.stringify({ secret: key }),
      JSON.stringify({ value: key }),
      `aws:\n  secret: ${key}\n`,
      `- ${key}`,
      `key:${key}`,
      `AKIAIOSFODNN7EXAMPLE ${key}`,
      `${key.slice(0, 17)}\n${key.slice(17)} done`,
      `${key.slice(0, 30)}\n    ${key.slice(30)}`,
    ]) {
      const out = redactSecrets(text);
      expect(holdsNoPieceOf(out, key), text).toBe(true);
      expect(out).not.toContain('wJalrXUtnFEMI');
    }
  });

  it('leaves ordinary text, hashes, paths and type annotations alone', () => {
    for (const text of [
      'Fixed the tokenizer and the password reset page.',
      'commit 3f2a9c1b7d24f6e9a0c3b5d7e1f2a4c8b9d0e1f2 merged',
      'see /Users/me/projects/shop-web/src/components/CheckoutForm.tsx',
      'interface Login { password: string; token: string | null }',
      'The API key is set in Vercel.',
      'id 123e4567-e89b-12d3-a456-426614174000',
      'short sha 3f2a9c1 and full 3F2A9C1B7D24F6E9A0C3B5D7E1F2A4C8B9D0E1F2',
      'src/components/checkout/CheckoutFormHeader.tsx and /Users/me/shopweb/src/AppRootLayoutX',
      'handleCheckoutFormSubmission and MAX_RETRY_ATTEMPTS_FOR_PAYMENT_WEBHOOKS',
      'https://github.com/example/shop-web/pull/12 v1.2.3 #4f46e5',
      'git rebase -i HEAD~3 on feature/import-sessions-finished-group',
      'npm run build -w @loop-engineering/dashboard opens password-reset.html',
      'renders MyVeryLongComponentNameForTheDashboardSessionTreeViewRowItem2 here',
      'calls setStateForTheDashboardSessionTreeViewRowItemToggle2(true) on click',
      'see https://github.com/example/shop-web/pull/12/files#diff-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdefA1',
      '<script integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC">',
      'integrity sha512-Fq3Yy7nB0dC8sP2mQ4rT6vW1xZ5aE9gH3jK7lN0pR2sU4wX6yA8bD0fG2hJ4kL6m',
      'const authorization: string = header;',
      'oauth_callback: https://example.com/cb and max_tokens: 4096, author: Rotem Lanyado',
    ])
      expect(redactSecrets(text)).toBe(text);
  });

  it('masks known values, also wrapped across lines', () => {
    expect(redactSecrets('pw is plainvalue99 ok', ['plainvalue99'])).toBe('pw is *** ok');
    expect(redactSecrets('pw is plain\nvalue99 ok', ['plainvalue99'])).toBe('pw is *** ok');
  });
});

describe('Telegram tokens', () => {
  it('are masked also when glued to a letter or inside a bot URL', () => {
    const t = SECRET_SAMPLES.find((x) => x.name === 'Telegram bot')!.token;
    for (const text of [`x${t}`, `id:${t}`, `https://api.telegram.org/bot${t}/getMe`, `"${t}"`])
      expect(holdsNoPieceOf(redactSecrets(text), t), text).toBe(true);
  });
});

describe('maskEdgeFragments', () => {
  it.each(SECRET_SAMPLES.filter((s) => s.prefix > 0).map((s) => [s.name, s]))(
    'masks the start of a %s token cut at the end of a text',
    (_n, sample) => {
      for (let k = sample.prefix; k < sample.token.length; k++) {
        const out = maskEdgeFragments(`see ${sample.token.slice(0, k)}`, 'end');
        expect(out, `cut at ${k}`).toBe('see ***');
      }
    },
  );

  it('masks a random-looking run at either edge and keeps words', () => {
    expect(maskEdgeFragments('Q7r8K1l2M3n4O5p6 is the rest')).toBe('*** is the rest');
    expect(maskEdgeFragments('the start was A1b2C3d4E5f6G7')).toBe('the start was ***');
    for (const text of ['2026-09-01T09:00:00 started', 'Done. All tests pass', 'internationalization'])
      expect(maskEdgeFragments(text)).toBe(text);
  });
});
