import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PR_OUTCOMES, PR_STAGES, ValidationError } from '@loop-engineering/core';
import type { CheckJobKind, PrJobKind } from './ports.js';

/*
 * The PR loop's stages as files (see packages/loop/stages/README.md). The built-in stages ship next to
 * this package; a stages folder (data/stages by default) holds the user's versions and new stages, and
 * pipeline.json there says which checks run, in what order. The engine reads them through a
 * StageLibrary on every step, so a hand edit applies on the next tick.
 */

export const BUILTIN_CHECKS = ['tests', 'review', 'qa'] as const;
export type BuiltinCheck = (typeof BUILTIN_CHECKS)[number];
/** The Production Guardian's instructions: a stage file too (guardian.md), though never a check. */
export const GUARDIAN_STAGE = 'guardian';
/** The session agent's planning instructions (planner.md): never a check either. */
export const PLANNER_STAGE = 'planner';
/** Stage files that hold instructions for something other than a check. */
const INSTRUCTION_STAGES = [GUARDIAN_STAGE, PLANNER_STAGE] as const;
type InstructionStage = (typeof INSTRUCTION_STAGES)[number];
const isInstructionStage = (id: string): id is InstructionStage =>
  (INSTRUCTION_STAGES as readonly string[]).includes(id);
export const STAGE_ACCESS = ['read', 'shell', 'browser'] as const;
export type StageAccess = (typeof STAGE_ACCESS)[number];
/** When a check runs: on every PR, or only when the diff changes that kind of file (see changes.ts). */
export const STAGE_RUNS = [
  'always',
  'code-changes',
  'ui-changes',
  'server-changes',
  'test-changes',
  'docs-changes',
  'dependency-changes',
  'database-changes',
  'infra-changes',
] as const;
export type StageRuns = (typeof STAGE_RUNS)[number];
export const STAGE_ICONS = [
  'tests',
  'review',
  'qa',
  'shield',
  'lock',
  'bug',
  'book',
  'gauge',
  'globe',
  'sparkle',
  'check',
] as const;
export type StageIcon = (typeof STAGE_ICONS)[number];

export const STAGE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** The PR's stages and the pipeline's other nodes and jobs: no stage file may take one of their names. */
const RESERVED_IDS = new Set<string>([
  ...PR_STAGES.filter((s) => !isBuiltinCheck(s)),
  ...PR_OUTCOMES,
  ...['session', 'planner', 'builder', 'approval', 'deploy', 'guardian', 'end', 'conflict', 'ci', 'pipeline'],
]);
export const isStageId = (id: string) => STAGE_ID.test(id) && !RESERVED_IDS.has(id);
/** The names no stage file may take, for the dashboard's editor. */
export const RESERVED_STAGE_IDS: readonly string[] = [...RESERVED_IDS];
const badId = (id: string) =>
  new ValidationError(
    `stage id "${id}": use a-z, 0-9 and dashes (32 at most), and not a pipeline node's name`,
  );
/** Sizes a stage may have. */
export const STAGE_LIMITS = { title: 60, label: 10, prompt: 4_000 } as const;
const MAX_FILE = STAGE_LIMITS.prompt + 2_000;
const MAX_CHECKS = 12;

/** What a stage file holds. For a built-in check, access and runs are fixed by the code. */
export interface StageFields {
  title: string;
  label: string;
  icon: StageIcon;
  access: StageAccess;
  runs: StageRuns;
  prompt: string;
}

export interface Stage extends StageFields {
  id: string;
  builtin: boolean;
  /** A built-in stage the user's folder replaces. */
  overridden: boolean;
  /** The stage's file does not parse: the loop holds PRs at this check until it is fixed. */
  error?: string;
}

export interface Pipeline {
  /** Checks before merge, in the order they run. */
  checks: string[];
  /** Watch the deploy after a merge (repos with a Vercel project) and revert a failed one. */
  deploy: boolean;
  /** Run the Production Guardian (repos with a production URL). */
  guardian: boolean;
  /** pipeline.json cannot be read: the loop does nothing until it is fixed (the other fields are the built-in ones). */
  error?: string;
}

/** A change from the dashboard: the new pipeline, and stages to write (null: delete or reset to built-in). */
export interface PipelineUpdate {
  pipeline: Pipeline;
  stages?: Record<string, StageFields | null>;
}

export interface StageLibrary {
  pipeline(): Pipeline;
  /** The checks' stages. */
  stages(): Stage[];
  stage(id: string): Stage | undefined;
  /** The Production Guardian's instructions (guardian.md). */
  guardian(): Stage;
  /** The session agent's planning instructions (planner.md). */
  planner(): Stage;
}

