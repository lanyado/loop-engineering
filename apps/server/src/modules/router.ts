import {
  CliClassifier,
  Router,
  type Classifier,
  type FolderSessions,
  type RouterConfig,
  type SessionMessenger,
  type StartSession,
} from '@loop-engineering/router';
import type { ServerContext, ServerModule } from '../context.js';

export interface RouterModuleOptions {
  /** Default: `ctx.runner.startSession(projectId, { requestId })`. */
  startSession?: StartSession;
  /** Default: `ctx.runner.deliverFile(sessionId, name, content, sentence)`. */
  messenger?: SessionMessenger;
  /** Default: the runner's sessionState / resume({ deliver }) / end(), for folder projects. */
  folders?: FolderSessions;
  /** Default: CliClassifier (claude -p haiku, OpenCode fallback model from Settings). */
  classifier?: Classifier;
  config?: Partial<RouterConfig>;
  log?: (message: string) => void;
}

/**
 * Direct-input routing as a server module: every request.created (Telegram, dashboard, PR loop)
 * gets a project and session, and requests stored while the server was down are routed on start.
 * It uses the server's one shared runner (`ctx.runner`) and never builds its own; without a runner
 * (and no startSession/messenger given) it stays off, and requests wait for a later start.
 */
export function routerModule(options: RouterModuleOptions = {}): ServerModule & { router(): Router | null } {
  const log = options.log ?? console.log;
  let router: Router | null = null;

  return {
    name: 'router',
    router: () => router,

    // Subscribes synchronously; the start-up scan (classifier calls, questions) runs in the background.
    start(ctx: ServerContext) {
      const { runner } = ctx;
      const classifier =
        options.classifier ??
        new CliClassifier({
          clock: ctx.clock,
          fallbackModel: () => ctx.store.settings.get().fallbackModel,
          providers: () => {
            const s = ctx.store.settings.get();
            return { claude: s.claudeEnabled, opencode: s.opencodeEnabled };
          },
          log,
        });
      const startSession: StartSession | undefined =
        options.startSession ??
        (runner
          ? async (projectId, request) => {
              const session = await runner.startSession(projectId, request);
              if (classifier instanceof CliClassifier) {
                void retitle(classifier, ctx, session.id, request.requestId, log);
              }
              return session;
            }
          : undefined);
      const messenger: SessionMessenger | undefined =
        options.messenger ??
        (runner
          ? {
              // Writes <agent cwd>/.loop/<name> (0600, git-excluded) and sends only `sentence`.
              async deliverFile(sessionId, name, content, sentence) {
                await runner.deliverFile(sessionId, name, content, sentence);
              },
            }
          : undefined);
      const folders: FolderSessions | undefined =
        options.folders ??
        (runner
          ? {
              state: (sessionId) => runner.sessionState(sessionId),
              async resumeWith(sessionId, name, content, sentence) {
                await runner.resume(sessionId, { deliver: { name, content, sentence } });
              },
              async end(sessionId) {
                await runner.end(sessionId);
              },
            }
          : undefined);
      if (!startSession || !messenger) {
        log('[router] disabled: no session runner (ctx.runner); requests stay queued until one is wired');
        return;
      }
      router = new Router(
        {
          store: ctx.store,
          bus: ctx.bus,
          questions: ctx.questions,
          classifier,
          startSession,
          messenger,
          // Independent parts of a task run as separate sessions, each merging and deploying on its own.
          ...(classifier instanceof CliClassifier ? { splitter: classifier } : {}),
          ...(folders ? { folders } : {}),
          timers: ctx.timers,
          log,
        },
        options.config,
      );
      router.start().then(
        (outcomes) => {
          if (outcomes.length > 0) log(`[router] start-up scan handled ${outcomes.length} request(s)`);
        },
        (error: unknown) => log(`[router] start-up scan failed: ${String(error)}`),
      );
    },

    async stop() {
      await router?.stop();
      router = null;
    },
  };
}

/**
 * Swaps the session's first-line title for a short generated one, after the agent has started so
 * nothing waits on it. Any failure keeps the first-line title.
 */
async function retitle(
  classifier: CliClassifier,
  ctx: ServerContext,
  sessionId: number,
  requestId: number,
  log: (message: string) => void,
): Promise<void> {
  try {
    const { text } = ctx.store.requests.require(requestId);
    const title = await classifier.title(text, AbortSignal.timeout(90_000));
    if (title) ctx.store.sessions.update(sessionId, { title });
  } catch (error) {
    log(`[router] could not title session ${sessionId}: ${String(error)}`);
  }
}
