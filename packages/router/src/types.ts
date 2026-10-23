import type { ProjectKind, Session, SessionStatus } from '@loop-engineering/core';

/** Where a request goes inside its project: an open session, or a new one. */
export type RouteTarget = { kind: 'session'; sessionId: number } | { kind: 'new' };

/** A project and a target in it. */
export interface RouteChoice {
  projectId: number;
  target: RouteTarget;
}

export interface ClassifierSession {
  id: number;
  title: string;
  branch: string;
  status: SessionStatus;
}

export interface ClassifierProject {
  id: number;
  name: string;
  /** "folder": a plain folder of files edited in place (no repos, at most one open session). */
  kind: ProjectKind;
  /** A folder project's folder name (last path segment, e.g. "resume"); absent for git projects. */
  folder?: string;
  /** Repo names (none for a folder project). */
  repos: string[];
  /** First lines of the project's latest requests, newest first. */
  recentRequests: string[];
  /** Open (active or paused) sessions, newest first. */
  sessions: ClassifierSession[];
}

/** What the classifier sees: the request and the projects marked for direct input. */
export interface ClassifyInput {
  request: { id: number; text: string };
  projects: ClassifierProject[];
}

/**
 * The output the classifier is asked for. A classifier's answer is untrusted: the router checks it
 * with validateClassification() and treats anything malformed, or any unknown id, as unclear.
 */
export interface ClassifierOutput {
  projectId: number | null;
  target: RouteTarget;
  confidence: number;
  candidates: { projectId: number; target: RouteTarget; confidence?: number }[];
  reason?: string;
}

/** Picks the project and session for a request. The real one is CliClassifier; FakeClassifier in tests. */
export interface Classifier {
  /** Resolves with the raw (unvalidated) output. Should stop work when `signal` aborts. */
  classify(input: ClassifyInput, signal: AbortSignal): Promise<unknown>;
}

/**
 * Hands a request to an open session's agent. The request text is never typed into the agent's
 * terminal: it goes into a file inside the agent's working folder and the agent gets one fixed
 * sentence pointing at it. The server implements it with the runner's
 * `deliverFile(sessionId, name, content, sentence)`, which writes `<agent cwd>/.loop/<name>` (0600,
 * git-excluded) and sends `sentence`. Throws when the session cannot take it (paused, agent gone).
 */
export interface SessionMessenger {
  deliverFile(sessionId: number, name: string, content: string, sentence: string): Promise<void>;
}

/** What a folder project's open session can do with a new request (see SessionRunner.sessionState). */
export type FolderSessionState = 'live' | 'resumable' | 'paused-manual' | 'dead' | 'ended';

/** The runner's controls the router needs for folder projects, which run one session at a time. */
export interface FolderSessions {
  state(sessionId: number): Promise<FolderSessionState>;
  /** Resumes a paused session with `.loop/<name>` written first and `sentence` in its first prompt. */
  resumeWith(sessionId: number, name: string, content: string, sentence: string): Promise<void>;
  /** Ends the session. Never touches the folder's files. */
  end(sessionId: number): Promise<void>;
}

/**
 * Starts a new session for a request already assigned to `projectId`. The server implements it with
 * `runner.startSession(projectId, { requestId })`, which records the session on the request.
 */
export type StartSession = (projectId: number, request: { requestId: number }) => Promise<Session>;
