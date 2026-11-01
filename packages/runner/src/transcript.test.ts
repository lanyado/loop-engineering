import { describe, expect, it } from 'vitest';
import { takenMessages, transcriptHas } from './transcript.js';

const line = (entry: object) => JSON.stringify(entry);
const SENT = 'New review feedback for PR #1 is in .loop/pr1-round1-review.md. Read it and address it.';

// Lines as Claude Code 2.1 writes them (trimmed): an idle prompt, then a message typed while it was busy.
const JSONL = [
  '{"parentUuid":"a016","type":"user","message":{"role":"user","content":"Run the tests. Then reply with just: first"},"uuid":"472"}',
  '{"type":"last-prompt","lastPrompt":"Run the tests. Then reply with just: first"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"New review feedback for PR #9"}}]}}',
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"New review feedback for PR #9 in the output"}]}}',
  line({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: '2026-11-01T00:10:21.937Z',
    content: SENT,
  }),
  line({ type: 'queue-operation', operation: 'remove', content: SENT, reason: 'absorbed_mid_turn' }),
  '{"type":"attachment","attachment":{"type":"queued_command","commandMode":"prompt","origin":{"kind":"human"},"prompt":"New test failure feedback for PR #1 is in .loop/x.md."}}',
  '{"type":"user","origin":{"kind":"human"},"message":{"role":"user","content":[{"type":"text","text":"a pasted\\nmessage"}]}}',
  '{"type":"user","message":{"role":"user","content":"half writ',
].join('\n');

describe('takenMessages', () => {
  it('reads prompts, queued messages and text blocks; never tool output or a half-written line', () => {
    expect(takenMessages(JSONL)).toEqual([
      'Run the tests. Then reply with just: first',
      'New test failure feedback for PR #1 is in .loop/x.md.',
      'a pasted\nmessage',
      SENT,
    ]);
  });

  it('leaves out what no one typed: meta entries, compaction summaries, notifications, other agents', () => {
    const jsonl = [
      line({ type: 'user', isMeta: true, message: { content: SENT } }),
      line({ type: 'user', isCompactSummary: true, message: { content: `Earlier the user said: ${SENT}` } }),
      line({ type: 'user', isSidechain: true, message: { content: SENT } }),
      line({ type: 'user', origin: { kind: 'peer', from: 'a1' }, message: { content: SENT } }),
      line({
        type: 'queue-operation',
        operation: 'enqueue',
        content: `<task-notification>${SENT}</task-notification>`,
      }),
      line({
        type: 'attachment',
        attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: SENT },
      }),
      line({
        type: 'attachment',
        attachment: { type: 'queued_command', commandMode: 'prompt', isMeta: true, prompt: SENT },
      }),
      line({
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          commandMode: 'prompt',
          origin: { kind: 'channel' },
          prompt: SENT,
        },
      }),
    ].join('\n');
    expect(takenMessages(jsonl)).toEqual([]);
  });

  it('does not count a queued message the human pulled back into the input box (Esc)', () => {
    const jsonl = [
      line({ type: 'queue-operation', operation: 'enqueue', content: SENT }),
      line({ type: 'queue-operation', operation: 'popAll' }),
    ].join('\n');
    expect(takenMessages(jsonl)).toEqual([]);
  });
});

describe('transcriptHas', () => {
  it('finds a typed line however Claude wrapped its whitespace', () => {
    expect(transcriptHas(JSONL, SENT)).toBe(true);
    expect(transcriptHas(JSONL, 'a pasted message')).toBe(true);
  });

  it('does not count a tool call or its output that merely mentions it', () => {
    expect(transcriptHas(JSONL, 'New review feedback for PR #9')).toBe(false);
    expect(transcriptHas('', 'x')).toBe(false);
  });
});
