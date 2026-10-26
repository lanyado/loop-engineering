import { describe, expect, it } from 'vitest';
import { ReadOnlyError } from './backend';
import { DemoBackend } from './demo-backend';
import { responses } from './schemas';

const now = new Date('2026-10-18T09:00:00.000Z');
const demo = new DemoBackend(() => now);

describe('DemoBackend', () => {
  it('serves fixtures in the same shapes the server returns', async () => {
    expect(responses.questions.parse({ questions: await demo.pendingQuestions() }).questions).toHaveLength(5);
    responses.tree.parse({ projects: await demo.tree() });
    responses.prs.parse({ pullRequests: await demo.pullRequests() });
    responses.settings.parse({ settings: await demo.settings() });
    responses.usage.parse({ usage: await demo.usage() });
    responses.transcript.parse({ transcript: await demo.sessionTranscript(450) });
    responses.transcript.parse({ transcript: await demo.sessionTranscript(103) });
    expect(await demo.sessionTranscript(101)).toBeNull();
  });

  it('keeps pending questions live: soonest deadline first, all due within 15 minutes', async () => {
    const pending = await demo.pendingQuestions();
    const deadlines = pending.map((q) => Date.parse(q.deadline));
    expect(deadlines).toEqual([...deadlines].sort((a, b) => a - b));
    for (const d of deadlines) {
      expect(d).toBeGreaterThan(now.getTime());
      expect(d - now.getTime()).toBeLessThanOrEqual(15 * 60_000);
    }
    for (const q of pending) expect(q.options).toContain(q.recommendedOption);
  });

  it('covers every pipeline stage and keeps counts consistent', async () => {
    const prs = await demo.pullRequests();
    expect(new Set(prs.map((p) => p.stage))).toEqual(
      new Set([
        'review',
        'tests',
        'qa',
        'awaiting_approval',
        'merge',
        'deploying',
        'deployed',
        'reverted',
        'escalated',
      ]),
    );
    expect(prs.every((p) => p.metrics.prId === p.id && p.metrics.rounds === p.round)).toBe(true);
    const tree = await demo.tree();
    const pending = await demo.pendingQuestions();
    for (const s of tree.flatMap((p) => p.sessions)) {
      expect(s.pendingQuestions).toBe(pending.filter((q) => q.sessionId === s.id).length);
      if (s.status !== 'paused') expect(s.pauseReason).toBeNull();
    }
  });

  it('refuses every write', () => {
    expect(() => demo.answer()).toThrow(ReadOnlyError);
    expect(() => demo.updateProject()).toThrow(ReadOnlyError);
    expect(() => demo.updateSettings()).toThrow(ReadOnlyError);
    expect(() => demo.createRequest()).toThrow(ReadOnlyError);
    expect(() => demo.messageSession()).toThrow(ReadOnlyError);
  });

  it('opens an event stream that says ready and ends on abort', async () => {
    const abort = new AbortController();
    const res = await demo.events(abort.signal);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('event: ready\ndata: {}\n\n');
    abort.abort();
    expect((await reader.read()).done).toBe(true);
  });
});
