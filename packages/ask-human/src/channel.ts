import type { HumanChannel, Question } from '@loop-engineering/core';
import type { QuestionBus, QuestionResolvedEvent, Unsubscribe } from './bus.js';

/**
 * A place the human sees and answers questions (Telegram in M4, the dashboard in M7). A channel
 * answers through QuestionService.answer(id, text, channel.name); the bus tells it everything else.
 */
export interface QuestionChannel {
  readonly name: HumanChannel;
  /** Show a new question to the human. */
  onQuestion(question: Question): void | Promise<void>;
  /**
   * The question was resolved somewhere else: another channel answered first, or the deadline
   * passed and the recommended option was used. Post `confirmation` (e.g. "answered: X (via
   * dashboard)") so the human knows the question is closed here too.
   */
  onResolvedElsewhere(event: QuestionResolvedEvent, confirmation: string): void | Promise<void>;
  /** Optional: this channel's own answer won, e.g. to mark the message as answered. */
  onResolvedHere?(event: QuestionResolvedEvent): void | Promise<void>;
}

/** Subscribes a channel to the bus. Returns a function that detaches it. */
export function attachChannel(bus: QuestionBus, channel: QuestionChannel): Unsubscribe {
  const offCreated = bus.on('question.created', (e) => channel.onQuestion(e.question));
  const offResolved = bus.on('question.resolved', (e) =>
    e.answeredVia === channel.name
      ? channel.onResolvedHere?.(e)
      : channel.onResolvedElsewhere(e, confirmationText(e)),
  );
  return () => {
    offCreated();
    offResolved();
  };
}

/** The "answered: X" line a channel that did not win posts. */
export function confirmationText(event: QuestionResolvedEvent): string {
  if (event.defaulted) {
    const minutes = Math.round(
      (Date.parse(event.question.deadline) - Date.parse(event.question.createdAt)) / 60_000,
    );
    return `no answer in ${minutes} min, went with the recommended option: ${event.answer}`;
  }
  return `answered: ${event.answer} (via ${event.answeredVia})`;
}
