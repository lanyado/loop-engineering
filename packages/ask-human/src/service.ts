import {
  ValidationError,
  type AnswerResult,
  type HumanChannel,
  type NewQuestion,
  type Question,
  type Store,
} from '@loop-engineering/core';
import type { QuestionBus } from './bus.js';
import { QUESTION_LIMITS as L } from './limits.js';

/**
 * How long after a question resolves an identical re-ask can still pick up its outcome, provided
 * that outcome never reached the agent (see AskResult.reused).
 */
export const REATTACH_WINDOW_MS = 15 * 60 * 1000;

export interface AskResult {
  question: Question;
  /**
   * True when an identical question from the same asker is reused instead of creating a duplicate:
   * one still pending, or one resolved within REATTACH_WINDOW_MS whose outcome was never delivered
   * to the agent (the human answered, or the sweep defaulted it, while the agent was disconnected).
   * That is how a caller re-attaches after a dropped connection without asking the human twice. An
   * outcome the agent already received is never reused: asking again creates a new question.
   */
  reused: boolean;
}

/**
 * The one place questions change state. Every state change goes through the store's conditional
 * updates, which let exactly one caller move a question out of "pending"; that caller, and only
 * it, wakes the waiters and emits question.resolved. So each question resolves exactly once even
 * when answers from two channels and the deadline sweep race.
 */
export class QuestionService {
  private readonly waiters = new Map<number, Set<(question: Question) => void>>();

  constructor(
    readonly store: Store,
    readonly bus: QuestionBus,
  ) {}

  ask(input: NewQuestion): AskResult {
    checkLength('question', input.text, L.question);
    if (input.options.length > L.options) throw new ValidationError(`at most ${L.options} options`);
    for (const option of input.options) checkLength('each option', option, L.option);
    checkLength('context', input.context ?? '', L.context);
    const existing = this.findDuplicate(input);
    if (existing) return { question: existing, reused: true };
    const question = this.store.questions.create(input);
    this.bus.emit({ type: 'question.created', question });
    return { question, reused: false };
  }

  /** Records a human answer; the first answer wins (see QuestionRepo.answer). */
  answer(id: number, answer: string, via: HumanChannel): AnswerResult {
    checkLength('answer', answer, L.answer);
    const result = this.store.questions.answer(id, answer, via);
    // A late answer that defaulted the question on the spot is this call's default to announce.
    if (result.accepted || result.defaultedNow) this.resolved(result.question);
    return result;
  }

  /** Defaults every question past its deadline and announces each. */
  expireDue(): Question[] {
    const expired = this.store.questions.expireDue();
    for (const question of expired) this.resolved(question);
    return expired;
  }

  /** Resolves with the question once it is answered or defaulted (at once if it already is). */
  // async, so an unknown id rejects rather than throws; the waiter is still registered synchronously.
  async wait(id: number, signal?: AbortSignal): Promise<Question> {
    const current = this.store.questions.require(id);
    if (current.status !== 'pending') {
      this.markDelivered(id);
      return current;
    }
    if (signal?.aborted) throw abortReason(signal);
    return new Promise<Question>((resolve, reject) => {
      const set = this.waiters.get(id) ?? new Set();
      this.waiters.set(id, set);
      const onAbort = () => {
        set.delete(wake);
        if (set.size === 0) this.waiters.delete(id);
        reject(abortReason(signal));
      };
      const wake = (question: Question) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(question);
      };
      set.add(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Callers currently blocked in wait(), across all questions. */
  get waitingCount(): number {
    let n = 0;
    for (const set of this.waiters.values()) n += set.size;
    return n;
  }

  // Waiters and channels hear first: the outcome is already committed, so a failure to record
  // delivery (bookkeeping for re-asks) must never keep anyone from being told.
  private resolved(question: Question): void {
    const set = this.waiters.get(question.id);
    this.waiters.delete(question.id);
    for (const wake of set ?? []) wake(question);
    this.bus.emit({
      type: 'question.resolved',
      question,
      answer: question.answer ?? question.recommendedOption,
      answeredVia: question.answeredVia ?? 'timeout',
      defaulted: question.status === 'defaulted',
    });
    if (set && set.size > 0) this.markDelivered(question.id);
  }

  /**
   * Best effort: if it fails, the worst case is that an identical re-ask within the reattach window
   * gets this outcome again instead of asking the human anew.
   */
  private markDelivered(id: number): void {
    try {
      this.store.questions.markDelivered(id);
    } catch (error) {
      console.error(`[ask-human] could not mark question ${id} delivered:`, error);
    }
  }

  /** Newest identical question from the same asker: pending, or resolved recently and undelivered. */
  private findDuplicate(input: NewQuestion): Question | undefined {
    const options = JSON.stringify(input.options);
    const since = new Date(this.store.clock.now().getTime() - REATTACH_WINDOW_MS).toISOString();
    return this.store.questions
      .list({ sessionId: input.sessionId })
      .find(
        (q) =>
          (q.status === 'pending' ||
            (q.deliveredAt === null && q.answeredAt !== null && q.answeredAt >= since)) &&
          q.subagentId === (input.subagentId ?? null) &&
          q.origin === (input.origin ?? 'system') &&
          q.text === input.text &&
          q.recommendedOption === input.recommendedOption &&
          JSON.stringify(q.options) === options,
      );
  }
}

function checkLength(what: string, text: string, max: number): void {
  if (text.length > max) throw new ValidationError(`${what} must be at most ${max} characters`);
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new DOMException('The wait was aborted', 'AbortError');
}
