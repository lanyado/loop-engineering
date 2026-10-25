import {
  ANSWER_CHANNELS,
  NotFoundError,
  ValidationError,
  type AnswerChannel,
  type Question,
} from '@loop-engineering/core';
import {
  createMcpHandler,
  McpServer,
  type CallToolResult,
  type CreateMcpHandlerOptions,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import * as z from 'zod';
import { QUESTION_LIMITS as L, resolveSessionId, SESSION_HEADER } from './limits.js';
import type { QuestionService } from './service.js';
import { systemTimers, type TimerHandle, type Timers } from './timers.js';

export const ASK_HUMAN_TOOL = 'ask_human';

export const askHumanInputSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1)
    .max(L.question)
    .describe('The question for the human, short and self-contained.'),
  options: z
    .array(z.string().trim().min(1).max(L.option))
    .min(1)
    .max(L.options)
    .describe('The answers the human can pick from. They may also reply with free text.'),
  recommended: z
    .string()
    .trim()
    .min(1)
    .max(L.option)
    .describe('The option you will go with if nobody answers in 15 minutes. Must be one of `options`.'),
  context: z
    .string()
    .max(L.context)
    .optional()
    .describe('Background the human needs to answer: what you are doing and what each option costs.'),
  sessionId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Leave this out: your session is known from the connection. If given, it must match it.'),
  subagentId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Your subagent id, when a subagent is asking rather than the session itself.'),
});

export const askHumanOutputSchema = z.object({
  questionId: z.number().int(),
  answer: z.string(),
  answeredVia: z.enum(ANSWER_CHANNELS),
  defaulted: z.boolean(),
  note: z.string(),
});

export type AskHumanInput = z.infer<typeof askHumanInputSchema>;
export type AskHumanOutput = z.infer<typeof askHumanOutputSchema>;

const DESCRIPTION = `Ask the human a question and wait for their answer. Use it for decisions you cannot settle from the code or the request: product choices, tradeoffs, anything hard to reverse.
The question reaches the human on Telegram and the dashboard; the first answer wins. The call blocks until they answer, for at most 15 minutes. With no answer by then it returns your \`recommended\` option with defaulted: true, and you must then say in your work (summary, PR description) that you went with your recommended option, so the human can revisit it.
The human may reply with free text instead of one of the options; follow what they wrote.
If your connection drops while waiting, ask the identical question again: you get the same question back, with its answer if the human answered while you were away. Once you have received an answer, asking the same question again asks the human anew.`;

export interface AskHumanOptions {
  timers?: Timers;
  /** The X-Loop-Session-Id header of the MCP request; see resolveSessionId(). */
  sessionHeader?: string | null;
  /**
   * While waiting, send a progress notification this often when the client asked for progress,
   * so clients that reset their timeout on progress and proxies with idle timeouts keep the call
   * open. Default 25s; 0 disables.
   */
  heartbeatMs?: number;
}

/**
 * Turns a resolved question into the tool result the agent reads. `reattached` marks an outcome
 * that was settled while the agent was disconnected and is now handed to its identical re-ask.
 */
export function toAskHumanOutput(question: Question, reattached = false): AskHumanOutput {
  const answer = question.answer ?? question.recommendedOption;
  const answeredVia: AnswerChannel = question.answeredVia ?? 'timeout';
  const defaulted = question.status === 'defaulted';
  let note: string;
  if (defaulted) {
    const minutes = Math.round((Date.parse(question.deadline) - Date.parse(question.createdAt)) / 60_000);
    note =
      `No answer within ${minutes} minutes, so you went with your recommended option "${answer}". ` +
      'Say so in your work (summary, PR description) so the human can revisit the choice.';
  } else if (question.options.includes(answer)) {
    note = `The human chose "${answer}" (via ${answeredVia}).`;
  } else {
    note = `The human replied via ${answeredVia} with free text instead of one of the options. Follow it: "${answer}"`;
  }
  if (reattached) {
    note =
      `This is the outcome of your identical question #${question.id} from ${question.createdAt}, settled ` +
      `while you were disconnected (${question.answeredAt ?? 'unknown time'}). ${note}`;
  }
  return { questionId: question.id, answer, answeredVia, defaulted, note };
}

/**
 * Creates the question (or re-attaches to an identical one whose outcome never reached the agent),
 * waits until it is answered or defaulted, and returns the outcome. Rejects if `signal` aborts first; the question then stays
 * pending, so the human can still answer it and the sweep still defaults it on time.
 */
