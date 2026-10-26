import { isoNow, type Clock } from '../clock.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { parseJson, where, type Db } from '../sql.js';
import {
  ANSWER_CHANNELS,
  QUESTION_TIMEOUT_MS,
  type AnswerChannel,
  type HumanChannel,
  type Question,
  type QuestionOrigin,
  type QuestionStatus,
} from '../types.js';
import type { SessionRepo } from './sessions.js';
import type { SubagentRepo } from './subagents.js';

export interface NewQuestion {
  sessionId: number;
  subagentId?: number | null;
  text: string;
  context?: string | null;
  options: string[];
  recommendedOption: string;
  /** Defaults to QUESTION_TIMEOUT_MS (15 minutes). */
  timeoutMs?: number;
  /** The request a routing question is about. */
  requestId?: number | null;
  /** Default "system": only agents (ask_human) and the router say otherwise. */
  origin?: QuestionOrigin;
}

export interface QuestionFilter {
  sessionId?: number;
  requestId?: number;
  status?: QuestionStatus | QuestionStatus[];
}

export interface AnswerResult {
  /** False when the question was already answered or defaulted (first answer wins). */
  accepted: boolean;
  /**
   * True when this call found the question past its deadline and still pending, and defaulted it
   * itself. Callers then own announcing the default, since no sweep will report it again. False
   * when the answer was accepted or the question had already been resolved earlier.
   */
  defaultedNow: boolean;
  question: Question;
}

interface QuestionRow {
  id: number;
  session_id: number;
  subagent_id: number | null;
  text: string;
  context: string | null;
  options: string;
  recommended_option: string;
  status: QuestionStatus;
  answer: string | null;
  answered_via: AnswerChannel | null;
  created_at: string;
  deadline: string;
  answered_at: string | null;
  delivered_at: string | null;
  request_id: number | null;
  origin: QuestionOrigin;
}

const toQuestion = (r: QuestionRow): Question => ({
  id: r.id,
  sessionId: r.session_id,
  subagentId: r.subagent_id,
  text: r.text,
  context: r.context,
  options: parseJson<string[]>(r.options),
  recommendedOption: r.recommended_option,
  status: r.status,
  answer: r.answer,
  answeredVia: r.answered_via,
  createdAt: r.created_at,
  deadline: r.deadline,
  answeredAt: r.answered_at,
  deliveredAt: r.delivered_at,
  requestId: r.request_id,
  origin: r.origin,
});

const HUMAN_CHANNELS: readonly string[] = ANSWER_CHANNELS.filter((c) => c !== 'timeout');

const EXPIRE = `
  UPDATE questions
  SET status = 'defaulted', answer = recommended_option, answered_via = 'timeout', answered_at = @now
  WHERE status = 'pending' AND deadline <= @at`;

