import {
  EmailChannel,
  GmailMailbox,
  type Clarifier,
  type EmailConfigResult,
  type Mailbox,
} from '@loop-engineering/email';
import { CliClassifier } from '@loop-engineering/router';
import type { ServerContext, ServerModule } from '../context.js';

export interface EmailModuleOptions {
  /** From loadEmailConfig(). Disabled: the module only logs why and does nothing else. */
  email: EmailConfigResult;
  /** Replaces Gmail (FakeMailbox in tests). */
  mailbox?: Mailbox;
  /** Replaces the Claude call that asks the questions and writes the plan. */
  clarifier?: Clarifier;
  log?: (message: string) => void;
}

/**
 * Tasks by email (packages/email) as a server module. It reads the inbox on a timer from start(),
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
      channel = new EmailChannel({
        mailbox: options.mailbox ?? new GmailMailbox(config.address, config.password, log),
        store: ctx.store,
        questions: ctx.questions,
        requests: ctx.requests,
        bus: ctx.bus,
        clarifier:
          options.clarifier ??
          new CliClassifier({
            clock: ctx.clock,
            // A plan is worth a stronger model than routing's haiku.
            model: 'sonnet',
            fallbackModel: () => ctx.store.settings.get().fallbackModel,
            providers: () => {
              const s = ctx.store.settings.get();
              return { claude: s.claudeEnabled, opencode: s.opencodeEnabled };
            },
            log,
          }),
        allowlist: config.allowlist,
        pollMs: config.pollMs,
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
