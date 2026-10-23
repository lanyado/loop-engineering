/**
 * Shapes of credentials, masked wherever text is stored or shown (transcripts, history search,
 * session titles). Over-masking is preferred to leaking: a false positive costs a word, a miss
 * costs a credential.
 */
export const SECRET_TOKEN_PATTERNS: readonly RegExp[] = [
  // GitHub
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // Anthropic (sk-ant-), OpenAI (sk-, sk-proj-), OpenRouter and other sk- keys
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // Slack tokens and webhooks, Discord webhooks
  /\bxox[a-z]-[A-Za-z0-9-]{8,}/g,
  /\bxapp-[A-Za-z0-9-]{8,}/g,
  /\bhooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]+/g,
  /\bdiscord(?:app)?\.com\/api\/webhooks\/[A-Za-z0-9_/-]+/g,
  // AWS access key ids
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA|ABIA|ACCA)[0-9A-Z]{16}/g,
  // Stripe
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bwhsec_[A-Za-z0-9]{16,}/g,
  // Google API keys, OAuth access tokens and client secrets
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bya29\.[0-9A-Za-z_-]{20,}/g,
  /\bGOCSPX-[0-9A-Za-z_-]{16,}/g,
  // GitLab, npm, Hugging Face, Vercel, Notion, Tavily, Linear, PostHog, Sentry, Groq, Perplexity, Replicate
  /\bgl(?:pat|dt|rt|ptt|cbt|oas|soat|ft|imt|agent)-[A-Za-z0-9_-]{16,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\bv(?:cp|ca|ci|cr|ck)_[A-Za-z0-9]{20,}/g,
  /\b(?:ntn|secret)_[A-Za-z0-9]{30,}/g,
  /\btvly-[A-Za-z0-9_-]{16,}/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{30,}/g,
  /\bph[cxs]_[A-Za-z0-9]{30,}/g,
  /\bsntry[su]_[A-Za-z0-9+/=_-]{30,}/g,
  /\b(?:gsk|pplx|r8)[_-][A-Za-z0-9]{30,}/g,
  // SendGrid, Twilio, DigitalOcean, Shopify
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /\bSK[0-9a-f]{32}\b/g,
  /\bdo[opr]_v1_[a-f0-9]{64}\b/g,
  /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g,
  // Telegram bot tokens: <bot id>:<secret>
  // (not \b: a token glued to a letter is still caught; digit runs only start the match once)
  /(?<![0-9])\d{6,12}:[A-Za-z0-9_-]{30,}/g,
  // JWTs
  // (starts only where a run starts, so a long run of "eyJ-eyJ-…" is scanned once)
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Private key headers (PEM, OpenSSH, PGP). redactSecrets masks the whole block, see privateKeyRanges.
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g,
];

/** Names whose values are treated as secrets when collecting values from an environment. */
const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD|PASS|CREDENTIAL/i;

/** Values shorter than this are never treated as secrets (they would mask ordinary words). */
const MIN_SECRET_LENGTH = 8;

/** Secret-looking values from an environment, e.g. process.env (comma lists are split). */
export function secretValues(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || !SECRET_NAME.test(name)) continue;
    for (const part of value.split(',').map((v) => v.trim()))
      if (part.length >= MIN_SECRET_LENGTH) out.push(part);
  }
  return out;
}

/** Env names whose values are secrets whatever they look like. */
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASS|PWD|CREDENTIAL|PRIVATE|AUTH|API/i;

/** Ordinary config words that are never treated as secrets, whatever the name. */
const COMMON_VALUES = new Set([
  'production',
  'development',
  'staging',
  'localhost',
  'test',
  'testing',
  'true',
  'false',
  'enabled',
  'disabled',
  'debug',
  'info',
  'warning',
  'error',
  'default',
  'postgres',
  'postgresql',
  'mysql',
  'redis',
  'sqlite',
  'us-east-1',
  'eu-west-1',
]);

/** Shannon entropy in bits per character. */
function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / value.length) * Math.log2(n / value.length);
  return bits;
}

/**
 * Whether a value looks random enough to be a credential: long, or of mixed character classes with
 * high entropy. Plain words, hosts, paths and URLs without credentials do not.
 */
export function looksRandom(value: string): boolean {
  if (/:\/\/[^\s/:@]+:[^\s/@]+@/.test(value)) return true; // a URL with a password in it
  if (/^[a-z][a-z0-9.-]*$/i.test(value) && !/\d.*[a-z]|[a-z].*\d/i.test(value)) return false; // a word
  if (/^(https?:\/\/|\/|\.\/)/.test(value)) return false; // a URL or path without credentials
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  if (value.length >= 20) return entropy(value) >= 3;
  return value.length >= 12 && classes >= 3 && entropy(value) >= 3;
}

