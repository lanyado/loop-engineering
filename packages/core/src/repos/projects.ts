import { resolve } from 'node:path';
import { isoNow, type Clock } from '../clock.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { deleteById, fromBool, parseJson, toBool, toJson, updateById, where, type Db } from '../sql.js';
import { isSafeBranchName, isSafeRelativePath, isSafeRepoName } from '../names.js';
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  PROJECT_KINDS,
  type EnvFile,
  type PermissionMode,
  type Project,
  type ProjectKind,
  type Repo,
} from '../types.js';

export interface NewProject {
  name: string;
  /** Default "git". */
  kind?: ProjectKind;
  /**
   * Required for a folder project, absent for a git project: an absolute, normalized path. The store
   * checks only its shape; checkFolderProjectPath() checks it on disk (callers run it first).
   */
  folderPath?: string;
  repos?: Repo[];
  envFiles?: EnvFile[];
  autoMerge?: boolean;
  markedForDirectInput?: boolean;
  /** Default DEFAULT_PERMISSION_MODE. */
  permissionMode?: PermissionMode;
}

/** A project's kind and folder are fixed at creation. */
export type ProjectPatch = Partial<Omit<NewProject, 'kind' | 'folderPath'>>;

export interface ProjectFilter {
  markedForDirectInput?: boolean;
}

interface ProjectRow {
  id: number;
  name: string;
  kind: ProjectKind;
  folder_path: string | null;
  repos: string;
  env_files: string;
  auto_merge: number;
  marked_for_direct_input: number;
  permission_mode: PermissionMode;
  created_at: string;
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  folderPath: r.folder_path,
  repos: parseJson<Repo[]>(r.repos),
  envFiles: parseJson<EnvFile[]>(r.env_files),
  autoMerge: toBool(r.auto_merge),
  markedForDirectInput: toBool(r.marked_for_direct_input),
  permissionMode: r.permission_mode,
  createdAt: r.created_at,
});

function validate(name: string, repos: Repo[], envFiles: EnvFile[]): void {
  if (name.trim() === '') throw new ValidationError('project name must not be empty');
  const names = new Set<string>();
  for (const repo of repos) {
    if (repo.name.trim() === '') throw new ValidationError('repo name must not be empty');
    if (!isSafeRepoName(repo.name)) {
      throw new ValidationError(`repo name "${repo.name}" may only use letters, digits, ".", "_" and "-"`);
    }
    if (!isSafeBranchName(repo.defaultBranch)) {
      throw new ValidationError(`repo ${repo.name}: "${repo.defaultBranch}" is not a valid branch name`);
    }
    if (names.has(repo.name)) throw new ValidationError(`duplicate repo name "${repo.name}"`);
    names.add(repo.name);
  }
  for (const file of envFiles) {
    if (!names.has(file.repo)) {
      throw new ValidationError(`env file ${file.source} refers to unknown repo "${file.repo}"`);
    }
    if (!isSafeRelativePath(file.target)) {
      throw new ValidationError(
        `env file target "${file.target}" must be a relative path inside the worktree`,
      );
    }
  }
}

function validateKind(
  kind: ProjectKind,
  folderPath: string | undefined,
  repos: Repo[],
  envFiles: EnvFile[],
): void {
  if (!PROJECT_KINDS.includes(kind)) throw new ValidationError(`unknown project kind "${String(kind)}"`);
  if (kind === 'git') {
    if (folderPath !== undefined) throw new ValidationError('only a folder project has a folderPath');
    return;
  }
  if (folderPath === undefined || folderPath === '')
    throw new ValidationError('a folder project needs a folderPath');
  if (!folderPath.startsWith('/') || resolve(folderPath) !== folderPath || folderPath.includes('\0')) {
    throw new ValidationError(`folder path "${folderPath}" must be an absolute, normalized path`);
  }
  if (repos.length > 0) throw new ValidationError('a folder project has no repos');
  if (envFiles.length > 0) throw new ValidationError('a folder project has no env files');
}

function validatePermissionMode(mode: PermissionMode): void {
  if (!PERMISSION_MODES.includes(mode))
    throw new ValidationError(`unknown permission mode "${String(mode)}"`);
}

