import type { NewRequest, Request, Store } from '@loop-engineering/core';
import type { QuestionBus } from './bus.js';

/**
 * The one way to record a task the human sent, from the dashboard or another channel: it stores the
 * Request and emits `request.created`, which the router (M5) subscribes to. Writing
 * store.requests.create directly skips the event, and the router never hears about the task.
 */
export class RequestService {
  constructor(
    readonly store: Store,
    readonly bus: QuestionBus,
  ) {}

  create(input: NewRequest): Request {
    const request = this.store.requests.create(input);
    this.bus.emit({ type: 'request.created', request });
    return request;
  }
}
