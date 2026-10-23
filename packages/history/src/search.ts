import { resolveSessionId } from '@loop-engineering/ask-human';
import { readFile } from 'node:fs/promises';
import {
  envFileValues,
  HISTORY_KINDS,
  redactSecrets,
  type HistoryKind,
  type Store,
} from '@loop-engineering/core';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

export const SEARCH_HISTORY_TOOL = 'search_history';

export const HISTORY_SEARCH_LIMITS = { query: 500, defaultResults: 5, maxResults: 20 } as const;

export interface HistoryResult {
  entryId: number;
  sessionId: number | null;
  kind: HistoryKind;
  createdAt: string;
  /** Matching excerpt, hits wrapped in [ and ]. */
  snippet: string;
}

export interface HistoryQuery {
  query: string;
  /** Omitted: every project (dashboard only; the MCP tool always scopes to the caller's project). */
  projectId?: number;
  kind?: HistoryKind;
  limit?: number;
}

export interface RedactOptions {
  /** Values masked in every result besides token shapes and the project's env values (server secrets). */
  secrets?: readonly string[];
  /** Reads a project's env files for their secret values. Default fs. */
  readFile?: (path: string) => Promise<string>;
}

const SNIPPET_RADIUS = 120;

/** An excerpt around the first query word, with every query word wrapped in [ and ]. */
export function makeSnippet(text: string, query: string): string {
  const words = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).map((w) => w.toLowerCase());
  const lower = text.toLowerCase();
  const at = Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0), text.length);
  const start = Math.max(0, (at === text.length ? 0 : at) - SNIPPET_RADIUS);
  const end = Math.min(text.length, start + 2 * SNIPPET_RADIUS);
  let out = text.slice(start, end).replace(/\s+/g, ' ');
  for (const w of words)
    out = out.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'giu'), '[$1]');
  return `${start > 0 ? '…' : ''}${out}${end < text.length ? '…' : ''}`;
}

async function projectSecrets(store: Store, projectId: number, read: (p: string) => Promise<string>) {
  const project = store.projects.get(projectId);
  const values: string[] = [];
  for (const file of project?.envFiles ?? []) {
    try {
      values.push(...envFileValues(await read(file.source)));
    } catch {
      /* unreadable env file: token shapes and server secrets still apply */
    }
  }
  return values;
}

/**
 * Best matches first; every word of the query must appear (see HistoryRepo.search). Results are
 * redacted when read, whatever wrote the entry (transcripts, loop or router decisions): token shapes,
 * credentials in URLs, the project's secret env values and `options.secrets` become ***. The snippet
 * is cut from the redacted text, so a secret can never show up half-cut at a snippet edge.
 */
export async function searchHistory(
  store: Store,
  q: HistoryQuery,
  options: RedactOptions = {},
): Promise<HistoryResult[]> {
  const limit = Math.min(q.limit ?? HISTORY_SEARCH_LIMITS.defaultResults, HISTORY_SEARCH_LIMITS.maxResults);
  const hits = store.history.search(q.query, {
    ...(q.projectId !== undefined ? { projectId: q.projectId } : {}),
    ...(q.kind ? { kind: q.kind } : {}),
    limit,
  });
  const read = options.readFile ?? ((path: string) => readFile(path, 'utf8'));
  const perProject = new Map<number, string[]>();
  const results: HistoryResult[] = [];
  for (const hit of hits) {
    let values = perProject.get(hit.projectId);
    if (!values) {
      values = [...(await projectSecrets(store, hit.projectId, read)), ...(options.secrets ?? [])];
      perProject.set(hit.projectId, values);
    }
    results.push({
      entryId: hit.id,
      sessionId: hit.sessionId,
      kind: hit.kind,
      createdAt: hit.createdAt,
      snippet: makeSnippet(redactSecrets(hit.text, values), q.query),
    });
  }
  return results;
}

export interface SessionTranscript {
  createdAt: string;
  text: string;
}

/**
 * One session's stored transcript (the latest `transcript` entry), redacted on read exactly like a
 * search result: null when nothing was stored for it (OpenCode sessions, nothing swept yet).
 */
export async function sessionTranscript(
  store: Store,
  sessionId: number,
  options: RedactOptions = {},
): Promise<SessionTranscript | null> {
  const entry = store.history.list({ sessionId, kind: 'transcript', limit: 1 })[0];
  if (!entry) return null;
  const read = options.readFile ?? ((path: string) => readFile(path, 'utf8'));
  // Project env values and options.secrets: token shapes alone are kept out by redactSecrets.
  const values = [...(await projectSecrets(store, entry.projectId, read)), ...(options.secrets ?? [])];
  return { createdAt: entry.createdAt, text: redactSecrets(entry.text, values) };
}

export const searchHistoryInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(HISTORY_SEARCH_LIMITS.query)
    .describe('Words to look for; every word must appear in a result.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(HISTORY_SEARCH_LIMITS.maxResults)
    .optional()
    .describe(`How many results to return (default ${HISTORY_SEARCH_LIMITS.defaultResults}).`),
  kind: z
    .enum(HISTORY_KINDS)
    .optional()
    .describe(
      '"transcript" for past sessions\' conversations, "decision" for recorded decisions; omit for both.',
    ),
});

export const searchHistoryOutputSchema = z.object({
  projectId: z.number().int(),
  results: z.array(
    z.object({
      entryId: z.number().int(),
      sessionId: z.number().int().nullable(),
      kind: z.enum(HISTORY_KINDS),
      createdAt: z.string(),
      snippet: z.string(),
    }),
  ),
});

const DESCRIPTION = `Search this project's history: transcripts of past sessions and the decisions recorded along the way (provider switches, review outcomes, routing…). Use it before redoing work or re-deciding something an earlier session may have settled. Every word of the query must appear in a result; results come best match first as short snippets with hits in [brackets]. Only your own project's history is searched.`;

export interface SearchHistoryToolOptions extends RedactOptions {
  /** The X-Loop-Session-Id header of the MCP request; it decides the project. */
  sessionHeader?: string | null;
}

const errorResult = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

/** Registers search_history; the caller's project comes from its session header, never from arguments. */
export function registerSearchHistoryTool(
  server: McpServer,
  store: Store,
  options: SearchHistoryToolOptions = {},
): void {
  server.registerTool(
    SEARCH_HISTORY_TOOL,
    {
      title: 'Search project history',
      description: DESCRIPTION,
      inputSchema: searchHistoryInputSchema,
      outputSchema: searchHistoryOutputSchema,
    },
    async (input): Promise<CallToolResult> => {
      const resolved = resolveSessionId(options.sessionHeader);
      if ('error' in resolved) return errorResult(resolved.error);
      const session = store.sessions.get(resolved.sessionId);
      if (!session) return errorResult(`session ${resolved.sessionId} does not exist`);
      const output = {
        projectId: session.projectId,
        results: await searchHistory(
          store,
          {
            query: input.query,
            projectId: session.projectId,
            ...(input.kind ? { kind: input.kind } : {}),
            ...(input.limit ? { limit: input.limit } : {}),
          },
          {
            ...(options.secrets ? { secrets: options.secrets } : {}),
            ...(options.readFile ? { readFile: options.readFile } : {}),
          },
        ),
      };
      const text =
        output.results.length === 0
          ? "No matches in this project's history."
          : output.results
              .map(
                (r) =>
                  `#${r.entryId} ${r.kind} (session ${r.sessionId ?? '-'}, ${r.createdAt}): ${r.snippet}`,
              )
              .join('\n');
      return { content: [{ type: 'text', text }], structuredContent: output };
    },
  );
}
