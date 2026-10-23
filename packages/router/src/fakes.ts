import type { Session, Store } from '@loop-engineering/core';
import type {
  Classifier,
  ClassifyInput,
  FolderSessions,
  FolderSessionState,
  SessionMessenger,
  StartSession,
} from './types.js';

/** A canned answer, or a function computing one from the input. */
type Answer = unknown;
type AnswerFn = (input: ClassifyInput, signal: AbortSignal) => unknown;

/** Classifier for tests: returns (or computes) a canned answer and records every input. */
export class FakeClassifier implements Classifier {
  readonly inputs: ClassifyInput[] = [];

  constructor(public answer: Answer = null) {}

  classify(input: ClassifyInput, signal: AbortSignal): Promise<unknown> {
    this.inputs.push(input);
    const answer = this.answer;
    // Like an async function: a throwing answer function becomes a rejection.
    return new Promise((resolve) =>
      resolve(typeof answer === 'function' ? (answer as AnswerFn)(input, signal) : answer),
    );
  }
}

/** Messenger for tests: keeps each delivered file and sentence in memory; `fail` makes it throw. */
export class FakeMessenger implements SessionMessenger {
  readonly delivered: { sessionId: number; name: string; content: string; sentence: string }[] = [];
  fail: Error | null = null;

  deliverFile(sessionId: number, name: string, content: string, sentence: string): Promise<void> {
    if (this.fail) return Promise.reject(this.fail);
    this.delivered.push({ sessionId, name, content, sentence });
    return Promise.resolve();
  }
}

/**
 * Folder-session controls for tests. `states` sets what state() answers per session (default: from
 * the store row, "live" when active); end() and resumeWith() update the store like the runner.
 */
export class FakeFolderSessions implements FolderSessions {
  readonly states = new Map<number, FolderSessionState>();
  readonly calls: string[] = [];
  readonly resumed: { sessionId: number; name: string; content: string; sentence: string }[] = [];
  failResume: Error | null = null;

  constructor(private readonly store: Store) {}

  state(sessionId: number): Promise<FolderSessionState> {
    this.calls.push(`state ${sessionId}`);
    const s = this.store.sessions.require(sessionId);
    if (s.status === 'ended') return Promise.resolve('ended');
    const preset = this.states.get(sessionId);
    if (preset) return Promise.resolve(preset);
    if (s.status === 'active') return Promise.resolve('live');
    if (s.pauseReason === 'agent_exited') return Promise.resolve('dead');
    return Promise.resolve(s.pauseReason === 'manual' ? 'paused-manual' : 'resumable');
  }

  resumeWith(sessionId: number, name: string, content: string, sentence: string): Promise<void> {
    this.calls.push(`resume ${sessionId}`);
    if (this.failResume) return Promise.reject(this.failResume);
    this.store.sessions.update(sessionId, { status: 'active' });
    this.states.delete(sessionId);
    this.resumed.push({ sessionId, name, content, sentence });
    return Promise.resolve();
  }

  end(sessionId: number): Promise<void> {
    this.calls.push(`end ${sessionId}`);
    this.store.sessions.end(sessionId);
    return Promise.resolve();
  }
}

/** startSession for tests: creates the session row and records it on the request, like the runner. */
export function fakeStartSession(store: Store): StartSession & { started: Session[] } {
  const started: Session[] = [];
  const start = (projectId: number, { requestId }: { requestId: number }) => {
    const request = store.requests.require(requestId);
    const title = request.text.trim().split('\n')[0]?.slice(0, 80) || 'session';
    const session = store.sessions.create({ projectId, title, model: 'opus', branch: `loop/r${requestId}` });
    store.requests.assignSession(requestId, session.id);
    started.push(session);
    return Promise.resolve(session);
  };
  return Object.assign(start, { started });
}
