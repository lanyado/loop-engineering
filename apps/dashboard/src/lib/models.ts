import { isModelName, type ModelSource, type Settings, type TreeSession } from './schemas';

/** Claude aliases that always resolve to the newest model of that tier (core's MODEL_ALIASES). */
export const MODEL_ALIASES = ['opus', 'sonnet', 'haiku'] as const;

/** What an agent uses when its session has no pick for it, and the names the model menu offers. */
export interface ModelDefaults {
  sessionModel: string;
  fallbackModel: string;
  allowed: string[];
}

/** The names the menu offers: the Claude aliases and the session model (a pick only applies on Claude). */
export function modelDefaults(
  settings: Pick<Settings, 'sessionModel' | 'fallbackModel' | 'opencodeBackupModels'>,
): ModelDefaults {
  const allowed = [...new Set([...MODEL_ALIASES, settings.sessionModel])].filter(isModelName);
  return { sessionModel: settings.sessionModel, fallbackModel: settings.fallbackModel, allowed };
}

export interface AgentModelView {
  model: string;
  /** "default": the session has no pick, so it is what Settings gives. */
  by: ModelSource | 'default';
  /** The model the agent uses without a pick, for "Use the default". */
  fallback: string;
  /** Whether a pick can change it: the choice is for Claude only (OpenCode runs its own chain). */
  editable: boolean;
}

/**
 * The model an agent of a session uses (the builder: since its last launch; a check: for its next
 * job). `agent` is "builder" or a check's stage id.
 */
export function agentModel(session: TreeSession, agent: string, defaults: ModelDefaults): AgentModelView {
  const builder = agent === 'builder';
  const claude = session.provider !== 'opencode';
  const fallback = builder ? session.model : claude ? defaults.sessionModel : defaults.fallbackModel;
  const pick = claude ? session.models[agent] : undefined;
  return { model: pick?.model ?? fallback, by: pick?.by ?? 'default', fallback, editable: claude };
}

/** The short form for a node: an alias as is, else a long name's tail ("glm-5.3-flash-free", "opus-4-8"). */
export function shortModel(model: string): string {
  const tail = model.slice(model.lastIndexOf('/') + 1).replace(/^claude-/, '');
  return tail || model;
}

/** The editor's example project shows captions with these (it has no settings of its own). */
export const EXAMPLE_MODELS: ModelDefaults = {
  sessionModel: 'opus',
  fallbackModel: 'opencode/glm-5.3-flash-free',
  allowed: [...MODEL_ALIASES, 'opencode/glm-5.3-flash-free'],
};