export class ProjectRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  create(input: NewProject): Project {
    const repos = input.repos ?? [];
    const envFiles = input.envFiles ?? [];
    validate(input.name, repos, envFiles);
    const kind = input.kind ?? 'git';
    validateKind(kind, input.folderPath, repos, envFiles);
    if (
      input.folderPath &&
      this.db.prepare('SELECT 1 FROM projects WHERE folder_path = ?').get(input.folderPath)
    ) {
      throw new ValidationError(`another project already uses the folder ${input.folderPath}`);
    }
    const permissionMode = input.permissionMode ?? DEFAULT_PERMISSION_MODE;
    validatePermissionMode(permissionMode);
    const info = this.db
      .prepare(
        `INSERT INTO projects (name, kind, folder_path, repos, env_files, auto_merge, marked_for_direct_input, permission_mode, created_at)
         VALUES (@name, @kind, @folderPath, @repos, @envFiles, @autoMerge, @marked, @permissionMode, @createdAt)`,
      )
      .run({
        name: input.name,
        kind,
        folderPath: input.folderPath ?? null,
        repos: JSON.stringify(repos),
        envFiles: JSON.stringify(envFiles),
        autoMerge: fromBool(input.autoMerge ?? false),
        marked: fromBool(input.markedForDirectInput ?? false),
        permissionMode,
        createdAt: isoNow(this.clock),
      });
    return this.require(Number(info.lastInsertRowid));
  }

  get(id: number): Project | undefined {
    const row = this.db.prepare<[number], ProjectRow>('SELECT * FROM projects WHERE id = ?').get(id);
    return row && toProject(row);
  }

  require(id: number): Project {
    const project = this.get(id);
    if (!project) throw new NotFoundError('project', id);
    return project;
  }

  getByName(name: string): Project | undefined {
    const row = this.db.prepare<[string], ProjectRow>('SELECT * FROM projects WHERE name = ?').get(name);
    return row && toProject(row);
  }

  list(filter: ProjectFilter = {}): Project[] {
    const { clause, params } = where({
      marked_for_direct_input: fromBool(filter.markedForDirectInput),
    });
    return this.db
      .prepare<[Record<string, unknown>], ProjectRow>(`SELECT * FROM projects ${clause} ORDER BY name`)
      .all(params)
      .map(toProject);
  }

  update(id: number, patch: ProjectPatch): Project {
    const current = this.require(id);
    for (const fixed of ['kind', 'folderPath'] as const) {
      if (fixed in patch) throw new ValidationError(`a project's ${fixed} cannot be changed`);
    }
    const repos = patch.repos ?? current.repos;
    const envFiles = patch.envFiles ?? current.envFiles;
    validate(patch.name ?? current.name, repos, envFiles);
    validateKind(current.kind, current.folderPath ?? undefined, repos, envFiles);
    if (patch.permissionMode !== undefined) validatePermissionMode(patch.permissionMode);
    if (patch.repos) this.checkRemovedReposUnused(id, current.repos, patch.repos);
    updateById(this.db, 'projects', 'project', id, {
      name: patch.name,
      repos: toJson(patch.repos),
      env_files: toJson(patch.envFiles),
      auto_merge: fromBool(patch.autoMerge),
      marked_for_direct_input: fromBool(patch.markedForDirectInput),
      permission_mode: patch.permissionMode,
    });
    return this.require(id);
  }

  /** A repo may only be removed (or renamed) once no live session worktree or open PR uses it. */
  private checkRemovedReposUnused(projectId: number, before: Repo[], after: Repo[]): void {
    const kept = new Set(after.map((r) => r.name));
    const inUse = this.db.prepare<[number, string, number, string], { what: string }>(
      `SELECT 'a session worktree' AS what FROM sessions s, json_each(s.worktrees) w
         WHERE s.project_id = ? AND s.status != 'ended' AND json_extract(w.value, '$.repo') = ?
       UNION ALL
       SELECT 'an open pull request' FROM pull_requests
         WHERE project_id = ? AND outcome IS NULL AND repo = ?
       LIMIT 1`,
    );
    for (const repo of before) {
      if (kept.has(repo.name)) continue;
      const use = inUse.get(projectId, repo.name, projectId, repo.name);
      if (use) throw new ValidationError(`repo "${repo.name}" is still used by ${use.what}`);
    }
  }

  /** Deletes the project and, by cascade, its sessions, questions, PRs, metrics and history. */
  delete(id: number): boolean {
    return deleteById(this.db, 'projects', id);
  }
}