export interface EditableStageLibrary extends StageLibrary {
  update(change: PipelineUpdate): void;
}

/** What the built-in stages may do and when they run: fixed by the code, not their files. */
const BUILTIN_ACCESS: Record<BuiltinCheck | InstructionStage, Pick<StageFields, 'access' | 'runs'>> = {
  tests: { access: 'shell', runs: 'always' },
  review: { access: 'read', runs: 'always' },
  qa: { access: 'browser', runs: 'ui-changes' },
  guardian: { access: 'browser', runs: 'always' },
  planner: { access: 'read', runs: 'always' },
};

export function isBuiltinCheck(id: string): id is BuiltinCheck {
  return (BUILTIN_CHECKS as readonly string[]).includes(id);
}
const isBuiltin = (id: string): id is BuiltinCheck | InstructionStage =>
  isBuiltinCheck(id) || isInstructionStage(id);

/** The job a check runs: the built-ins have their own kind, a custom stage "check-<id>". */
export const checkJobKind = (check: string): PrJobKind => (isBuiltinCheck(check) ? check : `check-${check}`);
/** The custom stage a "check-<id>" job runs. */
export const checkOfJobKind = (kind: CheckJobKind): string => kind.slice('check-'.length);
/** The check a job runs; the conflict fixer runs none. */
export const jobCheck = (kind: PrJobKind): string | undefined =>
  kind === 'conflict' ? undefined : kind.startsWith('check-') ? checkOfJobKind(kind as CheckJobKind) : kind;

const oneOf = <T extends string>(values: readonly T[], value: string, what: string): T => {
  if ((values as readonly string[]).includes(value)) return value as T;
  throw new ValidationError(`${what} must be one of ${values.join(', ')} (got "${value}")`);
};

/** Checks a stage's fields; the built-in stages keep their own access and runs. */
export function validateStage(id: string, fields: StageFields): StageFields {
  if (!isStageId(id) && !isInstructionStage(id)) throw badId(id);
  const title = fields.title.trim();
  const label = fields.label.trim();
  const prompt = fields.prompt.trim();
  const max = STAGE_LIMITS;
  if (!title || title.length > max.title)
    throw new ValidationError(`stage ${id}: title must be 1-${max.title} characters`);
  if (!label || label.length > max.label)
    throw new ValidationError(`stage ${id}: needs a label of 1-${max.label} characters (the node's name)`);
  if (!prompt || prompt.length > max.prompt)
    throw new ValidationError(`stage ${id}: the prompt must be 1-${max.prompt} characters`);
  if (/[\r\n]/.test(title + label))
    throw new ValidationError(`stage ${id}: title and label are one line each`);
  return {
    title,
    label,
    prompt,
    icon: oneOf(STAGE_ICONS, fields.icon, `stage ${id}: icon`),
    ...(isBuiltin(id)
      ? BUILTIN_ACCESS[id]
      : {
          access: oneOf(STAGE_ACCESS, fields.access, `stage ${id}: access`),
          runs: oneOf(STAGE_RUNS, fields.runs, `stage ${id}: runs`),
        }),
  };
}

/** Reads a stage file: a `---` block of `key: value` lines, then the prompt. */
export function parseStageFile(id: string, text: string): StageFields {
  if (text.length > MAX_FILE)
    throw new ValidationError(`stage ${id}: the file is over ${MAX_FILE} characters`);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new ValidationError(`stage ${id}: the file must start with a --- block`);
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const kv = /^([a-z]+):(.*)$/.exec(line.trim());
    if (!kv) throw new ValidationError(`stage ${id}: cannot read "${line.trim()}"`);
    const key = kv[1]!;
    if (!['title', 'label', 'icon', 'access', 'runs'].includes(key))
      throw new ValidationError(`stage ${id}: unknown setting "${key}"`);
    meta[key] = kv[2]!.trim();
  }
  return validateStage(id, {
    title: meta.title ?? '',
    // A title that fits is the label too; a longer one needs its own label (validateStage says so).
    label: meta.label ?? ((meta.title ?? '').length <= STAGE_LIMITS.label ? (meta.title ?? '') : ''),
    icon: (meta.icon ?? 'check') as StageIcon,
    access: (meta.access ?? 'read') as StageAccess,
    runs: (meta.runs ?? 'always') as StageRuns,
    prompt: match[2] ?? '',
  });
}

export function formatStageFile(id: string, f: StageFields): string {
  const lines = [`title: ${f.title}`, `label: ${f.label}`, `icon: ${f.icon}`];
  if (!isBuiltin(id)) lines.push(`access: ${f.access}`, `runs: ${f.runs}`);
  return `---\n${lines.join('\n')}\n---\n${f.prompt.trim()}\n`;
}

