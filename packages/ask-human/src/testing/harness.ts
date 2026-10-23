import { FakeClock, openStore, type Session, type Store } from '@loop-engineering/core';
import { QuestionBus, type BusEvent } from '../bus.js';
import { QuestionService } from '../service.js';
import { DeadlineSweeper } from '../sweeper.js';
import { FakeTimers } from '../timers.js';

export const MINUTE = 60_000;

export interface Harness {
  clock: FakeClock;
  timers: FakeTimers;
  store: Store;
  session: Session;
  bus: QuestionBus;
  service: QuestionService;
  sweeper: DeadlineSweeper;
  events: BusEvent[];
  close(): void;
}

/** In-memory store on a FakeClock with a bus, service and (not yet started) sweeper. */
export function harness(path?: string): Harness {
  const clock = new FakeClock('2026-10-18T09:00:00.000Z');
  const timers = new FakeTimers(clock);
  const store = openStore({ clock, ...(path ? { path } : {}) });
  const project = store.projects.getByName('p') ?? store.projects.create({ name: 'p' });
  const session =
    store.sessions.list({ projectId: project.id })[0] ??
    store.sessions.create({ projectId: project.id, title: 's', model: 'opus', branch: 'b' });
  const events: BusEvent[] = [];
  const bus = new QuestionBus({
    onListenerError: (error) => {
      throw error;
    },
  });
  bus.onAny((e) => {
    events.push(e);
  });
  const service = new QuestionService(store, bus);
  const sweeper = new DeadlineSweeper(service, { timers });
  return {
    clock,
    timers,
    store,
    session,
    bus,
    service,
    sweeper,
    events,
    close: () => {
      sweeper.stop();
      store.close();
    },
  };
}

export const newQuestion = (sessionId: number, extra: { timeoutMs?: number; text?: string } = {}) => ({
  sessionId,
  text: extra.text ?? 'Which database?',
  options: ['SQLite', 'Postgres'],
  recommendedOption: 'SQLite',
  ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
});
