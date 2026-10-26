import type { AnswerChannel, Question, Request, Session } from '@loop-engineering/core';

/** A new question is waiting for the human. Channels post it. */
export interface QuestionCreatedEvent {
  type: 'question.created';
  question: Question;
}

/**
 * A question got its final answer: a human answer through a channel, or the recommended option
 * when the deadline passed (answeredVia "timeout", defaulted true). Emitted exactly once per question.
 */
export interface QuestionResolvedEvent {
  type: 'question.resolved';
  question: Question;
  answer: string;
  answeredVia: AnswerChannel;
  defaulted: boolean;
}

export type QuestionEvent = QuestionCreatedEvent | QuestionResolvedEvent;

/**
 * The human sent a new task (the dashboard or another channel) and RequestService stored it. Chat
 * tasks have no project yet; a dashboard task may name one. The router (M5) subscribes with
 * `bus.on('request.created', ...)`, picks the project and session, and records them with
 * store.requests.assignProject/assignSession.
 */
export interface RequestCreatedEvent {
  type: 'request.created';
  request: Request;
}

/** A session's agent submitted its plan (submit_plan); the dashboard redraws its Planner node. */
export interface SessionPlannedEvent {
  type: 'session.planned';
  session: Session;
}

/** Everything the bus carries. */
export type BusEvent = QuestionEvent | RequestCreatedEvent | SessionPlannedEvent;
export type BusEventType = BusEvent['type'];
export type BusEventOf<T extends BusEventType> = Extract<BusEvent, { type: T }>;

export type Listener<E> = (event: E) => void | Promise<void>;
export type Unsubscribe = () => void;

export interface QuestionBusOptions {
  /** Called when a listener throws or rejects. Default: console.error. */
  onListenerError?: (error: unknown, event: BusEvent) => void;
}

/**
 * In-process typed event bus for questions and new requests. Listeners run in subscription order; a listener that
 * throws or rejects is reported and never stops the others or the emitter, so one broken channel
 * cannot keep the rest from hearing about a question.
 */
export class QuestionBus {
  private readonly listeners = new Set<{ type: BusEventType | '*'; fn: Listener<BusEvent> }>();
  private readonly onListenerError: (error: unknown, event: BusEvent) => void;

  constructor(options: QuestionBusOptions = {}) {
    this.onListenerError =
      options.onListenerError ??
      ((error, event) => console.error(`[ask-human] ${event.type} listener failed:`, error));
  }

  on<T extends BusEventType>(type: T, listener: Listener<BusEventOf<T>>): Unsubscribe {
    return this.add(type, listener as Listener<BusEvent>);
  }

  /** Every event, e.g. for the dashboard's SSE stream. */
  onAny(listener: Listener<BusEvent>): Unsubscribe {
    return this.add('*', listener);
  }

  emit(event: BusEvent): void {
    for (const entry of [...this.listeners]) {
      if (entry.type !== '*' && entry.type !== event.type) continue;
      try {
        const result = entry.fn(event);
        if (result instanceof Promise) result.catch((error: unknown) => this.onListenerError(error, event));
      } catch (error) {
        this.onListenerError(error, event);
      }
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  private add(type: BusEventType | '*', fn: Listener<BusEvent>): Unsubscribe {
    const entry = { type, fn };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }
}
