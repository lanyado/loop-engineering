import { simpleParser, type AddressObject } from 'mailparser';

/** One mail read from the inbox. */
export interface IncomingMail {
  /** Its IMAP UID: the inbox is read past the last one seen. */
  uid: number;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  /** The sender's address, lower case. */
  from: string;
  subject: string;
  /** The plain-text body, quoted mail included (replyText() strips it). */
  text: string;
  /** The provider's thread id (Gmail's X-GM-THRID), when it has one. */
  threadId: string | null;
  /** The receiving server vouched for the sender's domain (DMARC, or DKIM signed by that domain). */
  authenticated: boolean;
  /** An auto-reply, a bounce or a list digest: never answered, so two robots cannot loop. */
  automatic: boolean;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  /** Our own Message-ID for it, so replies can be matched to it. */
  messageId: string;
  inReplyTo?: string;
  references?: string[];
}

/** Where mail comes from and goes to: Gmail over IMAP and SMTP, or a fake in tests. */
export interface Mailbox {
  /** The address it sends from; mail from it is never treated as a task. */
  readonly address: string;
  /**
   * The mails that arrived after `cursor`, oldest first, and the cursor to pass next time. With no
   * cursor (the first run) nothing older is read: only mail that arrives from now on.
   */
  fetch(cursor: MailCursor | undefined): Promise<{ mails: IncomingMail[]; cursor: MailCursor }>;
  send(mail: OutgoingMail): Promise<void>;
  close(): Promise<void>;
}

export interface MailCursor {
  uidValidity: number;
  lastUid: number;
}

/** Direction marks some clients put around names and addresses (Gmail in right-to-left languages). */
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Whether lines i..i+n-1, read as one, are a quote's opening line ("On <date> ... wrote:" and the like). */
function attribution(lines: string[], i: number, n: number): boolean {
  if (i + n > lines.length || lines.slice(i, i + n).some((l) => l.trim() === '')) return false;
  const joined = lines
    .slice(i, i + n)
    .join(' ')
    .replace(BIDI, '')
    .trim();
  // In English, or in any language: a date and an address, ending with a colon.
  return (
    /^on\s.*\d.*wrote:$/i.test(joined) ||
    (/\d/.test(joined) && /<\s*[^<>\s]+@[^<>\s]+\s*>/.test(joined) && /:$/.test(joined))
  );
}

/** Whether line `i` opens a quoted earlier mail (clients wrap that line, so up to three are read). */
function opensQuote(lines: string[], i: number): boolean {
  const line = lines[i]!.replace(BIDI, '').trim();
  if (/^-{2,}\s*(original message|forwarded message)/i.test(line) || /^_{5,}$/.test(line)) return true;
  // Outlook: a "From:" line followed by its "Sent:"/"Date:"/"To:"/"Subject:" lines.
  if (/^from:\s/i.test(line))
    return lines
      .slice(i + 1, i + 4)
      .some((l) => /^(sent|date|to|subject):\s/i.test(l.replace(BIDI, '').trim()));
  // Line i opens it only when the attribution needs it (not when it already starts on the next line).
  for (let n = 1; n <= 3; n++) if (attribution(lines, i, n) && !attribution(lines, i + 1, n - 1)) return true;
  return false;
}

/**
 * The new text of a reply: what is above the quoted mail, without ">" lines. A reply written under
 * the quote (nothing above it) is the unquoted text below instead.
 */
export function replyText(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const quoted = (l: string) => /^\s*>/.test(l);
  const start = lines.findIndex((_, i) => opensQuote(lines, i));
  const above = (start < 0 ? lines : lines.slice(0, start))
    .filter((l) => !quoted(l))
    .join('\n')
    .trim();
  if (above || start < 0) return above;
  return lines
    .filter((l, i) => !quoted(l) && !opensQuote(lines, i) && i > start)
    .join('\n')
    .replace(/^.*wrote:\s*$/im, '')
    .trim();
}