/** A pipeline's shape: { checks: [ids], deploy?, guardian? }, deploy and guardian on unless set false. */
function pipelineShape(raw: unknown): Pipeline {
  const o = raw as Record<string, unknown> | null;
  if (typeof o !== 'object' || o === null || Array.isArray(o))
    throw new ValidationError('it must be an object');
  const extra = Object.keys(o).filter((k) => !['checks', 'deploy', 'guardian'].includes(k));
  if (extra.length > 0) throw new ValidationError(`unknown setting "${extra[0]}"`);
  const { checks, deploy = true, guardian = true } = o;
  if (!Array.isArray(checks) || !checks.every((c) => typeof c === 'string'))
    throw new ValidationError('"checks" must be a list of stage ids');
  if (checks.length > MAX_CHECKS) throw new ValidationError(`"checks" holds at most ${MAX_CHECKS} stages`);
  if (new Set(checks).size !== checks.length) throw new ValidationError('a check is in "checks" twice');
  if (typeof deploy !== 'boolean' || typeof guardian !== 'boolean')
    throw new ValidationError('"deploy" and "guardian" must be true or false');
  return { checks: [...checks], deploy, guardian };
}

/** A pipeline to write: its shape, and every check a stage that exists and parses. */
export function validatePipeline(p: Pipeline, stage: (id: string) => Stage | undefined): Pipeline {
  const valid = pipelineShape(p);
  for (const id of valid.checks) {
    const found = stage(id);
    if (!found) throw new ValidationError(`the pipeline names an unknown stage "${id}"`);
    if (found.error) throw new ValidationError(`stage ${id} is broken: ${found.error}`);
  }
  return valid;
}

/** pipeline.json as written. Its checks may name stages that are missing: the loop holds PRs at those. */
function readPipeline(text: string): Pipeline {
  try {
    return pipelineShape(JSON.parse(text));
  } catch (err) {
    throw new ValidationError(err instanceof SyntaxError ? 'not valid JSON' : (err as Error).message);
  }
}

/** The built-in stages folder: packages/loop/stages, from src/ and from dist/ alike. */
export const BUILTIN_STAGES_DIR = fileURLToPath(new URL('../stages/', import.meta.url));

interface Loaded {
  stages: Map<string, Stage>;
  guardian: Stage;
  planner: Stage;
  pipeline: Pipeline;
}

function readBuiltins(dir: string): Loaded {
  const read = (id: string): Stage => ({
    id,
    builtin: true,
    overridden: false,
    ...parseStageFile(id, readFileSync(join(dir, `${id}.md`), 'utf8')),
  });
  const stages = new Map<string, Stage>(BUILTIN_CHECKS.map((id) => [id, read(id)]));
  const pipeline = validatePipeline(readPipeline(readFileSync(join(dir, 'pipeline.json'), 'utf8')), (id) =>
    stages.get(id),
  );
  return { stages, guardian: read(GUARDIAN_STAGE), planner: read(PLANNER_STAGE), pipeline };
}

let builtins: ReturnType<typeof readBuiltins> | null = null;
const builtinStages = () => (builtins ??= readBuiltins(BUILTIN_STAGES_DIR));

/** Only the built-in stages and pipeline: today's loop. The engine's default; tests use it. */
export function builtinStageLibrary(pipeline?: Partial<Pipeline>, extra: Stage[] = []): StageLibrary {
  const { stages, guardian, planner, pipeline: base } = builtinStages();
  const all = new Map([...stages, ...extra.map((s) => [s.id, s] as const)]);
  const p = validatePipeline({ ...base, ...pipeline }, (id) => all.get(id));
  return {
    pipeline: () => p,
    stages: () => [...all.values()],
    stage: (id) => all.get(id),
    guardian: () => guardian,
    planner: () => planner,
  };
}

/** What the board shows for a stage whose file does not parse. */
const brokenStage = (id: string): Omit<Stage, 'builtin' | 'overridden'> => ({
  id,
  title: id,
  label: id.slice(0, STAGE_LIMITS.label),
  icon: 'check',
  access: 'read',
  runs: 'always',
  prompt: '',
});

/** One version of a file in the stages folder: a change to it gives another. */
const version = (f: { name: string; size: number; mtimeMs: number }) => `${f.name}:${f.size}:${f.mtimeMs}`;

const writeAtomic = (path: string, text: string) => {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, path);
};

/**
 * The built-ins plus a folder of the user's stage files. Read again whenever a file in the folder
 * changed (by name, size and mtime), so the loop sees hand edits on its next step. It fails closed: a
 * stage file that does not parse is kept with its error (the loop holds PRs at that check), and a
 * pipeline.json that cannot be read is reported on the pipeline (the loop does nothing), each with
 * one warning, never a silent fallback to the built-ins.
 */