/**
 * The secret values in a dotenv file: those under a secret-looking name (KEY, TOKEN, PASSWORD…) or
 * that look random. NODE_ENV=production or DB_HOST=localhost are left out, so they never get masked
 * in transcripts.
 */
export function envFileValues(content: string): string[] {
  const out: string[] = [];
  for (const line of content.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    let value = m[2].trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2] ?? '';
    else value = value.replace(/\s+#.*$/, '');
    if (value.length < MIN_SECRET_LENGTH || COMMON_VALUES.has(value.toLowerCase())) continue;
    if (SECRET_ENV_NAME.test(m[1]) || looksRandom(value)) out.push(value);
  }
  return out;
}

/*
 * Every rule must stay linear in the text length (the server redacts on its event loop): no
 * unbounded lookbehind, a bound on every quantifier that can fail after a long scan, and matches
 * that start only where a run starts when the body can span other starts. secrets.perf.test.ts
 * holds them to that on adversarial input.
 */

/** Words naming a secret setting: password, DB_PASSWORD, api_key, client_secret, BOT_TOKEN… */
const SECRET_KEYWORD = String.raw`(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credentials?|(?<![A-Za-z])auth|bearer)`; // not the "auth" in oauth
/** The keyword and the rest of the setting's name ("_TOKEN_V2"); the match starts at the keyword. */
const SECRET_SETTING = String.raw`${SECRET_KEYWORD}(?:[_.-][A-Za-z0-9_.-]{0,64})?`;
/** Values that are types or flags in code, not secrets. */
const NOT_A_VALUE = String.raw`(?!(?:string|number|boolean|null|undefined|true|false|none|required|optional|process\.env)\b)`;
const NAME_THEN = String.raw`${SECRET_SETTING}["']?\s*[:=]\s*`;

/**
 * Whether index sits in a URL's user:password part ("https://x-access-token:…@"): the URL rule
 * masks that and keeps the host readable. Checked in code at matches only, looking back at most
 * 256 characters, instead of a lookbehind that every position of the text would pay for.
 */
function inUrlUserinfo(text: string, index: number): boolean {
  for (let i = index - 1; i >= Math.max(0, index - 256); i--) {
    const c = text[i]!;
    if (c === '/') return text[i - 1] === '/';
    if (c === '@' || /\s/.test(c)) return false;
  }
  return false;
}
const notInUrl = (_m: string, text: string, index: number) => !inUrlUserinfo(text, index);

/** Rules whose `v` group (or whole match) is masked; `accept` filters matches further. */
interface Rule {
  re: RegExp;
  accept?: (match: string, text: string, index: number) => boolean;
}

const tokenRules: Rule[] = SECRET_TOKEN_PATTERNS.map((p) => ({ re: new RegExp(p.source, 'dg') }));

/**
 * Code identifiers and words joined up ("handleCheckoutFormSubmit2", "MAX_RETRY_COUNT"): every
 * piece is a word of two letters or more, or a short number. Random keys almost always have
 * one-letter pieces ("wJalrXUtn…" → w, Jalr, X, Utn…) or long digit runs.
 */
function looksLikeIdentifier(value: string): boolean {
  const pieces = value
    .split(/[^A-Za-z0-9]+/)
    .flatMap((p) => p.match(/[A-Z]{2,}(?![a-z])|[A-Z]?[a-z]+|[A-Z]|\d+/g) ?? []);
  if (pieces.length < 3) return false;
  return pieces.every((p) => (/^\d+$/.test(p) ? p.length <= 3 : p.length >= 2));
}

/** Not secrets though random-looking: SRI hashes (sha256-…) and GitHub diff anchors (#diff-…). */
function inNonSecretContext(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 8), index);
  const start = text.slice(index, index + 8);
  return (
    /(?:sha(?:256|384|512)-|#diff-)$/.test(before) ||
    /^sha(?:256|384|512)-/.test(start) ||
    (/^diff-/.test(start) && before.endsWith('#'))
  );
}

/** Upper, lower and digit, and close to random: a credential with a shape we do not know. */
function looksLikeKey(value: string, text: string, index: number): boolean {
  if (!(/[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value) && entropy(value) >= 4.3))
    return false;
  return !inNonSecretContext(text, index) && !looksLikeIdentifier(value);
}

/** Mixed case with a digit or "+", not hex (a git hash), not a path, not an identifier. */
function looksLikeAwsSecret(value: string, text: string, index: number): boolean {
  if (value.startsWith('/') || value.includes('//') || /^[0-9a-fA-F]+$/.test(value)) return false;
  if (!(/[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9+]/.test(value))) return false;
  return !inNonSecretContext(text, index) && !looksLikeIdentifier(value);
}

