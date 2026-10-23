import { describe, expect, it } from 'vitest';
import { parseClaudeOutput, parseOpencodeOutput } from './headless-output.js';

describe('headless output', () => {
  it('parses claude JSON: result text, total_cost_usd and token usage (cache included)', () => {
    const out = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'ok ```json\n{"blocking":[]}\n```',
      total_cost_usd: 0.42,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 1000,
        output_tokens: 7,
      },
    });
    expect(parseClaudeOutput(`warning: something\n${out}\n`)).toEqual({
      text: 'ok ```json\n{"blocking":[]}\n```',
      costUsd: 0.42,
      tokensIn: 1110,
      tokensOut: 7,
      isError: false,
    });
    expect(parseClaudeOutput('', 'boom')).toMatchObject({ isError: true, text: 'boom' });
    // stream-json: the events come first, the same result object last.
    const events = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading' }] } }),
    ].join('\n');
    expect(parseClaudeOutput(`${events}\n${out}\n`).costUsd).toBe(0.42);
  });

  it('parses opencode JSON events: text parts and step_finish usage', () => {
    const lines = [
      { type: 'step_start', part: {} },
      { type: 'text', part: { text: 'Looks good.' } },
      {
        type: 'step_finish',
        part: { cost: 0, tokens: { input: 50, output: 5, reasoning: 2, cache: { read: 10, write: 0 } } },
      },
      { type: 'text', part: { text: '```json\n{"blocking":[]}\n```' } },
      { type: 'step_finish', part: { cost: 0.01, tokens: { input: 5, output: 1 } } },
    ].map((l) => JSON.stringify(l));
    expect(parseOpencodeOutput(lines.join('\n'))).toEqual({
      text: 'Looks good.\n```json\n{"blocking":[]}\n```',
      costUsd: 0.01,
      tokensIn: 65,
      tokensOut: 8,
      isError: false,
    });
    expect(
      parseOpencodeOutput(
        JSON.stringify({ type: 'error', error: { name: 'APIError', data: { message: 'rate limited' } } }),
      ),
    ).toMatchObject({
      isError: true,
      text: 'rate limited',
    });
  });

  it('skips opencode lines that are not JSON events', () => {
    const stdout = ['starting…', '{bad json', JSON.stringify({ type: 'text', part: { text: 'ok' } })].join(
      '\n',
    );
    expect(parseOpencodeOutput(stdout)).toMatchObject({ text: 'ok', isError: false });
  });
});