export class QuestionRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly sessions: SessionRepo,
    private readonly subagents: SubagentRepo,
  ) {}

  create(input: NewQuestion): Question {
    this.validate(input);
    const now = this.clock.now();
    const deadline = new Date(now.getTime() + (input.timeoutMs ?? QUESTION_TIMEOUT_MS));
    const info = this.db
      .prepare(
        `INSERT INTO questions
           (session_id, subagent_id, text, context, options, recommended_option, status, created_at, deadline, request_id, origin)
         VALUES (@sessionId, @subagentId, @text, @context, @options, @recommended, 'pending', @createdAt, @deadline, @requestId, @origin)`,
      )
      .run({
        sessionId: input.sessionId,
        subagentId: input.subagentId ?? null,
        text: input.text,
        context: input.context?.trim() ? input.context : null,
        options: JSON.stringify(input.options),
        recommended: input.recommendedOption,
        createdAt: now.toISOString(),
        deadline: deadline.toISOString(),
        requestId: input.requestId ?? null,
        origin: input.origin ?? 'system',
      });
    return this.require(Number(info.lastInsertRowid));
  }

  get(id: number): Question | undefined {
    const row = this.db.prepare<[number], QuestionRow>('SELECT * FROM questions WHERE id = ?').get(id);
    return row && toQuestion(row);
  }

  require(id: number): Question {
    const question = this.get(id);
    if (!question) throw new NotFoundError('question', id);
    return question;
  }

  /** Newest first. */
  list(filter: QuestionFilter = {}): Question[] {
    const { clause, params } = where({
      session_id: filter.sessionId,
      request_id: filter.requestId,
      status: filter.status,
    });
    return this.db
      .prepare<[Record<string, unknown>], QuestionRow>(`SELECT * FROM questions ${clause} ORDER BY id DESC`)
      .all(params)
      .map(toQuestion);
  }

  /** Pending questions, soonest deadline first. */
  listPending(): Question[] {
    return this.db
      .prepare<[], QuestionRow>(`SELECT * FROM questions WHERE status = 'pending' ORDER BY deadline, id`)
      .all()
      .map(toQuestion);
  }

  /** Pending questions whose deadline is at or before `at` (default: now). */
  listDue(at: Date = this.clock.now()): Question[] {
    return this.db
      .prepare<[string], QuestionRow>(
        `SELECT * FROM questions WHERE status = 'pending' AND deadline <= ? ORDER BY deadline, id`,
      )
      .all(at.toISOString())
      .map(toQuestion);
  }

  /** Earliest deadline among pending questions, for scheduling the next timeout check. */
  nextDeadline(): string | null {
    const row = this.db
      .prepare<[], { deadline: string | null }>(
        `SELECT MIN(deadline) AS deadline FROM questions WHERE status = 'pending'`,
      )
      .get();
    return row?.deadline ?? null;
  }

  /**
   * Records a human answer. The answer may be one of the options or free text (e.g. a chat reply).
   * Only the first answer is kept, and only before the deadline: each update is conditional on the
   * question still being pending, so concurrent answers from two channels cannot both win. An answer
   * that arrives after the deadline is rejected and the question is defaulted on the spot, so the
   * returned question always shows the real outcome, whether or not expireDue() has run yet;
   * `defaultedNow` tells that case apart from one that was already defaulted.
   */
  answer(id: number, answer: string, via: HumanChannel): AnswerResult {
    if (answer.trim() === '') throw new ValidationError('answer must not be empty');
    if (!HUMAN_CHANNELS.includes(via)) {
      throw new ValidationError(`answers come via ${HUMAN_CHANNELS.join(' or ')}, not "${String(via)}"`);
    }
    return this.db.transaction((): AnswerResult => {
      const now = isoNow(this.clock);
      const info = this.db
        .prepare(
          `UPDATE questions SET status = 'answered', answer = @answer, answered_via = @via, answered_at = @now
           WHERE id = @id AND status = 'pending' AND deadline > @now`,
        )
        .run({ id, answer, via, now });
      const accepted = info.changes > 0;
      const defaultedNow =
        !accepted && this.db.prepare(`${EXPIRE} AND id = @id`).run({ id, at: now, now }).changes > 0;
      return { accepted, defaultedNow, question: this.require(id) };
    })();
  }

  /**
   * Records that the asking agent received the outcome of a resolved question. Only the first call
   * counts; returns false if the question is still pending or was already marked.
   */
  markDelivered(id: number): boolean {
    const info = this.db
      .prepare(
        `UPDATE questions SET delivered_at = @now
         WHERE id = @id AND status != 'pending' AND delivered_at IS NULL`,
      )
      .run({ id, now: isoNow(this.clock) });
    return info.changes > 0;
  }

  /** Resolves every due question with its recommended option and returns them. */
  expireDue(at: Date = this.clock.now()): Question[] {
    return this.db
      .prepare<[{ at: string; now: string }], QuestionRow>(`${EXPIRE} RETURNING *`)
      .all({ at: at.toISOString(), now: isoNow(this.clock) })
      .map(toQuestion)
      .sort((a, b) => a.deadline.localeCompare(b.deadline) || a.id - b.id);
  }

  private validate(input: NewQuestion): void {
    if (input.text.trim() === '') throw new ValidationError('question text must not be empty');
    if (input.options.length === 0) throw new ValidationError('a question needs at least one option');
    if (input.options.some((o) => o.trim() === '')) throw new ValidationError('options must not be empty');
    if (new Set(input.options).size !== input.options.length) {
      throw new ValidationError('question options must be unique');
    }
    if (!input.options.includes(input.recommendedOption)) {
      throw new ValidationError('recommendedOption must be one of the options');
    }
    if (input.timeoutMs !== undefined && !(Number.isFinite(input.timeoutMs) && input.timeoutMs > 0)) {
      throw new ValidationError('timeoutMs must be a positive finite number');
    }
    this.sessions.require(input.sessionId);
    if (input.subagentId != null) {
      const subagent = this.subagents.require(input.subagentId);
      if (subagent.sessionId !== input.sessionId) {
        throw new ValidationError(`subagent ${subagent.id} does not belong to session ${input.sessionId}`);
      }
    }
  }
}
