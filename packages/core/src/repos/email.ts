import { isoNow, type Clock } from '../clock.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { updateById, where, type Db } from '../sql.js';
import type { EmailMessage, EmailThread, EmailThreadState } from '../types.js';

export interface NewEmailThread {
  sender: string;
  subject: string;
  mailThreadId?: string | null;
}

export type EmailThreadPatch = Partial<Pick<EmailThread, 'state' | 'requestId' | 'mailThreadId'>>;

export interface NewEmailMessage {
  threadId: number;
  messageId: string;
  direction: 'in' | 'out';
  text: string;
  questionId?: number | null;
  prId?: number | null;
  requestId?: number | null;
}

/** How far an inbox was read (IMAP): the last UID seen, while the mailbox keeps its UIDVALIDITY. */
export interface EmailCursor {
  uidValidity: number;
  lastUid: number;
}

interface ThreadRow {
  id: number;
  sender: string;
  subject: string;
  state: EmailThreadState;
  request_id: number | null;
  mail_thread_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: number;
  thread_id: number;
  message_id: string;
  direction: 'in' | 'out';
  text: string;
  question_id: number | null;
  pr_id: number | null;
  request_id: number | null;
  created_at: string;
}

const toThread = (r: ThreadRow): EmailThread => ({
  id: r.id,
  sender: r.sender,
  subject: r.subject,
  state: r.state,
  requestId: r.request_id,
  mailThreadId: r.mail_thread_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toMessage = (r: MessageRow): EmailMessage => ({
  id: r.id,
  threadId: r.thread_id,
  messageId: r.message_id,
  direction: r.direction,
  text: r.text,
  questionId: r.question_id,
  prId: r.pr_id,
  requestId: r.request_id,
  createdAt: r.created_at,
});

/** The email channel's conversations, the mails in them, and how far the inbox was read. */
export class EmailRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  createThread(input: NewEmailThread): EmailThread {
    if (!input.sender.includes('@')) throw new ValidationError('an email thread needs a sender address');
    const now = isoNow(this.clock);
    const info = this.db
      .prepare(
        `INSERT INTO email_threads (sender, subject, mail_thread_id, created_at, updated_at)
         VALUES (@sender, @subject, @mailThreadId, @now, @now)`,
      )
      .run({
        sender: input.sender.toLowerCase(),
        subject: input.subject,
        mailThreadId: input.mailThreadId ?? null,
        now,
      });
    return this.requireThread(Number(info.lastInsertRowid));
  }

  thread(id: number): EmailThread | undefined {
    const row = this.db.prepare<[number], ThreadRow>('SELECT * FROM email_threads WHERE id = ?').get(id);
    return row && toThread(row);
  }

  requireThread(id: number): EmailThread {
    const thread = this.thread(id);
    if (!thread) throw new NotFoundError('email thread', id);
    return thread;
  }

  /** Oldest first. */
  threads(filter: { state?: EmailThreadState; requestId?: number | number[] } = {}): EmailThread[] {
    const { clause, params } = where({ state: filter.state, request_id: filter.requestId });
    return this.db
      .prepare<[Record<string, unknown>], ThreadRow>(`SELECT * FROM email_threads ${clause} ORDER BY id`)
      .all(params)
      .map(toThread);
  }

  threadByMailThreadId(mailThreadId: string): EmailThread | undefined {
    const row = this.db
      .prepare<[string], ThreadRow>('SELECT * FROM email_threads WHERE mail_thread_id = ? ORDER BY id DESC')
      .get(mailThreadId);
    return row && toThread(row);
  }

  updateThread(id: number, patch: EmailThreadPatch): EmailThread {
    updateById(this.db, 'email_threads', 'email thread', id, {
      state: patch.state,
      request_id: patch.requestId,
      mail_thread_id: patch.mailThreadId,
      updated_at: isoNow(this.clock),
    });
    return this.requireThread(id);
  }

  addMessage(input: NewEmailMessage): EmailMessage {
    this.requireThread(input.threadId);
    const info = this.db
      .prepare(
        `INSERT INTO email_messages (thread_id, message_id, direction, text, question_id, pr_id, request_id, created_at)
         VALUES (@threadId, @messageId, @direction, @text, @questionId, @prId, @requestId, @createdAt)`,
      )
      .run({
        threadId: input.threadId,
        messageId: input.messageId,
        direction: input.direction,
        text: input.text,
        questionId: input.questionId ?? null,
        prId: input.prId ?? null,
        requestId: input.requestId ?? null,
        createdAt: isoNow(this.clock),
      });
    updateById(this.db, 'email_threads', 'email thread', input.threadId, { updated_at: isoNow(this.clock) });
    return toMessage(
      this.db
        .prepare<[number], MessageRow>('SELECT * FROM email_messages WHERE id = ?')
        .get(Number(info.lastInsertRowid))!,
    );
  }

  /** A thread's mails, oldest first. */
  messages(threadId: number): EmailMessage[] {
    return this.db
      .prepare<[number], MessageRow>('SELECT * FROM email_messages WHERE thread_id = ? ORDER BY id')
      .all(threadId)
      .map(toMessage);
  }

  messageByMessageId(messageId: string): EmailMessage | undefined {
    const row = this.db
      .prepare<[string], MessageRow>('SELECT * FROM email_messages WHERE message_id = ?')
      .get(messageId);
    return row && toMessage(row);
  }

  /** Links a mail to the request it started. */
  setMessageRequest(id: number, requestId: number): void {
    updateById(this.db, 'email_messages', 'email message', id, { request_id: requestId });
  }

  /** The mail that asked this question, if it was emailed. */
  messageForQuestion(questionId: number): EmailMessage | undefined {
    const row = this.db
      .prepare<[number], MessageRow>('SELECT * FROM email_messages WHERE question_id = ? ORDER BY id LIMIT 1')
      .get(questionId);
    return row && toMessage(row);
  }

  cursor(address: string): EmailCursor | undefined {
    const row = this.db
      .prepare<[string], { uid_validity: number; last_uid: number }>(
        'SELECT uid_validity, last_uid FROM email_cursors WHERE address = ?',
      )
      .get(address.toLowerCase());
    return row && { uidValidity: row.uid_validity, lastUid: row.last_uid };
  }

  setCursor(address: string, cursor: EmailCursor): void {
    this.db
      .prepare(
        `INSERT INTO email_cursors (address, uid_validity, last_uid) VALUES (@address, @uidValidity, @lastUid)
         ON CONFLICT (address) DO UPDATE SET uid_validity = @uidValidity, last_uid = @lastUid`,
      )
      .run({ address: address.toLowerCase(), ...cursor });
  }
}
