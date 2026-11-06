import type { IncomingMail, MailCursor, Mailbox, OutgoingMail } from './mail.js';

/** A Mailbox in memory: tests deliver mail into it and read what was sent. */
export class FakeMailbox implements Mailbox {
  readonly sent: OutgoingMail[] = [];
  private inbox: IncomingMail[] = [];
  private nextUid = 1;
  /** Makes the next fetch or send fail, once. */
  failNext: 'fetch' | 'send' | null = null;
  /** The whole of each truncated mail, by uid; complete() fails on any other. */
  readonly whole = new Map<number, IncomingMail>();
  /** Makes this many complete() calls fail first. */
  failCompletes = 0;

  constructor(readonly address = 'loop@example.com') {}

  /** A mail arrives; the defaults are an authenticated, human-written one. */
  deliver(mail: Partial<IncomingMail> & Pick<IncomingMail, 'from' | 'text'>): IncomingMail {
    const uid = this.nextUid++;
    const full: IncomingMail = {
      uid,
      messageId: `<in-${uid}@example.com>`,
      inReplyTo: null,
      references: [],
      subject: 'A task',
      threadId: null,
      authenticated: true,
      automatic: false,
      attachments: [],
      truncated: false,
      ...mail,
    };
    this.inbox.push(full);
    return full;
  }

  /** A reply to one of our mails, threaded the way a mail client does it. */
  reply(to: OutgoingMail, from: string, text: string): IncomingMail {
    return this.deliver({
      from,
      text,
      subject: to.subject.startsWith('Re: ') ? to.subject : `Re: ${to.subject}`,
      inReplyTo: to.messageId,
      references: [...(to.references ?? []), to.messageId],
    });
  }

  fetch(cursor: MailCursor | undefined): Promise<{ mails: IncomingMail[]; cursor: MailCursor }> {
    if (this.failNext === 'fetch') {
      this.failNext = null;
      return Promise.reject(new Error('IMAP unreachable'));
    }
    const end = { uidValidity: 1, lastUid: this.nextUid - 1 };
    // Like Gmail's: the first read starts at the end of the inbox.
    if (!cursor) return Promise.resolve({ mails: [], cursor: end });
    return Promise.resolve({ mails: this.inbox.filter((m) => m.uid > cursor.lastUid), cursor: end });
  }

  complete(mail: IncomingMail): Promise<IncomingMail> {
    const whole = this.whole.get(mail.uid);
    if (this.failCompletes > 0) {
      this.failCompletes--;
      return Promise.reject(new Error('IMAP unreachable'));
    }
    return whole ? Promise.resolve(whole) : Promise.reject(new Error(`mail ${mail.uid} is gone`));
  }

  send(mail: OutgoingMail): Promise<void> {
    if (this.failNext === 'send') {
      this.failNext = null;
      return Promise.reject(new Error('SMTP unreachable'));
    }
    this.sent.push(mail);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
