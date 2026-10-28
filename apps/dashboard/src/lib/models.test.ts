import { describe, expect, it } from 'vitest';
import { demoData } from './fixtures';
import { agentModel, modelDefaults, shortModel } from './models';
import { agentModelInput, treeSessionSchema } from './schemas';

const NOW = new Date('2026-10-18T12:00:00.000Z');
const { tree, settings } = demoData(NOW);
const sessions = tree.flatMap((p) => p.sessions);
const byId = (id: number) => sessions.find((s) => s.id === id)!;
const defaults = modelDefaults(settings);

describe('modelDefaults', () => {
  it('offers the Claude aliases and the session model, never the OpenCode models', () => {
    expect(defaults).toEqual({
      sessionModel: 'opus',
      fallbackModel: 'opencode/glm-5.3-flash-free',
      allowed: ['opus', 'sonnet', 'haiku'],
    });
  });

  it('leaves out a Settings value that is not a safe model name', () => {
    const odd = modelDefaults({
      sessionModel: 'opus[1m]',
      fallbackModel: 'a b',
      opencodeBackupModels: ['-x'],
    });
    expect(odd.allowed).toEqual(['opus', 'sonnet', 'haiku']);
  });
});

describe('agentModel', () => {
  it("shows the Planner's pick, the human's pick, and the default for an agent without one", () => {
    const payments = byId(101);
    expect(agentModel(payments, 'review', defaults)).toMatchObject({ model: 'opus', by: 'planner' });
    expect(agentModel(payments, 'tests', defaults)).toMatchObject({ model: 'haiku', by: 'planner' });
    expect(agentModel(payments, 'security', defaults)).toEqual({
      model: 'opus',
      by: 'default',
      fallback: 'opus',
      editable: true,
    });
    expect(agentModel(byId(102), 'review', defaults)).toMatchObject({ model: 'opus', by: 'human' });
    // The builder's default is the model its session runs on.
    expect(agentModel(byId(102), 'builder', defaults)).toMatchObject({
      model: 'sonnet',
      by: 'planner',
      fallback: 'opus',
    });
  });

  it('an OpenCode session runs its checks on the fallback model and its picks cannot change it', () => {
    const rss = byId(201);
    expect(agentModel(rss, 'review', defaults)).toEqual({
      model: 'opencode/glm-5.3-flash-free',
      by: 'default',
      fallback: 'opencode/glm-5.3-flash-free',
      editable: false,
    });
    const picked = { ...rss, models: { review: { model: 'sonnet', by: 'human' as const } } };
    expect(agentModel(picked, 'review', defaults)).toMatchObject({ model: 'opencode/glm-5.3-flash-free' });
    expect(agentModel(rss, 'builder', defaults)).toMatchObject({ model: rss.model, editable: false });
  });
});

describe('shortModel', () => {
  it('keeps an alias and shortens a long name to its recognizable tail', () => {
    expect(shortModel('opus')).toBe('opus');
    expect(shortModel('claude-opus-4-8')).toBe('opus-4-8');
    expect(shortModel('opencode/glm-5.3-flash-free')).toBe('glm-5.3-flash-free');
    expect(shortModel('a/')).toBe('a/');
  });
});

describe('what an older server sends', () => {
  const base = {
    id: 1,
    projectId: 1,
    title: 't',
    status: 'active',
    pauseReason: null,
    provider: 'claude',
    model: 'opus',
    effort: null,
    branch: 'b',
    createdAt: NOW.toISOString(),
    endedAt: null,
    pendingQuestions: 0,
    subagents: [],
  };

  it('has no models: every agent uses the default', () => {
    expect(treeSessionSchema.parse(base)).toMatchObject({ models: {}, modelsReason: null });
  });

  it('reads an unknown source as the Planner and a malformed map as none', () => {
    const odd = { ...base, models: { review: { model: 'opus', by: 'robot' } } };
    expect(treeSessionSchema.parse(odd).models).toEqual({ review: { model: 'opus', by: 'planner' } });
    expect(treeSessionSchema.parse({ ...base, models: 'opus' }).models).toEqual({});
  });
});

describe('agentModelInput', () => {
  it('trims a name, takes null for the default, and refuses anything a CLI could read as an option', () => {
    expect(agentModelInput.parse({ sessionId: 1, agent: 'review', model: ' sonnet ' }).model).toBe('sonnet');
    expect(agentModelInput.parse({ sessionId: 1, agent: 'builder', model: null }).model).toBeNull();
    for (const model of ['-x', '--effort=max', 'a b', 'opus;ls', '$(id)', '', 'a'.repeat(81)])
      expect(agentModelInput.safeParse({ sessionId: 1, agent: 'builder', model }).success, model).toBe(false);
    expect(agentModelInput.safeParse({ sessionId: 1, agent: 'Bad Agent', model: 'opus' }).success).toBe(
      false,
    );
  });
});
