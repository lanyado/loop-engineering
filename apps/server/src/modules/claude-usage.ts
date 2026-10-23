import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';
import type { ServerModule } from '../context.js';

/**
 * GET /api/usage -> { usage: ClaudeUsage | null }: Claude Code's 5-hour and weekly limits, for the
 * dashboard's top bar. null until a snapshot exists.
 *
 * Claude Code hands its status line command the account's rate limits (`rate_limits.five_hour` and
 * `.seven_day`, each `{ used_percentage, resets_at }` in epoch seconds). scripts/capture-claude-usage.sh,
 * called from the status line, saves them to CLAUDE_USAGE_FILE; this module only reads that file. So
 * the numbers are as fresh as the last status line render of any Claude Code session on this Mac, and
 * no login token is ever read.
 */
export const DEFAULT_USAGE_FILE = join(homedir(), '.local', 'state', 'loop-engineering', 'claude-usage.json');

export interface UsageWindow {
  usedPercentage: number;
  resetsAt: string;
}
export interface ClaudeUsage {
  capturedAt: string;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
}

const window = z.object({ used_percentage: z.number().min(0), resets_at: z.number().positive() }).optional();
const snapshot = z.object({
  capturedAt: z.number().positive(),
  rateLimits: z.object({ five_hour: window, seven_day: window }),
});

const iso = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString();
const toWindow = (w: z.infer<typeof window>): UsageWindow | null =>
  w ? { usedPercentage: Math.min(100, w.used_percentage), resetsAt: iso(w.resets_at) } : null;

/** The snapshot file's contents as the dashboard sees them; null for a missing or malformed file. */
export function parseUsage(text: string): ClaudeUsage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = snapshot.safeParse(raw);
  if (!parsed.success) return null;
  const { capturedAt, rateLimits } = parsed.data;
  return {
    capturedAt: iso(capturedAt),
    fiveHour: toWindow(rateLimits.five_hour),
    sevenDay: toWindow(rateLimits.seven_day),
  };
}

export interface ClaudeUsageOptions {
  /** Default: CLAUDE_USAGE_FILE, else DEFAULT_USAGE_FILE. */
  file?: string;
  read?: (file: string) => Promise<string>;
}

export function claudeUsageModule(options: ClaudeUsageOptions = {}): ServerModule {
  const file = options.file ?? (process.env.CLAUDE_USAGE_FILE?.trim() || DEFAULT_USAGE_FILE);
  const read = options.read ?? ((f: string) => readFile(f, 'utf8'));
  return {
    name: 'claude-usage',
    api(api) {
      api.get('/usage', async (c) => {
        const text = await read(file).catch(() => null);
        return c.json({ usage: text === null ? null : parseUsage(text) });
      });
    },
  };
}
