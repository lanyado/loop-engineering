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

/** Lines that open a quoted earlier mail: "On <date>, <name> wrote:" (in any language), "From:", "-----Original". */
const QUOTE_HEADER = [
  /^On .+wrote:\s*$/i,
  /^.*<[^<>\s]+@[^<>\s]+>.*:\s*$/,
  /^-{2,}\s*(Original Message|Forwarded message)/i,
  /^_{5,}\s*$/,
  /^From:\s.+/i,
];

/** The new text of a reply: everything above the quoted mail and the ">" lines. */
export function replyText(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Gmail wraps a long "On ..., ... <a@b> wrote:" over two lines.
    const joined = `${line} ${lines[i + 1] ?? ''}`;
    if (QUOTE_HEADER.some((re) => re.test(line)) || (/^On\s/i.test(line) && /wrote:\s*$/i.test(joined)))
      break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

/** "@example.com" (a domain) or an exact address, lower case; the allowlist's entries. */
export function allowed(address: string, allowlist: readonly string[]): boolean {
  const a = address.toLowerCase();
  return allowlist.some((entry) => (entry.startsWith('@') ? a.endsWith(entry) : a === entry));
}

/**
 * Whether the receiving server (Gmail writes Authentication-Results) vouched for the sender: DMARC
 * passed, or a DKIM signature of the From domain passed. A forged From fails both.
 */
export function senderAuthenticated(authenticationResults: string[], from: string): boolean {
  const domain = from.split('@')[1]?.toLowerCase() ?? '';
  return authenticationResults.some((header) => {
    const h = header.toLowerCase();
    if (/\bdmarc=pass\b/.test(h)) return true;
    return [...h.matchAll(/\bdkim=pass\b[^;]*?header\.(?:i|d)=@?([^\s;]+)/g)].some(
      (m) => m[1] === domain || m[1]!.endsWith(`.${domain}`),
    );
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
    authenticated: senderAuthenticated(headerList(header('authentication-results')), from),
    automatic:
      autoSubmitted !== 'no' ||
      ['bulk', 'junk', 'list', 'auto_reply'].includes(precedence) ||
      header('x-autoreply') !== undefined ||
      /^(mailer-daemon|postmaster)@/i.test(from),
  };
}