/** "@example.com" (a domain) or an exact address, lower case; the allowlist's entries. */
export function allowed(address: string, allowlist: readonly string[]): boolean {
  const a = address.toLowerCase();
  return allowlist.some((entry) => (entry.startsWith('@') ? a.endsWith(entry) : a === entry));
}

/**
 * Whether Gmail vouched for the sender. Only the topmost Authentication-Results counts (Gmail adds
 * it on receipt; any below it came with the mail), only when Gmail wrote it, and only for the From
 * domain: DMARC passed for it, or a DKIM signature aligned with it passed. Comments are dropped
 * first, since they can carry text the sender chose (an envelope address, say).
 */
export function senderAuthenticated(topResults: string | undefined, from: string): boolean {
  const domain = from.split('@')[1]?.toLowerCase();
  if (!topResults || !domain) return false;
  // Quoted strings and escapes go first (a quoted address can hold ";", "(" or "dmarc=pass"), then
  // comments; anything still unbalanced is not a header to trust.
  let h = topResults
    .toLowerCase()
    .replace(/"(?:[^"\\]|\\.)*"/g, ' ')
    .replace(/\\./g, ' ');
  for (let prev = ''; prev !== h;) [prev, h] = [h, h.replace(/\([^()]*\)/g, ' ')];
  if (/["()\\]/.test(h)) return false;
  const [authserv, ...results] = h.split(';');
  if (authserv?.trim() !== 'mx.google.com') return false;
  // One DMARC verdict per mail: two mean one was smuggled in.
  if (results.filter((r) => /^\s*dmarc=/.test(r)).length > 1) return false;
  const aligned = (d: string) => d === domain || domain.endsWith(`.${d}`);
  return results.some((result) => {
    const r = result.trim();
    const prop = (name: string) => new RegExp(`(?:^|\\s)${name.replace('.', '\\.')}=([^\\s;]+)`).exec(r)?.[1];
    if (/^dmarc=pass\b/.test(r)) return prop('header.from') === domain;
    if (/^dkim=pass\b/.test(r)) {
      const d = prop('header.d') ?? prop('header.i')?.replace(/^.*@/, '');
      return d !== undefined && aligned(d);
    }
    return false;
  });
}

/** A header's text values: mailparser gives structured headers as objects, which have none. */
const headerList = (value: unknown): string[] =>
  (Array.isArray(value) ? (value as unknown[]) : [value]).filter((v): v is string => typeof v === 'string');
const headerText = (value: unknown): string => headerList(value).join(' ').toLowerCase();

const firstAddress = (from: AddressObject | AddressObject[] | undefined): string =>
  ((Array.isArray(from) ? from[0] : from)?.value[0]?.address ?? '').toLowerCase();

/** Reads one raw RFC 5322 message as an IncomingMail. */
export async function parseMail(
  source: Buffer | string,
  uid: number,
  threadId: string | null,
): Promise<IncomingMail> {
  const parsed = await simpleParser(source, { skipHtmlToText: false, skipImageLinks: true });
  const from = firstAddress(parsed.from);
  const lines = (key: string) =>
    parsed.headerLines.filter((l) => l.key === key).map((l) => l.line.slice(l.line.indexOf(':') + 1));
  // Two From headers: which one a client shows is not certain, so the mail is not trusted.
  const oneFrom = lines('from').length === 1;
  const header = (name: string) => parsed.headers.get(name);
  const precedence = headerText(header('precedence'));
  const autoSubmitted = headerText(header('auto-submitted')) || 'no';
  return {
    uid,
    messageId: parsed.messageId ?? `<uid-${uid}@unknown>`,
    inReplyTo: parsed.inReplyTo ?? null,
    references: headerList(parsed.references),
    from,
    subject: parsed.subject ?? '',
    text: parsed.text ?? '',
    threadId,
    authenticated: oneFrom && senderAuthenticated(lines('authentication-results')[0], from),
    automatic:
      autoSubmitted !== 'no' ||
      ['bulk', 'junk', 'list', 'auto_reply'].includes(precedence) ||
      header('x-autoreply') !== undefined ||
      /^(mailer-daemon|postmaster)@/i.test(from),
  };
}
