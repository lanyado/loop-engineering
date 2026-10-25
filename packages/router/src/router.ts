import type {
  QuestionBus,
  QuestionService,
  TimerHandle,
  Timers,
  Unsubscribe,
} from '@loop-engineering/ask-human';
import { basename } from 'node:path';
import {
  errorMessage,
  FolderBusyError,
  REQUEST_PART_MARKER,
  Semaphore,
  type Project,
  type Question,
  type Request,
  type Session,
  type Store,
} from '@loop-engineering/core';
import type { Plan, RequestPart } from './prompt.js';
import { validateClassification, type Verdict } from './classification.js';
import { buildOptions, CANCEL_OPTION, decodeAnswer, type Decoded } from './options.js';
import { ensureRouterSession, findRouterSession, routerProjectId } from './system.js';
import type {
  Classifier,
  ClassifyInput,
  FolderSessions,
  RouteChoice,
  SessionMessenger,
  StartSession,
} from './types.js';

export interface RouterConfig {
  /** Classifier confidence at or above which the router routes without asking. Default 0.75. */
  confidenceThreshold: number;
  /** A classification that takes longer counts as unclear. Default 60 s. */
  classifierTimeoutMs: number;
  /** Routing questions per request: one, plus one re-ask if the answer matched nothing. Default 2. */
  maxQuestionsPerRequest: number;
  /** Latest requests per project shown to the classifier. Default 5. */
  recentRequests: number;
  /**
   * Classifications and deliveries (session starts) running at once, so a backlog does not start
   * many sessions (git worktree adds, agents) together. Waiting for a human holds no slot. Default 2.
   */
  concurrency: number;
  /**
   * How often requests without a project are retried, e.g. once a project is marked for direct
   * input. 0 turns it off. Default 5 minutes.
   */
  rescanIntervalMs: number;
  /**
   * How long the human has to answer a clarifying question from the planner (Plan stage); the
   * planner asks only when the request is genuinely ambiguous. 0 disables the questions (the planner
   * then decides alone). Default 5 minutes.
   */
  planTimeoutMs: number;
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  confidenceThreshold: 0.75,
  classifierTimeoutMs: 60_000,
  maxQuestionsPerRequest: 2,
  recentRequests: 5,
  concurrency: 2,
  rescanIntervalMs: 5 * 60_000,
  planTimeoutMs: 5 * 60_000,
};

export interface RouterDeps {
  store: Store;
  bus: QuestionBus;
  questions: QuestionService;
  classifier: Classifier;
  startSession: StartSession;
  messenger: SessionMessenger;
  /**
   * Inspects, resumes and ends a folder project's open session (the server passes the runner's).
   * Without it, a busy folder can only take a request through `messenger` into a live session.
   */
  folders?: FolderSessions;
  /**
   * Plans a request for a new git-project session: independent parts (each then gets its own
   * session, branch and PR, running side by side) are split without asking anyone; a question is
   * for the human only when the request is genuinely ambiguous. Without it, or with fewer than two
   * parts, the request stays one session.
   */
  splitter?: { plan(text: string, signal: AbortSignal): Promise<Plan> };
  timers: Timers;
  log?: (message: string) => void;
}

/** How a routing decision was made, for the history entry. */
type How =
  | { by: 'preset' }
  | { by: 'classifier'; confidence: number; reason: string | null }
  | { by: 'human'; question: Question };

export type RouteOutcome =
  | { status: 'routed'; projectId: number; sessionId: number; newSession: boolean }
  /** Already routed, or the request no longer exists. */
  | { status: 'skipped'; reason: string }
  | { status: 'cancelled' }
  /** Split into parts, each routed as its own request (`parts`: their ids). */
  | { status: 'split'; projectId: number; parts: number[] }
  /** Not routed this time (nothing eligible, a failure, or the router stopped); a later run retries. */
  | { status: 'unrouted'; reason: string };

/** Work that waits for the human: runs outside every slot, and takes a slot again for its own work. */
type Deferred = { status: 'deferred'; next: () => Promise<RouteOutcome> };
type Step = RouteOutcome | Deferred;

/** Marker embedded in Plan-stage question text to distinguish it from routing questions. */
const PLAN_QUESTION_MARKER = '[plan-stage]';
/** The only canned answer to a Plan-stage question (also its timeout default); anything else is free text. */
const PLAN_DECIDE_ALONE = 'No preference, use your best judgment';

/** A part's request text: its own task first, the whole request after it for context only. */
export function partText(part: RequestPart, index: number, count: number, whole: string): string {
  return [
    part.task +
      REQUEST_PART_MARKER +
      `${index + 1} of ${count} of a larger request. Other sessions do the other parts at the same ` +
      'time, each on its own branch: do only this part, and do not change files the other parts need.',
    'The whole request, for context only:',
    '',
    whole,
  ].join('\n');
}

/** Options of the question about a folder session the human paused. */
export const RESUME_AND_DELIVER = 'Resume it and deliver';
export const END_AND_START_FRESH = 'End it and start fresh';