const RULES: Rule[] = [
  ...tokenRules,
  // Credentials in URLs: https://user:token@host (the scheme starts where a word starts, at most 30 long)
  { re: /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,30}:\/\/(?<v>[^\s/@:]+(?::[^\s/@]*)?)@/dgi },
  // Authorization headers
  { re: /\b(?:Bearer|Basic)\s+(?<v>[A-Za-z0-9._~+/=-]{8,})/dgi },
  {
    re: new RegExp(
      String.raw`\bauthorization["']?\s*[:=]\s*["']?(?!Bearer\b|Basic\b)${NOT_A_VALUE}(?<v>[^\s"',;]{6,})`,
      'dgi',
    ),
  },
  // name = value, name: "value", "name": "value", ?name=value (env files, YAML, JSON, code, URL queries)
  {
    re: new RegExp(`${NAME_THEN}(["'\`])${NOT_A_VALUE}(?<v>[^"'\`\\n]{3,512}?)\\1`, 'dgi'),
    accept: notInUrl,
  },
  { re: new RegExp(`${NAME_THEN}${NOT_A_VALUE}(?<v>[^\\s"'\`,;&)}\\]<>]{4,512})`, 'dgi'), accept: notInUrl },
  // "my password is Hunter2!x": prose, only for values that are not plain words
  {
    re: new RegExp(
      String.raw`${SECRET_SETTING}\s{1,8}(?:is|was|=)\s{1,8}(?=[^\s"'\`,;]{0,512}[0-9!@#$%^&*])(?<v>[^\s"'\`,;]{8,512})`,
      'dgi',
    ),
  },
  // Long random-looking strings of unknown shape (not hex hashes: those need upper and lower case).
  { re: /(?<![A-Za-z0-9+_-])[A-Za-z0-9+_-]{40,}={0,2}(?![A-Za-z0-9+_=-])/dg, accept: looksLikeKey },
  // AWS secret access keys: 40 characters of base64 (with "/" and "+"), no prefix; longer runs too,
  // in case the key is glued to the next word.
  { re: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40,}(?![A-Za-z0-9/+=])/dg, accept: looksLikeAwsSecret },
];

/** For the performance test: every regex redactSecrets runs. */
export const REDACTION_REGEXES: readonly RegExp[] = RULES.map((r) => r.re);

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const PRIVATE_KEY_END_ALL = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
/** What a key body is made of, also JSON-escaped: as far as a block cut off before END goes. */
const KEY_TEXT = /[A-Za-z0-9+/=\s\\:-]*/y;
const MAX_KEY_BLOCK = 64 * 1024;

/** Whole private key blocks: BEGIN to the next END, or as far as key text goes when END is missing. */
function privateKeyRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  if (!text.includes('PRIVATE KEY')) return ranges;
  const ends = [...text.matchAll(PRIVATE_KEY_END_ALL)].map((m) => [m.index, m.index + m[0].length] as const);
  let next = 0;
  let covered = 0;
  for (const begin of text.matchAll(PRIVATE_KEY_BEGIN)) {
    if (begin.index < covered) continue;
    while (next < ends.length && ends[next]![0] < begin.index) next++;
    const end = ends[next];
    let stop: number;
    if (end && end[0] - begin.index <= MAX_KEY_BLOCK) stop = end[1];
    else {
      KEY_TEXT.lastIndex = begin.index + begin[0].length;
      KEY_TEXT.exec(text);
      stop = KEY_TEXT.lastIndex;
    }
    ranges.push([begin.index, stop]);
    covered = stop;
  }
  return ranges;
}

const TOKEN_CHAR = /[A-Za-z0-9_+/=.:~-]/;

/**
 * The text with line breaks inside tokens removed ("ghp_abc\ndef" → "ghp_abcdef"), as do "\n"
 * escapes and indentation after a break, plus the map back to the original positions. A token
 * wrapped by a terminal, an editor or split between two text blocks is still found.
 */
