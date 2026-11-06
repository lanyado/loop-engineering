import { ImapFlow } from 'imapflow';
import { createTransport, type Transporter } from 'nodemailer';
import { parseMail, type IncomingMail, type MailCursor, type Mailbox, type OutgoingMail } from './mail.js';

/** Only this much of a mail is read at first, from anyone: enough for its headers and text. */
const MAX_SOURCE_BYTES = 2_000_000;
/** The most complete() reads: Gmail takes 50 MB at most, which base64 makes about 67 MB. */
const MAX_WHOLE_BYTES = 70_000_000;

/**
 * A Gmail account over IMAP (reading INBOX) and SMTP (sending), signed in with an app password.
 * Each fetch opens a short IMAP connection: a poll every minute needs no long-lived socket, and a
 * dropped connection never wedges the channel.
 */
export class GmailMailbox implements Mailbox {
  private readonly smtp: Transporter;

  constructor(
    readonly address: string,
    private readonly password: string,
    private readonly log: (message: string) => void = console.log,
  ) {
    this.smtp = createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: address, pass: password },
    });
  }

  async fetch(cursor: MailCursor | undefined): Promise<{ mails: IncomingMail[]; cursor: MailCursor }> {
    const imap = await this.connect();
    try {
      const lock = await imap.getMailboxLock('INBOX', { readOnly: true });
      try {
        const box = imap.mailbox;
        if (!box) throw new Error('INBOX did not open');
        const uidValidity = Number(box.uidValidity);
        // First run, or the mailbox was rebuilt (its UIDs mean something else now): start at the end.
        if (!cursor || cursor.uidValidity !== uidValidity)
          return { mails: [], cursor: { uidValidity, lastUid: box.uidNext - 1 } };
        if (box.uidNext - 1 <= cursor.lastUid) return { mails: [], cursor };
        const mails: IncomingMail[] = [];
        let lastUid = cursor.lastUid;
        for await (const msg of imap.fetch(
          `${cursor.lastUid + 1}:*`,
          { uid: true, source: { maxLength: MAX_SOURCE_BYTES }, threadId: true, size: true },
          { uid: true },
        )) {
          // "n:*" also returns the newest message when nothing is newer than n.
          if (msg.uid <= cursor.lastUid) continue;
          lastUid = Math.max(lastUid, msg.uid);
          if (!msg.source) continue;
          try {
            mails.push(
              await parseMail(msg.source, msg.uid, msg.threadId ?? null, (msg.size ?? 0) > MAX_SOURCE_BYTES),
            );
          } catch (err) {
            this.log(`[email] skipped message uid ${msg.uid}: ${(err as Error).message}`);
          }
        }
        return { mails: mails.sort((a, b) => a.uid - b.uid), cursor: { uidValidity, lastUid } };
      } finally {
        lock.release();
      }
    } finally {
      await imap.logout().catch(() => undefined);
    }
  }

  async complete(mail: IncomingMail): Promise<IncomingMail> {
    const imap = await this.connect();
    try {
      const lock = await imap.getMailboxLock('INBOX', { readOnly: true });
      try {
        const sized = await imap.fetchOne(String(mail.uid), { size: true }, { uid: true });
        if (!sized) throw new Error(`mail uid ${mail.uid} is no longer in the inbox`);
        if ((sized.size ?? 0) > MAX_WHOLE_BYTES)
          throw new Error(
            `mail uid ${mail.uid} is ${sized.size} bytes, over the limit of ${MAX_WHOLE_BYTES}`,
          );
        const whole = await imap.fetchOne(String(mail.uid), { source: true }, { uid: true });
        if (!whole || !whole.source) throw new Error(`mail uid ${mail.uid} could not be read`);
        return await parseMail(whole.source, mail.uid, mail.threadId);
      } finally {
        lock.release();
      }
    } finally {
      await imap.logout().catch(() => undefined);
    }
  }

  private async connect(): Promise<ImapFlow> {
    const imap = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: { user: this.address, pass: this.password },
      logger: false,
    });
    // imapflow reports a dropped socket or a timeout as an 'error' event; unheard, it would end the
    // process. The command waiting on the connection fails too, and that failure is what counts.
    imap.on('error', (err: Error) => this.log(`[email] IMAP connection: ${err.message}`));
    await imap.connect().catch((err: Error & { authenticationFailed?: boolean }) => {
      throw err.authenticationFailed
        ? new Error(
            `Gmail refused the sign-in for ${this.address}: check EMAIL_APP_PASSWORD (an app password, not the account's)`,
          )
        : err;
    });
    return imap;
  }

  async send(mail: OutgoingMail): Promise<void> {
    await this.smtp.sendMail({
      from: this.address,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      messageId: mail.messageId,
      ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
      ...(mail.references?.length ? { references: mail.references } : {}),
      headers: { 'Auto-Submitted': 'auto-replied' },
    });
  }

  close(): Promise<void> {
    this.smtp.close();
    return Promise.resolve();
  }
}
