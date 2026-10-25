import Database from 'better-sqlite3';
import { systemClock, type Clock } from './clock.js';
import { migrate } from './migrations.js';
import { EmailRepo } from './repos/email.js';
import { GuardianRepo } from './repos/guardian.js';
import { HistoryRepo } from './repos/history.js';
import { MetricsRepo } from './repos/metrics.js';
import { ProjectRepo } from './repos/projects.js';
import { PullRequestRepo } from './repos/pull-requests.js';
import { QuestionRepo } from './repos/questions.js';
import { RequestRepo } from './repos/requests.js';
import { SessionRepo } from './repos/sessions.js';
import { SettingsRepo } from './repos/settings.js';
import { SubagentRepo } from './repos/subagents.js';

export interface StoreOptions {
  /** SQLite file path. Default ":memory:" (tests). */
  path?: string;
  clock?: Clock;
}

export interface Store {
  readonly path: string;
  readonly clock: Clock;
  readonly settings: SettingsRepo;
  readonly projects: ProjectRepo;
  readonly sessions: SessionRepo;
  readonly subagents: SubagentRepo;
  readonly questions: QuestionRepo;
  readonly requests: RequestRepo;
  readonly pullRequests: PullRequestRepo;
  readonly metrics: MetricsRepo;
  readonly history: HistoryRepo;
  readonly guardianRuns: GuardianRepo;
  readonly email: EmailRepo;
  /** Runs fn in one transaction; rolls back if it throws. Nested calls become savepoints. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** Opens (creating if needed) and migrates the database. The API is synchronous, like better-sqlite3. */
export function openStore(options: StoreOptions = {}): Store {
  const path = options.path ?? ':memory:';
  const clock = options.clock ?? systemClock;
  const db = new Database(path);
  try {
    if (path !== ':memory:') db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }

  const projects = new ProjectRepo(db, clock);
  const sessions = new SessionRepo(db, clock, projects);
  const subagents = new SubagentRepo(db, clock, sessions);
  const requests = new RequestRepo(db, clock, projects, sessions);
  return {
    path,
    clock,
    settings: new SettingsRepo(db),
    projects,
    sessions,
    subagents,
    questions: new QuestionRepo(db, clock, sessions, subagents),
    requests,
    pullRequests: new PullRequestRepo(db, clock, projects, sessions, requests),
    metrics: new MetricsRepo(db),
    history: new HistoryRepo(db, clock, projects, sessions),
    guardianRuns: new GuardianRepo(db, clock, projects),
    email: new EmailRepo(db, clock),
    transaction: (fn) => db.transaction(fn)(),
    close: () => db.close(),
  };
}