export async function askHuman(
  service: QuestionService,
  input: AskHumanInput & { sessionId: number },
  signal?: AbortSignal,
): Promise<AskHumanOutput> {
  const { question, reused } = service.ask({
    sessionId: input.sessionId,
    subagentId: input.subagentId ?? null,
    text: input.question,
    context: input.context ?? null,
    options: input.options,
    recommendedOption: input.recommended,
    origin: 'agent',
  });
  const reattached = reused && question.status !== 'pending';
  return toAskHumanOutput(await service.wait(question.id, signal), reattached);
}

export function registerAskHumanTool(
  server: McpServer,
  service: QuestionService,
  options: AskHumanOptions = {},
): void {
  const timers = options.timers ?? systemTimers;
  const heartbeatMs = options.heartbeatMs ?? 25_000;
  server.registerTool(
    ASK_HUMAN_TOOL,
    {
      title: 'Ask the human',
      description: DESCRIPTION,
      inputSchema: askHumanInputSchema,
      outputSchema: askHumanOutputSchema,
    },
    async (input, ctx): Promise<CallToolResult> => {
      const progressToken = ctx.mcpReq._meta?.progressToken;
      let beat: TimerHandle | null = null;
      if (progressToken !== undefined && heartbeatMs > 0) {
        let progress = 0;
        const heartbeat = () => {
          beat = timers.setTimeout(() => {
            progress += 1;
            ctx.mcpReq
              .notify({
                method: 'notifications/progress',
                params: { progressToken, progress, message: 'waiting for the human' },
              })
              .catch(() => {}); // the client went away; the abort signal ends the wait
            heartbeat();
          }, heartbeatMs);
        };
        heartbeat();
      }
      try {
        const session = resolveSessionId(options.sessionHeader, input.sessionId);
        if ('error' in session) return { isError: true, content: [{ type: 'text', text: session.error }] };
        const output = await askHuman(service, { ...input, sessionId: session.sessionId }, ctx.mcpReq.signal);
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
      } catch (error) {
        if (error instanceof ValidationError || error instanceof NotFoundError) {
          return { isError: true, content: [{ type: 'text', text: error.message }] };
        }
        throw error;
      } finally {
        if (beat !== null) timers.clearTimeout(beat);
      }
    },
  );
}

/** What an extra tool learns about the MCP connection it is registered on. */
export interface McpConnection {
  /** The X-Loop-Session-Id header (see resolveSessionId()); null when missing. */
  sessionHeader: string | null;
}

/** Registers more tools on the per-connection MCP server, next to ask_human (e.g. search_history). */
export type McpToolRegistrar = (server: McpServer, connection: McpConnection) => void;

/** The ask_human MCP server as a web-standard fetch handler (Streamable HTTP, both protocol eras). */
export function createAskHumanMcpHandler(
  service: QuestionService,
  options: AskHumanOptions &
    Pick<CreateMcpHandlerOptions, 'onerror' | 'keepAliveMs'> & { tools?: readonly McpToolRegistrar[] } = {},
): McpHttpHandler {
  const { onerror, keepAliveMs, tools = [], ...toolOptions } = options;
  return createMcpHandler(
    ({ requestInfo }) => {
      const server = new McpServer({ name: 'loop-engineering-ask-human', version: '0.0.0' });
      const sessionHeader = requestInfo?.headers.get(SESSION_HEADER) ?? null;
      registerAskHumanTool(server, service, { ...toolOptions, sessionHeader });
      // A broken module tool must never take ask_human down with it, and nothing may replace ask_human.
      const guarded = new Proxy(server, {
        get(target, prop, receiver) {
          if (prop === 'registerTool') {
            return (name: string, ...rest: unknown[]) => {
              if (name === ASK_HUMAN_TOOL) throw new Error(`${ASK_HUMAN_TOOL} is reserved`);
              return (target.registerTool as (...a: unknown[]) => unknown).call(target, name, ...rest);
            };
          }
          const value: unknown = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
      for (const register of tools) {
        try {
          register(guarded, { sessionHeader });
        } catch (error) {
          (onerror ?? ((e: Error) => console.error('[mcp] tool registration failed:', e)))(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
      return server;
    },
    {
      ...(onerror ? { onerror } : {}),
      ...(keepAliveMs !== undefined ? { keepAliveMs } : {}),
    },
  );
}