export class FileStageLibrary implements EditableStageLibrary {
  private signature = '';
  private cached: Loaded | null = null;
  private readonly warned = new Set<string>();

  constructor(
    readonly dir: string,
    private readonly log: (message: string) => void = (m) => console.log(`[stages] ${m}`),
  ) {}

  pipeline(): Pipeline {
    return this.load().pipeline;
  }

  stages(): Stage[] {
    return [...this.load().stages.values()];
  }

  stage(id: string): Stage | undefined {
    return this.load().stages.get(id);
  }

  guardian(): Stage {
    return this.load().guardian;
  }

  planner(): Stage {
    return this.load().planner;
  }

  /**
   * Validates the whole change first, then writes each file atomically: new and changed stages, then
   * pipeline.json, then deletions, so a crash halfway never leaves the pipeline naming a stage that
   * is not there yet (only stale files that nothing names).
   */
  update(change: PipelineUpdate): void {
    const current = this.load().stages;
    const next = new Map(current);
    const writes: [string, string | null][] = [];
    for (const [id, fields] of Object.entries(change.stages ?? {})) {
      if (isInstructionStage(id)) {
        writes.push([id, fields === null ? null : formatStageFile(id, validateStage(id, fields))]);
        continue;
      }
      if (!isStageId(id)) throw badId(id);
      if (fields === null) {
        if (isBuiltinCheck(id)) next.set(id, builtinStages().stages.get(id)!);
        else next.delete(id);
        writes.push([id, null]);
        continue;
      }
      const valid = validateStage(id, fields);
      next.set(id, { id, builtin: isBuiltinCheck(id), overridden: isBuiltinCheck(id), ...valid });
      writes.push([id, formatStageFile(id, valid)]);
    }
    const pipeline = validatePipeline(change.pipeline, (id) => next.get(id));
    mkdirSync(this.dir, { recursive: true });
    const path = (id: string) => join(this.dir, `${id}.md`);
    for (const [id, text] of writes) if (text !== null) writeAtomic(path(id), text);
    writeAtomic(join(this.dir, 'pipeline.json'), `${JSON.stringify(pipeline, null, 2)}\n`);
    for (const [id, text] of writes) if (text === null) rmSync(path(id), { force: true });
    this.signature = '';
  }

  private load(): Loaded {
    const files = this.listFiles();
    const signature = files.map(version).join('|');
    if (this.cached && signature === this.signature) return this.cached;
    const base = builtinStages();
    const stages = new Map(base.stages);
    const instructions: Record<InstructionStage, Stage> = { guardian: base.guardian, planner: base.planner };
    for (const f of files) {
      if (!f.name.endsWith('.md') || f.name === 'README.md') continue;
      const id = f.name.slice(0, -3);
      const builtin = isBuiltin(id);
      let stage: Stage;
      try {
        const fields = parseStageFile(id, readFileSync(join(this.dir, f.name), 'utf8'));
        stage = { id, builtin, overridden: builtin, ...fields };
      } catch (err) {
        const error = (err as Error).message;
        this.warnOnce(version(f), `${f.name} is broken: ${error}`);
        stage = { ...brokenStage(id), builtin, overridden: builtin, error };
      }
      // A broken guardian.md or planner.md keeps the built-in instructions in use, with its error shown.
      if (isInstructionStage(id))
        instructions[id] = stage.error ? { ...base[id], error: stage.error } : stage;
      else stages.set(id, stage);
    }
    let pipeline = base.pipeline;
    const file = files.find((f) => f.name === 'pipeline.json');
    if (file) {
      try {
        pipeline = readPipeline(readFileSync(join(this.dir, file.name), 'utf8'));
      } catch (err) {
        const error = `pipeline.json: ${(err as Error).message}`;
        this.warnOnce(version(file), `${error}; the PR loop waits until it is fixed`);
        pipeline = { ...base.pipeline, error };
      }
    }
    this.cached = { stages, ...instructions, pipeline };
    this.signature = signature;
    return this.cached;
  }

  private listFiles(): { name: string; size: number; mtimeMs: number }[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return []; // no folder yet: the built-ins
    }
    return names
      .filter((n) => n.endsWith('.md') || n === 'pipeline.json')
      .sort()
      .flatMap((name) => {
        try {
          const st = statSync(join(this.dir, name));
          return st.isFile() ? [{ name, size: st.size, mtimeMs: st.mtimeMs }] : [];
        } catch {
          return [];
        }
      });
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log(message);
  }
}