const REQUEST_EXCERPT = 2000;
/** Rounds a folder request gets (deliver, resume, end-then-start, start races) before the human is asked. */
const FOLDER_ATTEMPTS = 4;
const NO_MARKED = 'no project is marked for direct input';

/** Where the runner's deliverFile puts a file, relative to the agent's working folder. */
export const DELIVERY_DIR = '.loop';

/** The one sentence an open session receives for a routed request; the text stays in the file. */
export function deliverySentence(name: string): string {
  return `A new request from the human was routed to this session. Read the file ${DELIVERY_DIR}/${name} and handle that request.`;
}

/**
 * Routes each new request (Telegram, dashboard, PR loop) to a project and session: a request that
 * names its project gets a new session there; otherwise the classifier picks among the projects
 * marked for direct input, and the human is asked when it is unsure.
 *
 * Routing state lives in the store, so it survives restarts: a request is routed once it has a
 * session; a routing question is linked to its request (questions.request_id). Within one process, a
 * per-request lock keeps concurrent triggers (the event, the start-up scan, the rescan) from routing
 * the same request twice.
 */
export class Router {
  private readonly config: RouterConfig;
  private readonly log: (message: string) => void;
  private readonly inFlight = new Map<number, Promise<RouteOutcome>>();
  private readonly slots: Semaphore;
  private abort = new AbortController();
  private unsubscribe: Unsubscribe | null = null;
  private rescanTimer: TimerHandle | null = null;
  /** Requests that already got a busy-folder question in this process (asked at most once each). */
  private readonly folderEscalated = new Set<number>();
  private readonly manualPauseAsked = new Set<number>();

  constructor(
    private readonly deps: RouterDeps,
    config: Partial<RouterConfig> = {},
  ) {
    this.config = { ...DEFAULT_ROUTER_CONFIG, ...config };
    this.slots = new Semaphore(Math.max(1, this.config.concurrency));
    this.log = deps.log ?? ((m) => console.log(m));
  }

  /** Subscribes to request.created, schedules the rescan and routes what is pending. Returns the scan. */
  start(): Promise<RouteOutcome[]> {
    if (!this.unsubscribe) {
      this.abort = new AbortController();
      this.unsubscribe = this.deps.bus.on('request.created', ({ request }) => {
        void this.route(request.id);
      });
      this.scheduleRescan();
    }
    return this.routePending();
  }

