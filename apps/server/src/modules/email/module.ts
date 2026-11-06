import { dirname, join, resolve } from 'node:path';
import { CliClassifier } from '@loop-engineering/router';
import type { ServerContext, ServerModule } from '../../context.js';
import { EmailChannel, type Clarifier } from './channel.js';
import { clarify, classifyQuestion } from './clarify.js';
import type { EmailConfigResult } from './config.js';
import { GmailMailbox } from './gmail.js';
import type { Mailbox } from './mail.js';

export interface EmailModuleOptions {
  /** From loadEmailConfig(). Disabled: the module only logs why and does nothing else. */
  email: EmailConfigResult;
  /** Replaces Gmail (FakeMailbox in tests). */
  mailbox?: Mailbox;
  /** Replaces the Claude call that asks the questions and writes the plan. */
  clarifier?: Clarifier;
  /** Where the files that come with mail are kept. Default: beside the database. */
  attachmentsDir?: string;
  log?: (message: string) => void;
}

/**
 * Tasks and answers by email as a server module. It reads the inbox on a timer from start(),
 * outbound only (IMAP and SMTP), so it needs no inbound route.
 */
export function emailModule(options: EmailModuleOptions): ServerModule & { channel(): EmailChannel | null } {
  const log = options.log ?? console.log;
  let channel: EmailChannel | null = null;
  return {
    name: 'email',
    channel: () => channel,

    start(ctx: ServerContext) {
      if (!options.email.enabled) {
        log(`[email] channel off: ${options.email.reason}`);
        return;
      }
      const { config } = options.email;
      // Beside the database, which is what the question ids belong to (none for an in-memory one).
      const dataDir = ctx.config.dbPath === ':memory:' ? null : dirname(resolve(ctx.config.dbPath));
      const attachmentsDir = options.attachmentsDir ?? (dataDir && join(dataDir, 'email-attachments'));
      channel = new EmailChannel({
        mailbox: options.mailbox ?? new GmailMailbox(config.address, config.password, log),
        store: ctx.store,
        questions: ctx.questions,
        requests: ctx.requests,
        bus: ctx.bus,
        clarifier: options.clarifier ?? classifierClarifier(ctx, config.about),
        allowlist: config.allowlist,
        project: config.project,
        pollMs: config.pollMs,
        ...(attachmentsDir ? { attachmentsDir } : {}),
        ...(config.owner
          ? {
              owner: config.owner,
              ...(dataDir ? { alertsFile: join(dataDir, 'email-alerts.json') } : {}),
              dashboardUrl: `http://localhost:${process.env.DASHBOARD_PORT?.trim() || '3737'}`,
              ...(options.clarifier ? {} : { classifyQuestion: questionClassifier(ctx) }),
            }
          : {}),
        log,
      });
      channel.start();
      log(
        `[email] reading ${config.address} every ${config.pollMs / 1000} s for tasks from ${config.allowlist.join(', ')}`,
      );
    },

    async stop() {
      await channel?.stop();
      channel = null;
    },
  };
}

/** Who gets an agent's question: one quick headless call, like routing's. */
function questionClassifier(ctx: ServerContext) {
  const classifier = new CliClassifier({
    clock: ctx.clock,
    model: 'haiku',
    fallbackModel: () => ctx.store.settings.get().fallbackModel,
    providers: () => {
      const s = ctx.store.settings.get();
      return { claude: s.claudeEnabled, opencode: s.opencodeEnabled };
    },
  });
  return (question: { text: string; context: string | null }, signal: AbortSignal) =>
    classifyQuestion(classifier, question, signal);
}

/** The planner: one headless Claude call (sonnet; OpenCode while Claude is out of usage or off). */
function classifierClarifier(ctx: ServerContext, about: string | undefined): Clarifier {
  const classifier = new CliClassifier({
    clock: ctx.clock,
    // A plan is worth a stronger model than routing's haiku.
    model: 'sonnet',
    fallbackModel: () => ctx.store.settings.get().fallbackModel,
    providers: () => {
      const s = ctx.store.settings.get();
      return { claude: s.claudeEnabled, opencode: s.opencodeEnabled };
    },
  });
  return {
    clarify: (mails, options, signal) =>
      clarify(classifier, mails, { ...options, ...(about ? { about } : {}) }, signal),
  };
}
