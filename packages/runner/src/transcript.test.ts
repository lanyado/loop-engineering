import { describe, expect, it } from 'vitest';
import { takenMessages, transcriptHas } from './transcript.js';

// Lines as Claude Code 2.1 writes them (trimmed): an idle prompt, then a message typed while it was busy.
const JSONL = [
  '{"parentUuid":"a016","type":"user","message":{"role":"user","content":"Run the tests. Then reply with just: first"},"uuid":"472"}',
  '{"type":"last-prompt","lastPrompt":"Run the tests. Then reply with just: first"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"New review feedback for PR #9"}}]}}',
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"New review feedback for PR #9 in the output"}]}}',
  '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-11-01T00:10:21.937Z","content":"New review feedback for PR #1 is in .loop/pr1-round1-review.md. Read it and address it."}',
  '{"type":"queue-operation","operation":"remove","content":"New review feedback for PR #1 is in .loop/pr1-round1-review.md. Read it and address it.","reason":"absorbed_mid_turn"}',
  '{"type":"attachment","attachment":{"type":"queued_command","prompt":"New test failure feedback for PR #1 is in .loop/x.md."}}',
  '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"a pasted\\nmessage"}]}}',
  '{"type":"user","message":{"role":"user","content":"half writ',
].join('\n');

describe('takenMessages', () => {
  it('reads prompts, queued messages and text blocks; never tool output or a half-written line', () => {
    expect(takenMessages(JSONL)).toEqual([
      'Run the tests. Then reply with just: first',
      'New review feedback for PR #1 is in .loop/pr1-round1-review.md. Read it and address it.',
      'New test failure feedback for PR #1 is in .loop/x.md.',
      'a pasted\nmessage',
    ]);
  });
});

describe('transcriptHas', () => {
  it('finds a typed line however Claude wrapped its whitespace', () => {
    expect(
      transcriptHas(
        JSONL,
        'New review feedback for PR #1 is in .loop/pr1-round1-review.md. Read it and address it.',
      ),
    ).toBe(true);
    expect(transcriptHas(JSONL, 'a pasted message')).toBe(true);
  });

  it('does not count a tool call or its output that merely mentions it', () => {
    expect(transcriptHas(JSONL, 'New review feedback for PR #9')).toBe(false);
    expect(transcriptHas('', 'x')).toBe(false);
  });
});