  /** Stops listening; in-flight classifications and question waits end (their requests stay unrouted). */
  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.rescanTimer) this.deps.timers.clearTimeout(this.rescanTimer);
    this.rescanTimer = null;
    this.abort.abort(new Error('router stopped'));
    await this.idle();
  }

  /** Resolves when no request is being routed (tests). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight.values()]);
  }

  /**
   * Routes every request without a session (`onlyUnrouted`: only those without a project too, plus
   * those queued for a busy folder project), except ones already settled: cancelled by the human, or
   * given up after unmatched answers.
   */
  routePending(onlyUnrouted = false): Promise<RouteOutcome[]> {
    const { store } = this.deps;
    const folderProjects = new Set(
      store.projects
        .list()
        .filter((p) => p.kind === 'folder')
        .map((p) => p.id),
    );
    const pending = store.requests
      .list()
      .filter(
        (r) =>
          r.sessionId === null &&
          store.requests.parts(r.id).length === 0 &&
          (!onlyUnrouted || r.projectId === null || folderProjects.has(r.projectId)) &&
          !this.isSettled(r),
      );
    return Promise.all(pending.map((r) => this.route(r.id, true))).then((outcomes) => {
      const waiting = outcomes.filter((o) => o.status === 'unrouted' && o.reason === NO_MARKED).length;
      if (waiting > 0) this.log(`[router] ${waiting} request(s) not routed: ${NO_MARKED}`);
      return outcomes;
    });
  }

  /**
   * Routes one request. Never throws; concurrent calls for the same request share one run. `inScan`:
   * the caller (a scan) logs the "no marked project" case once for all its requests.
   */
  route(requestId: number, inScan = false): Promise<RouteOutcome> {
    const running = this.inFlight.get(requestId);
    if (running) return running;
    const run = this.routeNow(requestId, inScan)
      .catch((error: unknown): RouteOutcome => {
        this.log(`[router] request #${requestId}: ${errorMessage(error)}`);
        return { status: 'unrouted', reason: errorMessage(error) };
      })
      .finally(() => this.inFlight.delete(requestId));
    this.inFlight.set(requestId, run);
    return run;
  }

  private scheduleRescan(): void {
    if (this.config.rescanIntervalMs <= 0) return;
    this.rescanTimer = this.deps.timers.setTimeout(() => {
      if (!this.unsubscribe) return;
      void this.routePending(true);
      this.scheduleRescan();
    }, this.config.rescanIntervalMs);
  }

  private async routeNow(requestId: number, inScan: boolean): Promise<RouteOutcome> {
    const { store } = this.deps;
    const request = store.requests.get(requestId);
    if (!request) return { status: 'skipped', reason: 'no such request' };
    if (request.sessionId !== null) return { status: 'skipped', reason: 'already routed' };
    if (store.requests.parts(requestId).length > 0) return { status: 'skipped', reason: 'split into parts' };
    // A project given up front (dashboard form, a PR-loop fix request, or a project the router already
    // picked before a failed start) skips selection: the request gets a new session there, whether
    // or not the project is marked for direct input (naming it is an explicit choice).
    if (request.projectId !== null) {
      if (request.projectId === routerProjectId(store)) {
        this.log(`[router] request #${requestId} not routed: it names the reserved router project`);
        return { status: 'unrouted', reason: 'the request names the reserved router project' };
      }
      // A busy-folder question still open (e.g. from before a restart): wait for its answer.
      // Filter out Plan questions, they are handled separately.
      const asked = this.routingQuestions(requestId).filter((q) => !this.isPlanQuestion(q));
      if (this.isSettled(request)) return { status: 'cancelled' };
      if (asked[0]?.status === 'pending') {
        return this.afterQuestion(request, await this.settled(asked[0]), asked.length);
      }
      // Addressed to one session (dashboard "+" on it): deliver there. If it has ended since,
      // deliver() gives the request a new session in the same project, so it is never dropped.
      const target: RouteChoice['target'] =
        request.targetSessionId === null
          ? { kind: 'new' }
          : { kind: 'session', sessionId: request.targetSessionId };
      return this.apply(request, { projectId: request.projectId, target }, { by: 'preset' });
    }

    // Filter out Plan questions from routing questions
    const asked = this.routingQuestions(requestId).filter((q) => !this.isPlanQuestion(q));
    const latest = asked[0];
    if (latest && this.isSettled(request)) {
      // Decided earlier (and recorded then): nothing to do, nothing to record again.
      return this.decode(latest).kind === 'cancel'
        ? { status: 'cancelled' }
        : { status: 'unrouted', reason: 'no routing questions left; answers matched no option' };
    }
    if (latest) return this.onAnswered(request, await this.settled(latest), asked.length);

    const eligible = this.eligible();
    if (eligible.length === 0) {
      if (!inScan) this.log(`[router] request #${requestId} not routed: ${NO_MARKED}`);
      return { status: 'unrouted', reason: NO_MARKED };
    }
    const input = this.classifyInput(request, eligible);
    const verdict = await this.withSlot(() => this.classify(input));
    if (this.abort.signal.aborted) return { status: 'unrouted', reason: 'router stopped' };
    if (verdict.kind === 'confident') {
      return this.apply(request, verdict.choice, {
        by: 'classifier',
        confidence: verdict.confidence,
        reason: verdict.reason,
      });
    }
    const question = this.ask(request, verdict.candidates, verdict.why, 0, eligible);
    return this.onAnswered(request, await this.settled(question), 1);
  }

  private async onAnswered(
    request: Request,
    question: Question | null,
    asked: number,
  ): Promise<RouteOutcome> {
    if (!question) return { status: 'unrouted', reason: 'router stopped' };
    const answer = question.answer ?? question.recommendedOption;
    const decoded = this.decode(question);
    if (decoded.kind === 'cancel') {
      this.recordUnrouted(request, `Cancelled request #${request.id}: ${answeredBy(question)}.`);
      return { status: 'cancelled' };
    }
    if (decoded.kind === 'route') return this.apply(request, decoded.choice, { by: 'human', question });
    if (asked >= this.config.maxQuestionsPerRequest) {
      this.log(`[router] request #${request.id} not routed: answer "${answer}" matched no option`);
      this.recordUnrouted(
        request,
        `Left request #${request.id} unrouted: answer "${answer}" matched no option.`,
      );
      return { status: 'unrouted', reason: `answer "${answer}" matched no option` };
    }
    const why = `"${answer.slice(0, 200)}" did not match an option`;
    const next = this.ask(request, [], why, asked, this.eligible());
    return this.onAnswered(request, await this.settled(next), asked + 1);
  }

  private decode(question: Question): Decoded {
    const answer = question.answer ?? question.recommendedOption;
    return decodeAnswer(answer, question.options, this.projects(), this.deps.store);
  }

  /** Cancelled, or given up after the last allowed question: the scans leave it alone. */
  private isSettled(request: Request): boolean {
    // Filter out Plan questions so they don't inflate maxQuestionsPerRequest accounting
    // and don't get decoded (they decode as 'unknown').
    const asked = this.routingQuestions(request.id).filter((q) => !this.isPlanQuestion(q));
    const latest = asked[0];
    if (!latest || latest.status === 'pending') return false;
    const decoded = this.decode(latest);
    // A request with a project is only ever asked about when its folder could not take it.
    if (request.projectId !== null) return decoded.kind === 'cancel';
    return (
      decoded.kind === 'cancel' ||
      (decoded.kind === 'unknown' && asked.length >= this.config.maxQuestionsPerRequest)
    );
  }

  /** The question once answered or defaulted; null if the router stopped first. */
  private async settled(question: Question): Promise<Question | null> {
    if (question.status !== 'pending') return question;
    try {
      return await this.deps.questions.wait(question.id, this.abort.signal);
    } catch (error) {
      if (this.abort.signal.aborted) return null;
      throw error;
    }
  }

  private ask(
    request: Request,
    candidates: RouteChoice[],
    why: string,
    askedBefore: number,
    eligible: { project: Project; sessions: Session[] }[],
  ): Question {
    const { store, questions } = this.deps;
    const { options, recommended } = buildOptions(candidates, eligible, store);
    const excerpt =
      request.text.length > REQUEST_EXCERPT ? `${request.text.slice(0, REQUEST_EXCERPT)}…` : request.text;
    const again = askedBefore > 0 ? ' (asked again)' : '';
    const { question } = questions.ask({
      sessionId: ensureRouterSession(store).id,
      requestId: request.id,
      origin: 'router',
      text: `Route request #${request.id}${again}: which project and session should it go to?\n\n${excerpt}`,
      context: `From ${request.source}. Not routed automatically: ${why}.`,
      options,
      recommendedOption: recommended,
    });
    return question;
  }

  /** Routing questions asked for a request, newest first. */
  private routingQuestions(requestId: number): Question[] {
    const { store } = this.deps;
    const session = findRouterSession(store);
    if (!session) return [];
    return store.questions.list({ sessionId: session.id, requestId });
  }

  /**
   * Asks the human the planner's question about an ambiguous request (Plan stage). Returns a
   * deferred step that waits for the answer, then plans again with it.
   */
  private askPlanQuestion(request: Request, project: Project, how: How, note: string, text: string): Step {
    const { store, questions } = this.deps;
    const excerpt =
      request.text.length > REQUEST_EXCERPT ? `${request.text.slice(0, REQUEST_EXCERPT)}…` : request.text;

    const { question } = questions.ask({
      sessionId: ensureRouterSession(store).id,
      requestId: request.id,
      origin: 'router',
      text: `${PLAN_QUESTION_MARKER} Request #${request.id}: ${text}\n\n${excerpt}`,
      context: `From ${request.source}. The planner needs this before it can plan the request.`,
      options: [PLAN_DECIDE_ALONE],
      recommendedOption: PLAN_DECIDE_ALONE,
      timeoutMs: this.config.planTimeoutMs,
    });

    return {
      status: 'deferred',
      next: async () => this.onPlanAnswer(request, project, how, note, await this.settled(question)),
    };
  }

  /**
   * Checks if a question is a Plan-stage question (as opposed to a routing question).
   */
  private isPlanQuestion(question: Question): boolean {
    return question.text.startsWith(PLAN_QUESTION_MARKER);
  }

  private async classify(input: ClassifyInput): Promise<Verdict> {
    const { timers, classifier } = this.deps;
    const controller = new AbortController();
    const onStop = () => controller.abort(this.abort.signal.reason);
    this.abort.signal.addEventListener('abort', onStop, { once: true });
    let timer: TimerHandle | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = timers.setTimeout(() => {
        controller.abort(new Error('classifier timed out'));
        resolve('timeout');
      }, this.config.classifierTimeoutMs);
    });
    try {
      // Raced, so a classifier that ignores its signal still cannot hold the request.
      const raw = await Promise.race([classifier.classify(input, controller.signal), timedOut]);
      if (raw === 'timeout') {
        return { kind: 'unclear', candidates: [], why: 'the classifier timed out' };
      }
      return validateClassification(raw, input, this.config.confidenceThreshold);
    } catch (error) {
      this.log(`[router] classifier failed for request #${input.request.id}: ${errorMessage(error)}`);
      return { kind: 'unclear', candidates: [], why: 'the classifier failed' };
    } finally {
      if (timer !== undefined) timers.clearTimeout(timer);
      this.abort.signal.removeEventListener('abort', onStop);
    }
  }

  private apply(request: Request, choice: RouteChoice, how: How): Promise<RouteOutcome> {
    return this.inSlot(() => this.deliver(request, choice, how));
  }

  /** Runs `work` once a slot is free; slots are handed out in arrival order. */
  private async withSlot<T>(work: () => Promise<T>): Promise<T> {
    const release = await this.slots.acquire();
    try {
      return await work();
    } finally {
      release();
    }
  }

  /**
   * Runs `work` in a slot. If it has to wait for the human, the slot is released first: a waiting
   * question never holds a slot (two of them would stall all routing), and the follow-up takes a
   * fresh slot, so no run ever holds one slot while asking for another.
   */
  private async inSlot(work: () => Promise<Step>): Promise<RouteOutcome> {
    const step = await this.withSlot(work);
    return step.status === 'deferred' ? step.next() : step;
  }

  /** Handles an answered routing question: a manual-pause question or a destination question.
   * Plan questions are filtered out in routeNow before calling this, so they never reach here. */
  private afterQuestion(request: Request, question: Question | null, asked: number): Promise<RouteOutcome> {
    if (!question) return Promise.resolve({ status: 'unrouted', reason: 'router stopped' });
    if (question.options.includes(RESUME_AND_DELIVER)) return this.onManualPauseAnswer(request, question);
    return this.onAnswered(request, question, asked);
  }

  /**
   * Delivers the request. An open session gets it as a file through the messenger; if that fails
   * (paused, agent gone) or the session has ended since, the request gets a new session in the same
   * project instead, so a task is never dropped.
   */
  private async deliver(request: Request, choice: RouteChoice, how: How): Promise<Step> {
    const { store, messenger, startSession, folders } = this.deps;
    const current = store.requests.require(request.id);
    if (current.sessionId !== null) return { status: 'skipped', reason: 'already routed' };
    if (current.projectId === null) store.requests.assignProject(request.id, choice.projectId);
    let note = '';
    if (choice.target.kind === 'session') {
      const session = store.sessions.get(choice.target.sessionId);
      if (session && session.projectId === choice.projectId && session.status !== 'ended') {
        try {
          const name = `request-${current.id}.md`;
          // A message the human addressed to this session (dashboard "+") resumes it when paused,
          // even by their own pause: sending it is their decision. That includes a git session whose
          // agent exited (its worktree and conversation are still there); only a session with no
          // agent and no pause to resume from gets a new session.
          const state =
            current.targetSessionId === session.id && folders ? await folders.state(session.id) : 'live';
          const exited = state === 'dead' && session.status === 'paused' && session.branch !== '';
          if ((state === 'dead' && !exited) || state === 'ended') throw new Error('its agent is gone');
          if (state === 'live') {
            await messenger.deliverFile(session.id, name, requestFile(current), deliverySentence(name));
          } else {
            await folders!.resumeWith(session.id, name, requestFile(current), deliverySentence(name));
          }
          store.requests.assignSession(request.id, session.id);
          this.record(
            current,
            choice.projectId,
            `session '${session.title}' (#${session.id})`,
            session.id,
            how,
            '',
          );
          return { status: 'routed', projectId: choice.projectId, sessionId: session.id, newSession: false };
        } catch (error) {
          note = ` Session #${session.id} could not take it (${errorMessage(error)}), so it got a new session.`;
        }
      } else {
        note = ` Session #${choice.target.sessionId} is no longer open, so it got a new session.`;
      }
      this.log(`[router] request #${request.id}:${note}`);
    }
    if (this.abort.signal.aborted) return { status: 'unrouted', reason: 'router stopped' };
    const project = store.projects.require(choice.projectId);
    if (project.kind === 'folder') return this.deliverToFolder(current, project, how, note);

    // A hard crash between the runner's launch and its recording of the session on the request can
    // leave a half-started session, and the restart then starts another: a visible duplicate beats a
    // request silently attached to a session nothing drives. Cleaning those up is the runner's job.
    // Only the human's own tasks: never a part, and never the PR loop's requests (a deploy fix quotes
    // the original request, and it must stay one session linked to the reverted PR).
    if (
      choice.target.kind === 'new' &&
      current.parentRequestId === null &&
      !current.text.startsWith('[loop]') &&
      this.deps.splitter
    ) {
      // Plan stage: the planner splits on its own; only a real question waits for the human.
      const plan = await this.planRequest(current);
      if (this.abort.signal.aborted) return { status: 'unrouted', reason: 'router stopped' };
      if (plan.question && this.config.planTimeoutMs > 0)
        return this.askPlanQuestion(current, project, how, note, plan.question);
      if (plan.parts.length > 1) return this.splitInto(current, project, plan.parts, how);
    }
    let session: Session;
    try {
      session = await startSession(choice.projectId, { requestId: request.id });
    } catch (error) {
      return this.startFailed(current, project, error);
    }
    if (store.requests.require(request.id).sessionId === null)
      store.requests.assignSession(request.id, session.id);
    this.record(
      current,
      choice.projectId,
      `a new session #${session.id} ('${session.title}')`,
      session.id,
      how,
      note,
    );
    return { status: 'routed', projectId: choice.projectId, sessionId: session.id, newSession: true };
  }

  /** The planner's decision; on a failure, no parts and no question: one session. */
  private async planRequest(request: Request): Promise<Plan> {
    try {
      const signal = AbortSignal.any([
        this.abort.signal,
        AbortSignal.timeout(this.config.classifierTimeoutMs),
      ]);
      return await this.deps.splitter!.plan(request.text, signal);
    } catch (error) {
      this.log(`[router] request #${request.id}: could not plan it (${errorMessage(error)}); one session`);
      return { parts: [], question: null };
    }
  }

  /**
   * One child request per part, each routed to its own new session in the project. The parent keeps
   * the human's text and gets no session. Routing the parts happens outside this slot.
   */
  private splitInto(request: Request, project: Project, parts: RequestPart[], how: How): Step {
    const { store } = this.deps;
    const children = store.transaction(() =>
      parts.map((part, i) =>
        store.requests.create({
          projectId: project.id,
          parentRequestId: request.id,
          source: request.source,
          text: partText(part, i, parts.length, request.text),
        }),
      ),
    );
    this.record(
      request,
      project.id,
      `split into ${parts.length} parts, each its own session: ${parts.map((p) => `"${p.title}"`).join(', ')}`,
      null,
      how,
      '',
    );
    return {
      status: 'deferred',
      next: async () => {
        await Promise.all(children.map((c) => this.route(c.id)));
        return { status: 'split', projectId: project.id, parts: children.map((c) => c.id) };
      },
    };
  }

  /**
   * A folder project runs one session at a time (two agents editing the same files would collide),
   * so a request for it goes to its open session when there is one:
   * - live: delivered as a file;
   * - paused for the usage limit: resumed with the file named in its first prompt;
   * - paused by the human: the human is asked (resume and deliver, end and start fresh, or cancel);
   * - dead (agent exited, window gone, never finished starting): ended, which leaves the folder's
   *   files alone, and a new session starts;
   * - none: a new session starts. Losing a start race (FolderBusyError) just goes round again.
   * After FOLDER_ATTEMPTS rounds without success, the human is asked once (per process).
   */
  private async deliverToFolder(request: Request, project: Project, how: How, note: string): Promise<Step> {
    const { store, messenger, startSession, folders } = this.deps;
    const name = `request-${request.id}.md`;
    let failure = 'no attempt made';
    for (let attempt = 0; attempt < FOLDER_ATTEMPTS; attempt++) {
      if (this.abort.signal.aborted) return { status: 'unrouted', reason: 'router stopped' };
      const [open] = store.sessions.list({ projectId: project.id, status: ['active', 'paused'] });
      if (!open) {
        let session: Session;
        try {
          session = await startSession(project.id, { requestId: request.id });
        } catch (error) {
          failure = errorMessage(error);
          if (error instanceof FolderBusyError) continue;
          return this.startFailed(request, project, error);
        }
        if (store.requests.require(request.id).sessionId === null)
          store.requests.assignSession(request.id, session.id);
        this.record(
          request,
          project.id,
          `a new session #${session.id} ('${session.title}')`,
          session.id,
          how,
          note,
        );
        return { status: 'routed', projectId: project.id, sessionId: session.id, newSession: true };
      }
      try {
        const state = folders ? await folders.state(open.id) : 'live';
        if (state === 'ended') continue;
        // Never undo a pause the human made: ask them instead (outside the slot).
        if (state === 'paused-manual') return this.askAboutManualPause(request, project, open);
        if (state === 'dead') {
          if (!folders) throw new Error('cannot end it here');
          await folders.end(open.id);
          note += ` Ended session #${open.id} first: its agent was gone (the folder's files were left as they were).`;
          continue;
        }
        let how2: string;
        if (state === 'live') {
          await messenger.deliverFile(open.id, name, requestFile(request), deliverySentence(name));
          how2 = 'delivered to the open session';
        } else {
          if (!folders) throw new Error('cannot resume it here');
          await folders.resumeWith(open.id, name, requestFile(request), deliverySentence(name));
          how2 = 'resumed the paused session and delivered it';
        }
        store.requests.assignSession(request.id, open.id);
        this.record(
          request,
          project.id,
          `the open session '${open.title}' (#${open.id}): a folder runs one session at a time, so it was ${how2}`,
          open.id,
          how,
          note,
        );
        return { status: 'routed', projectId: project.id, sessionId: open.id, newSession: false };
      } catch (error) {
        failure = `session #${open.id} could not take it: ${errorMessage(error)}`;
        this.log(`[router] request #${request.id}: ${failure}`);
      }
    }
    return this.escalateFolder(request, project, failure);
  }

  /** Asks the human, once per request in this process, what to do with a request its folder could not take. */
  private escalateFolder(request: Request, project: Project, failure: string): Step {
    const reason = `folder busy: ${project.name} could not take the request (${failure})`;
    if (this.folderEscalated.has(request.id)) return { status: 'unrouted', reason };
    this.folderEscalated.add(request.id);
    const { store, questions } = this.deps;
    const candidates: RouteChoice[] = [{ projectId: project.id, target: { kind: 'new' } }];
    for (const s of store.sessions.list({ projectId: project.id, status: ['active', 'paused'] }))
      candidates.push({ projectId: project.id, target: { kind: 'session', sessionId: s.id } });
    // Cancel is the default: an unanswered question must not start yet another attempt on its own.
    const { options } = buildOptions(candidates, [], store);
    const { question } = questions.ask({
      sessionId: ensureRouterSession(store).id,
      requestId: request.id,
      origin: 'router',
      text:
        `Request #${request.id} for the folder project ${project.name} could not be delivered. Try again where? ` +
        `Cancel (the default, if no one answers) drops this request.\n\n${excerptOf(request)}`,
      context: `${capitalize(failure)}. A folder runs one session at a time; ending its open session from the dashboard frees it.`,
      options,
      recommendedOption: CANCEL_OPTION,
    });
    this.addHistory({
      projectId: project.id,
      sessionId: null,
      text: `Request #${request.id} (${request.source}) "${excerptOf(request)}" could not reach ${project.name} (${failure}); asked the human (question #${question.id}).`,
    });
    return {
      status: 'deferred',
      next: async () =>
        this.onAnswered(
          request,
          await this.settled(question),
          this.routingQuestions(request.id).filter((q) => !this.isPlanQuestion(q)).length,
        ),
    };
  }

  /** The open session of a folder project is paused by the human: ask before touching it. Once per process. */
  private askAboutManualPause(request: Request, project: Project, open: Session): Step {
    if (this.manualPauseAsked.has(request.id)) {
      return {
        status: 'unrouted',
        reason: `folder busy: session #${open.id} of ${project.name} is paused by hand`,
      };
    }
    this.manualPauseAsked.add(request.id);
    const { store, questions } = this.deps;
    const { question } = questions.ask({
      sessionId: ensureRouterSession(store).id,
      requestId: request.id,
      origin: 'router',
      text:
        `Request #${request.id} is for the folder project ${project.name}, whose session '${open.title}' ` +
        `(#${open.id}) you paused. Resume it and hand it the request, end it and start a fresh session, ` +
        `or cancel? Cancel (the default, if no one answers) drops this request.\n\n${excerptOf(request)}`,
      context:
        'A folder runs one session at a time, and the router never undoes a pause you made on its own.',
      options: [RESUME_AND_DELIVER, END_AND_START_FRESH, CANCEL_OPTION],
      recommendedOption: CANCEL_OPTION,
    });
    return {
      status: 'deferred',
      next: async () => this.onManualPauseAnswer(request, await this.settled(question)),
    };
  }

  /**
   * Handles an answered Plan-stage question: the answer joins the request text, the planner runs
   * once more (its further questions are ignored: one question per request), then the request is
   * split or gets a single session. Runs inside a concurrency slot (via inSlot) because the
   * planner call and session start must not run unthrottled when several answers arrive at once.
   */
  private async onPlanAnswer(
    request: Request,
    project: Project,
    how: How,
    note: string,
    question: Question | null,
  ): Promise<RouteOutcome> {
    if (!question) return { status: 'unrouted', reason: 'router stopped' };

    const { store, startSession } = this.deps;
    const answer = (question.answer ?? question.recommendedOption).trim();
    const clarified = answer !== '' && answer.toLowerCase() !== PLAN_DECIDE_ALONE.toLowerCase();

    // Guard against a second answer stacking another clarification prefix.
    if (clarified && !request.text.startsWith('Clarification from human (Plan stage):')) {
      this.log(`[router] request #${request.id}: Plan stage clarification received`);
      store.requests.updateText(
        request.id,
        `Clarification from human (Plan stage):\n${answer}\n\n---\n\nOriginal request:\n${request.text}`,
      );
    }

    return this.inSlot(async () => {
      const current = store.requests.require(request.id);
      if (current.sessionId !== null) return { status: 'skipped', reason: 'already routed' };

      const { parts } = await this.planRequest(current);
      if (this.abort.signal.aborted) return { status: 'unrouted', reason: 'router stopped' };
      // inSlot awaits the deferred step after releasing this slot; the parts route in their own slots.
      if (parts.length > 1) return this.splitInto(current, project, parts, how);

      let session: Session;
      try {
        session = await startSession(project.id, { requestId: request.id });
      } catch (error) {
        return this.startFailed(current, project, error);
      }
      if (store.requests.require(request.id).sessionId === null)
        store.requests.assignSession(request.id, session.id);
      this.record(
        current,
        project.id,
        `a new session #${session.id} ('${session.title}')`,
        session.id,
        how,
        note,
      );
      return { status: 'routed', projectId: project.id, sessionId: session.id, newSession: true };
    });
  }

  private async onManualPauseAnswer(request: Request, question: Question | null): Promise<RouteOutcome> {
    if (!question) return { status: 'unrouted', reason: 'router stopped' };
    const { store, folders } = this.deps;
    const answer = (question.answer ?? question.recommendedOption).trim().toLowerCase();
    const how: How = { by: 'human', question };
    const current = store.requests.require(request.id);
    if (current.sessionId !== null) return { status: 'skipped', reason: 'already routed' };
    if (answer !== RESUME_AND_DELIVER.toLowerCase() && answer !== END_AND_START_FRESH.toLowerCase()) {
      this.recordUnrouted(request, `Cancelled request #${request.id}: ${answeredBy(question)}.`);
      return { status: 'cancelled' };
    }
    const project = store.projects.require(current.projectId ?? -1);
    return this.inSlot(async () => {
      const [open] = store.sessions.list({ projectId: project.id, status: ['active', 'paused'] });
      if (answer === END_AND_START_FRESH.toLowerCase()) {
        if (open) {
          if (!folders) throw new Error('cannot end sessions here');
          await folders.end(open.id);
        }
        return this.deliverToFolder(
          current,
          project,
          how,
          open ? ` Ended session #${open.id} first, as asked.` : '',
        );
      }
      if (!open)
        return this.deliverToFolder(current, project, how, ' The paused session had ended meanwhile.');
      const name = `request-${request.id}.md`;
      try {
        if (open.status === 'paused') {
          if (!folders) throw new Error('cannot resume sessions here');
          await folders.resumeWith(open.id, name, requestFile(current), deliverySentence(name));
        } else {
          await this.deps.messenger.deliverFile(open.id, name, requestFile(current), deliverySentence(name));
        }
      } catch (error) {
        this.log(
          `[router] request #${request.id}: could not resume session #${open.id}: ${errorMessage(error)}`,
        );
        return { status: 'unrouted', reason: `could not resume session #${open.id}: ${errorMessage(error)}` };
      }
      store.requests.assignSession(request.id, open.id);
      this.record(
        current,
        project.id,
        `the paused session '${open.title}' (#${open.id}), resumed as asked`,
        open.id,
        how,
        '',
      );
      return { status: 'routed', projectId: project.id, sessionId: open.id, newSession: false };
    });
  }

  private startFailed(request: Request, project: Project, error: unknown): RouteOutcome {
    // The project stays assigned, so the next start retries a new session there.
    this.log(`[router] request #${request.id}: could not start a session: ${errorMessage(error)}`);
    this.addHistory({
      projectId: project.id,
      sessionId: null,
      text: `Could not start a session for request #${request.id} (${request.source}) "${excerptOf(request)}" in ${project.name}: ${errorMessage(error)}. Retried on the next server start.`,
    });
    return { status: 'unrouted', reason: `could not start a session: ${errorMessage(error)}` };
  }

  /** A searchable decision entry in the project's history. */
  private record(
    request: Request,
    projectId: number,
    where: string,
    sessionId: number | null,
    how: How,
    note: string,
  ): void {
    const { store } = this.deps;
    const why = describeHow(how, request);
    const project = store.projects.require(projectId);
    this.addHistory({
      projectId,
      sessionId,
      text: `Routed request #${request.id} (${request.source}) "${excerptOf(request)}" to ${project.name}: ${where}. ${why}${note}`,
    });
  }

  /** Cancelled or given-up requests have no project: their entry goes to the reserved project. */
  private recordUnrouted(request: Request, text: string): void {
    const session = ensureRouterSession(this.deps.store);
    this.addHistory({
      projectId: session.projectId,
      sessionId: session.id,
      text: `${text} Request (${request.source}): "${excerptOf(request)}"`,
    });
  }

  private addHistory(entry: { projectId: number; sessionId: number | null; text: string }): void {
    try {
      this.deps.store.history.add({ ...entry, kind: 'decision' });
    } catch (error) {
      this.log(`[router] could not record a routing decision: ${errorMessage(error)}`);
    }
  }

  private projects(): Project[] {
    const reserved = routerProjectId(this.deps.store);
    return this.deps.store.projects.list().filter((p) => p.id !== reserved);
  }

  /** Projects marked for direct input, each with its open sessions (newest first). */
  private eligible(): { project: Project; sessions: Session[] }[] {
    const { store } = this.deps;
    const reserved = routerProjectId(store);
    return store.projects
      .list({ markedForDirectInput: true })
      .filter((p) => p.id !== reserved)
      .map((project) => ({
        project,
        sessions: store.sessions.list({ projectId: project.id, status: ['active', 'paused'] }),
      }));
  }

  private classifyInput(
    request: Request,
    eligible: { project: Project; sessions: Session[] }[],
  ): ClassifyInput {
    const { store } = this.deps;
    return {
      request: { id: request.id, text: request.text },
      projects: eligible.map(({ project, sessions }) => ({
        id: project.id,
        name: project.name,
        kind: project.kind,
        ...(project.kind === 'folder' && project.folderPath ? { folder: basename(project.folderPath) } : {}),
        repos: project.repos.map((r) => r.name),
        recentRequests: store.requests
          .list({ projectId: project.id })
          .slice(-this.config.recentRequests)
          .reverse()
          .map((r) => (r.text.trim().split('\n')[0] ?? '').slice(0, 120)),
        sessions: sessions.map((s) => ({ id: s.id, title: s.title, branch: s.branch, status: s.status })),
      })),
    };
  }
}

/** The file an open session reads. */
function requestFile(request: Request): string {
  return `# Request #${request.id} (from ${request.source}, ${request.createdAt})\n\n${request.text}\n`;
}

function answeredBy(question: Question): string {
  return question.status === 'defaulted'
    ? `no answer to question #${question.id} within its deadline, so its recommended "${question.recommendedOption}" was taken`
    : `the human chose "${question.answer ?? ''}" (question #${question.id}, via ${question.answeredVia ?? 'unknown'})`;
}

function describeHow(how: How, request: Request): string {
  if (how.by === 'preset')
    return request.targetSessionId === null
      ? 'The request named its project.'
      : 'The human addressed it to this session.';
  if (how.by === 'classifier') {
    return `Classifier, ${Math.round(how.confidence * 100)}% sure${how.reason ? `: ${how.reason}` : '.'}`;
  }
  return `${capitalize(answeredBy(how.question))}.`;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const excerptOf = (request: Request) => request.text.replace(/\s+/g, ' ').trim().slice(0, 300);