function joinWrapped(text: string): { joined: string; map: number[] } | null {
  if (!text.includes('\n') && !text.includes('\\n')) return null;
  const isToken = (i: number) => i >= 0 && i < text.length && TOKEN_CHAR.test(text[i]!);
  /** Length of a break at i ("\n", "\r\n" plus indentation, or a "\n" escape), or 0. */
  const breakAt = (i: number) => {
    let j = i;
    if (text[j] === '\\' && text[j + 1] === 'n') return 2;
    if (text[j] === '\r') j++;
    if (text[j] !== '\n') return 0;
    j++;
    while (text[j] === ' ' || text[j] === '\t') j++;
    return j - i;
  };
  const parts: string[] = [];
  const map: number[] = [];
  let changed = false;
  let from = 0;
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (c !== '\n' && c !== '\r' && c !== '\\') continue;
    const len = breakAt(i);
    if (len === 0 || !isToken(i - 1) || !isToken(i + len)) continue;
    parts.push(text.slice(from, i));
    for (let k = from; k < i; k++) map.push(k);
    from = i + len;
    i = from - 1;
    changed = true;
  }
  if (!changed) return null;
  parts.push(text.slice(from));
  for (let k = from; k < text.length; k++) map.push(k);
  return { joined: parts.join(''), map };
}

function matches(text: string, values: readonly string[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const v of values) {
    if (v.length < MIN_SECRET_LENGTH) continue;
    for (let at = text.indexOf(v); at !== -1; at = text.indexOf(v, at + v.length))
      ranges.push([at, at + v.length]);
  }
  ranges.push(...privateKeyRanges(text));
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      if (rule.accept && !rule.accept(m[0], text, m.index)) continue;
      const span = m.indices?.groups?.v ?? m.indices?.[0];
      if (span && span[1] > span[0]) ranges.push([span[0], span[1]]);
    }
  }
  return ranges;
}

/**
 * Masks known values, token shapes, private key blocks, `name=value` secrets, credentials in URLs
 * and Authorization headers with ***, also when a line break was put inside a token.
 */
export function redactSecrets(text: string, values: readonly string[] = []): string {
  const ranges = matches(text, values);
  const wrapped = joinWrapped(text);
  if (wrapped) {
    for (const [s, e] of matches(wrapped.joined, values)) {
      ranges.push([wrapped.map[s] ?? text.length, (wrapped.map[e - 1] ?? text.length - 1) + 1]);
    }
  }
  if (ranges.length === 0) return text;
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = '';
  let at = 0;
  for (const [s, e] of ranges) {
    if (e <= at) continue;
    if (s > at) out += text.slice(at, s);
    if (s >= at) out += '***';
    at = e;
  }
  return out + text.slice(at);
}

/** Starts of known token shapes: a text ending in one may have had the rest of a token cut off. */
const TOKEN_START = String.raw`(?:gh[pousr]_|github_pat_|sk[-_]|rk_|pk_|whsec_|xox[a-z]-|xapp-|AKIA|ASIA|AIza|ya29\.|GOCSPX-|gl[a-z]{2,5}-|npm_|hf_|vc[pacirk]_|ntn_|secret_|tvly-|lin_api_|ph[cxs]_|sntry[su]_|gsk_|pplx-|r8_|SG\.|eyJ|\d{6,12}:)`;
const TRAILING_TOKEN = new RegExp(String.raw`(?:\b${TOKEN_START}[A-Za-z0-9_.+/=:-]*|-----BEGIN[^\n]*)$`);
const EDGE_WINDOW = 4096;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const TRAILING_RUN = /[A-Za-z0-9+/=_-]{12,}$/;
const LEADING_RUN = /^[A-Za-z0-9+/=_-]{12,}/;
const mixed = (s: string) => /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s);

/**
 * Masks what may be half a token at the edges of a piece of text: where a message was split or a
 * long text was cut. A known token start at the end, or a long mixed-case run with digits at
 * either end, becomes ***. Run on text that went through redactSecrets.
 */
export function maskEdgeFragments(text: string, edges: 'both' | 'start' | 'end' = 'both'): string {
  let out = text;
  // Only a window at each edge is looked at, so a multi-megabyte text costs no more than a short one.
  if (edges !== 'start') {
    const from = Math.max(0, out.length - EDGE_WINDOW);
    const end = out.slice(from);
    const token = TRAILING_TOKEN.exec(end);
    if (token) out = `${out.slice(0, from + token.index)}***`;
    else {
      const run = TRAILING_RUN.exec(end);
      if (run && mixed(run[0])) out = `${out.slice(0, from + run.index)}***`;
    }
  }
  if (edges !== 'end') {
    // The rest of a private key whose BEGIN line was cut away: everything up to its END line.
    const keyEnd = PRIVATE_KEY_END.exec(out.slice(0, EDGE_WINDOW * 4));
    if (keyEnd && !out.slice(0, keyEnd.index).includes('-----BEGIN')) {
      out = `***${out.slice(keyEnd.index + keyEnd[0].length)}`;
    }
    const run = LEADING_RUN.exec(out.slice(0, EDGE_WINDOW));
    if (run && mixed(run[0])) out = `***${out.slice(run[0].length)}`;
  }
  return out;
}
