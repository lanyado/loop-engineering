/** What a headless agent run (`claude -p`, `opencode run`) printed, reduced to the answer and its usage. */
export interface HeadlessResult {
  /** The agent's final answer. */
  text: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  /** The CLI reported an error (the text says which), e.g. a usage limit. */
  isError: boolean;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** `claude -p --output-format json`: one result object (the last JSON line, in case anything precedes it). */
export function parseClaudeOutput(stdout: string, stderr = ''): HeadlessResult {
  const line = stdout
    .trim()
    .split('\n')
    .reverse()
    .find((l) => l.trim().startsWith('{'));
  if (!line) return { text: (stderr || stdout).trim(), costUsd: 0, tokensIn: 0, tokensOut: 0, isError: true };
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { text: (stderr || stdout).trim(), costUsd: 0, tokensIn: 0, tokensOut: 0, isError: true };
  }
  const usage = (r.usage ?? {}) as Record<string, unknown>;
  return {
    text: typeof r.result === 'string' ? r.result : '',
    costUsd: num(r.total_cost_usd),
    tokensIn:
      num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens),
    tokensOut: num(usage.output_tokens),
    isError: r.is_error === true || r.subtype === 'error',
  };
}

/** `opencode run --format json`: one event per line; text parts form the answer, step_finish parts carry usage. */
export function parseOpencodeOutput(stdout: string, stderr = ''): HeadlessResult {
  const texts: string[] = [];
  const result: HeadlessResult = { text: '', costUsd: 0, tokensIn: 0, tokensOut: 0, isError: false };
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const part = (event.part ?? {}) as Record<string, unknown>;
    if (event.type === 'text' && typeof part.text === 'string') texts.push(part.text);
    if (event.type === 'step_finish') {
      const tokens = (part.tokens ?? {}) as Record<string, unknown>;
      const cache = (tokens.cache ?? {}) as Record<string, unknown>;
      result.tokensIn += num(tokens.input) + num(cache.read) + num(cache.write);
      result.tokensOut += num(tokens.output) + num(tokens.reasoning);
      result.costUsd += num(part.cost);
    }
    if (event.type === 'error') {
      result.isError = true;
      const error = (event.error ?? {}) as Record<string, unknown>;
      const data = (error.data ?? {}) as Record<string, unknown>;
      const message = [data.message, error.message, error.name].find((m) => typeof m === 'string');
      texts.push(typeof message === 'string' ? message : 'error');
    }
  }
  result.text = texts.join('\n').trim() || stderr.trim();
  return result;
}
