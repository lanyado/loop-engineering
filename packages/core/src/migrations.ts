import type { Database } from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /**
   * The migration rebuilds a table other tables reference (SQLite's create-copy-drop-rename recipe,
   * the only way to change a CHECK constraint). It runs with foreign keys off, so dropping the old
   * table does not cascade-delete child rows, and foreign keys are verified before it commits.
   */
  rebuildsTables?: boolean;
}

// Migrations are append-only: never edit one that has shipped, add a new version instead.
// The applied version lives in PRAGMA user_version.
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        fallback_model TEXT NOT NULL,
        video_call_pause INTEGER NOT NULL CHECK (video_call_pause IN (0, 1)),
        telegram_allowlist TEXT NOT NULL DEFAULT '[]'
      );
      INSERT INTO settings (id, fallback_model, video_call_pause, telegram_allowlist)
        VALUES (1, 'opencode/glm-5.3-flash-free', 1, '[]');

      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        repos TEXT NOT NULL DEFAULT '[]',
        env_files TEXT NOT NULL DEFAULT '[]',
        auto_merge INTEGER NOT NULL DEFAULT 0 CHECK (auto_merge IN (0, 1)),
        marked_for_direct_input INTEGER NOT NULL DEFAULT 0 CHECK (marked_for_direct_input IN (0, 1)),
        created_at TEXT NOT NULL
      );

      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
        pause_reason TEXT CHECK (pause_reason IN ('manual', 'video_call', 'travel', 'usage_limit')),
        runtime TEXT NOT NULL DEFAULT 'local' CHECK (runtime IN ('local', 'cloud')),
        provider TEXT NOT NULL DEFAULT 'claude' CHECK (provider IN ('claude', 'opencode')),
        model TEXT NOT NULL,
        tmux_target TEXT,
        agent_session_id TEXT,
        cloud_session_url TEXT,
        branch TEXT NOT NULL,
        worktrees TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        ended_at TEXT,
        CHECK ((status = 'paused') = (pause_reason IS NOT NULL))
      );
      CREATE INDEX sessions_by_project ON sessions(project_id, status);

      CREATE TABLE subagents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT NOT NULL CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
        status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'waiting', 'done', 'failed')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX subagents_by_session ON subagents(session_id);

      CREATE TABLE questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        subagent_id INTEGER REFERENCES subagents(id) ON DELETE SET NULL,
        text TEXT NOT NULL,
        options TEXT NOT NULL,
        recommended_option TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'defaulted')),
        answer TEXT,
        answered_via TEXT CHECK (answered_via IN ('telegram', 'dashboard', 'timeout')),
        created_at TEXT NOT NULL,
        deadline TEXT NOT NULL,
        answered_at TEXT
      );
      CREATE INDEX questions_by_session ON questions(session_id);
      CREATE INDEX questions_pending_by_deadline ON questions(deadline) WHERE status = 'pending';

      CREATE TABLE requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('telegram', 'dashboard')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX requests_by_session ON requests(session_id);

      CREATE TABLE pull_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
        request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        url TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'review'
          CHECK (stage IN ('review', 'tests', 'qa', 'awaiting_approval', 'merge', 'deploying', 'deployed',
                           'reverted', 'escalated')),
        round INTEGER NOT NULL DEFAULT 0 CHECK (round >= 0),
        outcome TEXT CHECK (outcome IN ('merged', 'reverted', 'escalated', 'closed')),
        merge_commit_sha TEXT,
        reverted_by_pr_id INTEGER REFERENCES pull_requests(id) ON DELETE SET NULL,
        fixes_pr_id INTEGER REFERENCES pull_requests(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, repo, number)
      );

      -- Review rounds are not stored here: pull_requests.round is the only counter.
      CREATE TABLE loop_metrics (
        pr_id INTEGER PRIMARY KEY REFERENCES pull_requests(id) ON DELETE CASCADE,
        cost_usd REAL NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE history_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (kind IN ('transcript', 'decision')),
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX history_by_project ON history_entries(project_id, created_at);

      -- External-content FTS5 index over history_entries.text, kept in sync by triggers.
      CREATE VIRTUAL TABLE history_fts USING fts5(
        text,
        content = 'history_entries',
        content_rowid = 'id',
        tokenize = 'porter unicode61'
      );
      CREATE TRIGGER history_fts_insert AFTER INSERT ON history_entries BEGIN
        INSERT INTO history_fts (rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER history_fts_delete AFTER DELETE ON history_entries BEGIN
        INSERT INTO history_fts (history_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER history_fts_update AFTER UPDATE OF text ON history_entries BEGIN
        INSERT INTO history_fts (history_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO history_fts (rowid, text) VALUES (new.id, new.text);
      END;
    `,
  },
  {
    version: 2,
    name: 'question context',
    // Free-text background an agent attaches to an ask_human question, shown next to it in channels.
    sql: `ALTER TABLE questions ADD COLUMN context TEXT;`,
  },
  {
    version: 3,
    name: 'question delivery',
    // When the outcome reached the asking agent; re-asking reuses only undelivered outcomes.
    sql: `ALTER TABLE questions ADD COLUMN delivered_at TEXT;`,
  },
  {
    version: 4,
    name: 'runner: agent_exited pause reason, session effort, session model, project permission mode',
    rebuildsTables: true,
    sql: `
      CREATE TABLE sessions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
        pause_reason TEXT
          CHECK (pause_reason IN ('manual', 'video_call', 'travel', 'usage_limit', 'agent_exited')),
        runtime TEXT NOT NULL DEFAULT 'local' CHECK (runtime IN ('local', 'cloud')),
        provider TEXT NOT NULL DEFAULT 'claude' CHECK (provider IN ('claude', 'opencode')),
        model TEXT NOT NULL,
        effort TEXT CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
        tmux_target TEXT,
        agent_session_id TEXT,
        cloud_session_url TEXT,
        branch TEXT NOT NULL,
        worktrees TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        ended_at TEXT,
        CHECK ((status = 'paused') = (pause_reason IS NOT NULL))
      );
      INSERT INTO sessions_new
        (id, project_id, title, status, pause_reason, runtime, provider, model, tmux_target,
         agent_session_id, cloud_session_url, branch, worktrees, created_at, ended_at)
      SELECT id, project_id, title, status, pause_reason, runtime, provider, model, tmux_target,
             agent_session_id, cloud_session_url, branch, worktrees, created_at, ended_at
      FROM sessions;
      -- Keep the AUTOINCREMENT high-water mark so ids of deleted sessions are never reused.
      DELETE FROM sqlite_sequence WHERE name = 'sessions_new';
      INSERT INTO sqlite_sequence (name, seq) SELECT 'sessions_new', seq FROM sqlite_sequence WHERE name = 'sessions';
      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;
      CREATE INDEX sessions_by_project ON sessions(project_id, status);

      ALTER TABLE settings ADD COLUMN session_model TEXT NOT NULL DEFAULT 'opus';

      ALTER TABLE projects ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'auto'
        CHECK (permission_mode IN ('auto', 'manual', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'));
    `,
  },
  {
    version: 5,
    name: 'unrouted requests: requests.project_id nullable',
    // A task sent from a chat channel is stored before the router (M5) picks its project, so a request
    // has no project until it is routed. SQLite cannot drop NOT NULL in place, hence the rebuild.
    rebuildsTables: true,
    sql: `
      CREATE TABLE requests_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('telegram', 'dashboard')),
        created_at TEXT NOT NULL,
        CHECK (session_id IS NULL OR project_id IS NOT NULL)
      );
      INSERT INTO requests_new (id, project_id, session_id, text, source, created_at)
      SELECT id, project_id, session_id, text, source, created_at FROM requests;
      DELETE FROM sqlite_sequence WHERE name = 'requests_new';
      INSERT INTO sqlite_sequence (name, seq) SELECT 'requests_new', seq FROM sqlite_sequence WHERE name = 'requests';
      DROP TABLE requests;
      ALTER TABLE requests_new RENAME TO requests;
      CREATE INDEX requests_by_session ON requests(session_id);
      CREATE INDEX requests_unrouted ON requests(id) WHERE project_id IS NULL;
    `,
  },
  {
    version: 6,
    name: 'PR loop state',
    // JSON owned by packages/loop: where a PR is inside its stage (reviewed head, feedback sent to the
    // builder, pending question, cleanup progress), so the loop resumes correctly after a restart.
    sql: `ALTER TABLE pull_requests ADD COLUMN loop_state TEXT NOT NULL DEFAULT '{}';`,
  },
  {
    version: 7,
    name: 'router: reserved session for routing questions, question request link',
    // A routing question needs a session (questions.session_id is NOT NULL) before the request has
    // one, so the router keeps one reserved, ended session. Its id is stored here so it is found by
    // id, never by name. ON DELETE SET NULL: if it is ever deleted, the router makes a new one.
    // questions.request_id ties a routing question to the request it is about.
    sql: `
      ALTER TABLE settings ADD COLUMN router_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL;
      ALTER TABLE questions ADD COLUMN request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL;
      CREATE INDEX questions_by_request ON questions(request_id) WHERE request_id IS NOT NULL;
    `,
  },
  {
    version: 8,
    name: 'folder projects: projects.kind, projects.folder_path',
    // A folder project is one plain folder the agent edits in place (no repos, worktrees or PRs).
    // Existing projects become git projects. The CHECK ties the two columns together; the unique
    // index keeps two projects off the same folder (nesting is checked by the API, which sees disk).
    sql: `
      ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'git' CHECK (kind IN ('git', 'folder'));
      ALTER TABLE projects ADD COLUMN folder_path TEXT
        CHECK ((kind = 'folder') = (folder_path IS NOT NULL) AND (folder_path IS NULL OR folder_path LIKE '/%'));
      CREATE UNIQUE INDEX projects_by_folder_path ON projects(folder_path) WHERE folder_path IS NOT NULL;
    `,
  },
  {
    version: 9,
    name: 'imported sessions: sessions.source',
    // Past Claude Code conversations imported as ended sessions are marked "import", so they never
    // look runner-launched, and stay ended. The unique index makes importing twice a no-op: one
    // imported session per conversation per project.
    sql: `
      ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'runner'
        CHECK (source IN ('runner', 'import') AND (source = 'runner' OR status = 'ended'));
      CREATE UNIQUE INDEX sessions_imported ON sessions(project_id, agent_session_id) WHERE source = 'import';
    `,
  },
  {
    version: 10,
    name: 'requests.target_session_id: a message for one session',
    // The dashboard's "+" on a session: the router delivers the request to that session instead of
    // choosing one. Kept apart from session_id (where it was delivered), which stays null until then.
    // ON DELETE SET NULL: a deleted target leaves an ordinary request for the project.
    sql: `ALTER TABLE requests ADD COLUMN target_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL;`,
  },
  {
    version: 11,
    name: 'settings: Claude Code and OpenCode switches',
    // Which agent CLIs the loop may use. Both on: Claude, falling back to OpenCode on a usage limit.
    // The settings repo refuses turning both off.
    sql: `
      ALTER TABLE settings ADD COLUMN claude_enabled INTEGER NOT NULL DEFAULT 1 CHECK (claude_enabled IN (0, 1));
      ALTER TABLE settings ADD COLUMN opencode_enabled INTEGER NOT NULL DEFAULT 1 CHECK (opencode_enabled IN (0, 1));
    `,
  },
  {
    version: 12,
    name: 'OpenCode backup models; subagents found in an agent CLI',
    // Backup models: an OpenCode session that hits a limit, errors or hangs moves to the next one.
    // external_id: the CLI's own id of a subagent the runner found, so each is recorded once.
    sql: `
      ALTER TABLE settings ADD COLUMN opencode_backup_models TEXT NOT NULL DEFAULT '${'["opencode/deepseek-v4.1-flash-free","opencode/big-pickle","opencode/nemotron-3-ultra-free","opencode/mimo-v2.6-flash-free"]'}';
      ALTER TABLE subagents ADD COLUMN external_id TEXT;
      CREATE UNIQUE INDEX subagents_external ON subagents(session_id, external_id) WHERE external_id IS NOT NULL;
    `,
  },
  {
    version: 13,
    name: 'requests split into parts',
    // A request with several independent parts is split into one child request per part, each with
    // its own session, branch and PR; the parent keeps the original text and never gets a session.
    sql: `
      ALTER TABLE requests ADD COLUMN parent_request_id INTEGER REFERENCES requests(id) ON DELETE CASCADE;
      CREATE INDEX requests_by_parent ON requests(parent_request_id) WHERE parent_request_id IS NOT NULL;
    `,
  },
  {
    version: 14,
    name: 'guardian_runs: Production Guardian checks after deploys and once a day',
    // areas is JSON (GuardianAreaResult[]). pr_id is null for a daily run; request_id is the fix task.
    sql: `
      CREATE TABLE guardian_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        repo TEXT NOT NULL,
        trigger TEXT NOT NULL CHECK (trigger IN ('deploy', 'daily')),
        pr_id INTEGER REFERENCES pull_requests(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'passed', 'failed', 'error')),
        critical INTEGER NOT NULL DEFAULT 0 CHECK (critical IN (0, 1)),
        summary TEXT NOT NULL DEFAULT '',
        areas TEXT NOT NULL DEFAULT '[]',
        diagnosis TEXT NOT NULL DEFAULT '',
        evidence_dir TEXT,
        request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX guardian_runs_by_repo ON guardian_runs(project_id, repo, id);
    `,
  },
  {
    version: 15,
    name: 'remove cloud runtime and calendar/travel pauses',
    // Cloud sessions, video-call pausing and the travel handoff were removed. Rebuilds sessions without
    // runtime and cloud_session_url and with pause_reason limited to the remaining reasons; sessions
    // paused for 'video_call' or 'travel' become 'manual' (a person resumes them). Drops the
    // settings.video_call_pause column.
    rebuildsTables: true,
    sql: `
      CREATE TABLE sessions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
        pause_reason TEXT CHECK (pause_reason IN ('manual', 'usage_limit', 'agent_exited')),
        provider TEXT NOT NULL DEFAULT 'claude' CHECK (provider IN ('claude', 'opencode')),
        model TEXT NOT NULL,
        effort TEXT CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
        tmux_target TEXT,
        agent_session_id TEXT,
        branch TEXT NOT NULL,
        worktrees TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        ended_at TEXT,
        source TEXT NOT NULL DEFAULT 'runner'
          CHECK (source IN ('runner', 'import') AND (source = 'runner' OR status = 'ended')),
        CHECK ((status = 'paused') = (pause_reason IS NOT NULL))
      );
      INSERT INTO sessions_new
        (id, project_id, title, status, pause_reason, provider, model, effort, tmux_target,
         agent_session_id, branch, worktrees, created_at, ended_at, source)
      SELECT id, project_id, title, status,
             CASE WHEN pause_reason IN ('video_call', 'travel') THEN 'manual' ELSE pause_reason END,
             provider, model, effort, tmux_target, agent_session_id, branch, worktrees, created_at, ended_at,
             source
      FROM sessions;
      -- Keep the AUTOINCREMENT high-water mark so ids of deleted sessions are never reused.
      DELETE FROM sqlite_sequence WHERE name = 'sessions_new';
      INSERT INTO sqlite_sequence (name, seq) SELECT 'sessions_new', seq FROM sqlite_sequence WHERE name = 'sessions';
      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;
      CREATE INDEX sessions_by_project ON sessions(project_id, status);
      CREATE UNIQUE INDEX sessions_imported ON sessions(project_id, agent_session_id) WHERE source = 'import';

      ALTER TABLE settings DROP COLUMN video_call_pause;
    `,
  },
  {
    version: 16,
    name: 'PR loop: tests stage first',
    // The pipeline now runs tests before code review, so the default stage for a new PR is 'tests'
    // instead of 'review'. SQLite cannot change a DEFAULT on a column with a CHECK constraint in
    // place, so we rebuild the table.
    rebuildsTables: true,
    sql: `
      CREATE TABLE pull_requests_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
        request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        url TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'tests'
          CHECK (stage IN ('review', 'tests', 'qa', 'awaiting_approval', 'merge', 'deploying', 'deployed',
                           'reverted', 'escalated')),
        round INTEGER NOT NULL DEFAULT 0 CHECK (round >= 0),
        outcome TEXT CHECK (outcome IN ('merged', 'reverted', 'escalated', 'closed')),
        merge_commit_sha TEXT,
        reverted_by_pr_id INTEGER REFERENCES pull_requests(id) ON DELETE SET NULL,
        fixes_pr_id INTEGER REFERENCES pull_requests(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        loop_state TEXT NOT NULL DEFAULT '{}',
        UNIQUE (project_id, repo, number)
      );
      INSERT INTO pull_requests_new
        (id, project_id, session_id, request_id, repo, number, url, stage, round, outcome,
         merge_commit_sha, reverted_by_pr_id, fixes_pr_id, created_at, updated_at, loop_state)
      SELECT id, project_id, session_id, request_id, repo, number, url, stage, round, outcome,
             merge_commit_sha, reverted_by_pr_id, fixes_pr_id, created_at, updated_at, loop_state
      FROM pull_requests;
      DELETE FROM sqlite_sequence WHERE name = 'pull_requests_new';
      INSERT INTO sqlite_sequence (name, seq) SELECT 'pull_requests_new', seq FROM sqlite_sequence WHERE name = 'pull_requests';
      DROP TABLE pull_requests;
      ALTER TABLE pull_requests_new RENAME TO pull_requests;
      -- loop_metrics references pull_requests.id with ON DELETE CASCADE; it survives the rebuild
      -- because foreign_keys are OFF during the rebuild and we verify at the end.
    `,
  },
  {
    version: 17,
    name: 'guardian_runs: skipped status for runs that met a network outage',
    // SQLite cannot alter a CHECK, so the table is rebuilt with 'skipped' among the statuses.
    rebuildsTables: true,
    sql: `
      CREATE TABLE guardian_runs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        repo TEXT NOT NULL,
        trigger TEXT NOT NULL CHECK (trigger IN ('deploy', 'daily')),
        pr_id INTEGER REFERENCES pull_requests(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'passed', 'failed', 'error', 'skipped')),
        critical INTEGER NOT NULL DEFAULT 0 CHECK (critical IN (0, 1)),
        summary TEXT NOT NULL DEFAULT '',
        areas TEXT NOT NULL DEFAULT '[]',
        diagnosis TEXT NOT NULL DEFAULT '',
        evidence_dir TEXT,
        request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      INSERT INTO guardian_runs_new SELECT * FROM guardian_runs;
      DELETE FROM sqlite_sequence WHERE name = 'guardian_runs_new';
      INSERT INTO sqlite_sequence (name, seq) SELECT 'guardian_runs_new', seq FROM sqlite_sequence WHERE name = 'guardian_runs';
      DROP TABLE guardian_runs;
      ALTER TABLE guardian_runs_new RENAME TO guardian_runs;
      CREATE INDEX guardian_runs_by_repo ON guardian_runs(project_id, repo, id);
    `,
  },
  {
    version: 18,
    name: "PR loop: a 'check' stage for custom stages from stage files",
    // SQLite cannot alter a CHECK, so the table is rebuilt as in migration 16, with 'check' allowed.
    rebuildsTables: true,
    sql: `
      CREATE TABLE pull_requests_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
        request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        url TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'tests'
          CHECK (stage IN ('review', 'tests', 'qa', 'check', 'awaiting_approval', 'merge', 'deploying',
                           'deployed', 'reverted', 'escalated')),
        round INTEGER NOT NULL DEFAULT 0 CHECK (round >= 0),
        outcome TEXT CHECK (outcome IN ('merged', 'reverted', 'escalated', 'closed')),
        merge_commit_sha TEXT,
        reverted_by_pr_id INTEGER REFERENCES pull_requests(id) ON DELETE SET NULL,
        fixes_pr_id INTEGER REFERENCES pull_requests(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        loop_state TEXT NOT NULL DEFAULT '{}',
        UNIQUE (project_id, repo, number)
      );
      INSERT INTO pull_requests_new
        (id, project_id, session_id, request_id, repo, number, url, stage, round, outcome,
         merge_commit_sha, reverted_by_pr_id, fixes_pr_id, created_at, updated_at, loop_state)
      SELECT id, project_id, session_id, request_id, repo, number, url, stage, round, outcome,
             merge_commit_sha, reverted_by_pr_id, fixes_pr_id, created_at, updated_at, loop_state
      FROM pull_requests;
      DELETE FROM sqlite_sequence WHERE name = 'pull_requests_new';
      INSERT INTO sqlite_sequence (name, seq) SELECT 'pull_requests_new', seq FROM sqlite_sequence WHERE name = 'pull_requests';
      DROP TABLE pull_requests;
      ALTER TABLE pull_requests_new RENAME TO pull_requests;
    `,
  },
  {
    version: 19,
    name: "settings: the dashboard's layout",
    sql: `ALTER TABLE settings ADD COLUMN dashboard_layout TEXT NOT NULL DEFAULT '{}';`,
  },
  {
    version: 20,
    name: 'email channel: email threads and messages; "email" as a request source and answer channel',
    // SQLite cannot alter a CHECK, so requests and questions are rebuilt (as in migration 18) to
    // allow 'email'. Their columns, order and indexes stay as they were.
    rebuildsTables: true,
    sql: `
      CREATE TABLE requests_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('telegram', 'dashboard', 'email')),
        created_at TEXT NOT NULL,
        target_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
        parent_request_id INTEGER REFERENCES requests(id) ON DELETE CASCADE,
        CHECK (session_id IS NULL OR project_id IS NOT NULL)
      );
      INSERT INTO requests_new (id, project_id, session_id, text, source, created_at, target_session_id, parent_request_id)
      SELECT id, project_id, session_id, text, source, created_at, target_session_id, parent_request_id FROM requests;
      DELETE FROM sqlite_sequence WHERE name = 'requests_new';
      INSERT INTO sqlite_sequence (name, seq) SELECT 'requests_new', seq FROM sqlite_sequence WHERE name = 'requests';
      DROP TABLE requests;
      ALTER TABLE requests_new RENAME TO requests;
      CREATE INDEX requests_by_session ON requests(session_id);
      CREATE INDEX requests_unrouted ON requests(id) WHERE project_id IS NULL;
      CREATE INDEX requests_by_parent ON requests(parent_request_id) WHERE parent_request_id IS NOT NULL;

      CREATE TABLE questions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        subagent_id INTEGER REFERENCES subagents(id) ON DELETE SET NULL,
        text TEXT NOT NULL,
        options TEXT NOT NULL,
        recommended_option TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'defaulted')),
        answer TEXT,
        answered_via TEXT CHECK (answered_via IN ('telegram', 'dashboard', 'email', 'timeout')),
        created_at TEXT NOT NULL,
        deadline TEXT NOT NULL,
        answered_at TEXT,
        context TEXT,
        delivered_at TEXT,
        request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL,
        origin TEXT NOT NULL DEFAULT 'system' CHECK (origin IN ('agent', 'router', 'system'))
      );
      -- Who asked the questions already there is not known, but a routing question names its request.
      INSERT INTO questions_new
        (id, session_id, subagent_id, text, options, recommended_option, status, answer, answered_via,
         created_at, deadline, answered_at, context, delivered_at, request_id, origin)
      SELECT id, session_id, subagent_id, text, options, recommended_option, status, answer, answered_via,
             created_at, deadline, answered_at, context, delivered_at, request_id,
             CASE WHEN request_id IS NULL THEN 'system' ELSE 'router' END
      FROM questions;
      DELETE FROM sqlite_sequence WHERE name = 'questions_new';
      INSERT INTO sqlite_sequence (name, seq) SELECT 'questions_new', seq FROM sqlite_sequence WHERE name = 'questions';
      DROP TABLE questions;
      ALTER TABLE questions_new RENAME TO questions;
      CREATE INDEX questions_by_session ON questions(session_id);
      CREATE INDEX questions_pending_by_deadline ON questions(deadline) WHERE status = 'pending';
      CREATE INDEX questions_by_request ON questions(request_id) WHERE request_id IS NOT NULL;

      -- One conversation with a requester: clarifying the task, then (with its request) building it.
      CREATE TABLE email_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        subject TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'clarifying' CHECK (state IN ('clarifying', 'building')),
        request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL,
        -- The last mail an earlier round already dealt with: a new round reads only what came after.
        round_after INTEGER NOT NULL DEFAULT 0,
        mail_thread_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX email_threads_by_request ON email_threads(request_id) WHERE request_id IS NOT NULL;
      CREATE INDEX email_threads_by_mail_thread ON email_threads(mail_thread_id) WHERE mail_thread_id IS NOT NULL;

      -- Every mail in a thread, both ways. An outgoing one may ask a question or announce a PR; one
      -- that started work (a plan, or a reply passed to a session) names the request it created.
      CREATE TABLE email_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL REFERENCES email_threads(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL UNIQUE,
        direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
        text TEXT NOT NULL,
        question_id INTEGER REFERENCES questions(id) ON DELETE SET NULL,
        pr_id INTEGER REFERENCES pull_requests(id) ON DELETE SET NULL,
        request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX email_messages_by_thread ON email_messages(thread_id);
      CREATE INDEX email_messages_by_question ON email_messages(question_id) WHERE question_id IS NOT NULL;

      -- How far the inbox was read: the last IMAP UID seen, valid while the mailbox's UIDVALIDITY holds.
      CREATE TABLE email_cursors (
        address TEXT PRIMARY KEY,
        uid_validity INTEGER NOT NULL,
        last_uid INTEGER NOT NULL
      );
    `,
  },
  {
    version: 21,
    name: 'sessions: the rigor dial',
    sql: `ALTER TABLE sessions ADD COLUMN rigor TEXT NOT NULL DEFAULT 'standard'
            CHECK (rigor IN ('fast', 'light', 'standard', 'thorough'));`,
  },
  {
    version: 22,
    name: 'sessions: the plan the planner submitted',
    sql: `ALTER TABLE sessions ADD COLUMN plan TEXT NULL;
          ALTER TABLE sessions ADD COLUMN planned_at TEXT NULL;`,
  },
  {
    version: 23,
    name: 'sessions: who set the rigor level, and why',
    sql: `ALTER TABLE sessions ADD COLUMN rigor_source TEXT NOT NULL DEFAULT 'default'
            CHECK (rigor_source IN ('default', 'planner', 'human'));
          ALTER TABLE sessions ADD COLUMN rigor_reason TEXT NULL;
          -- A level other than the default was the human's choice: the Planner must not override it.
          UPDATE sessions SET rigor_source = 'human' WHERE rigor <> 'standard';`,
  },
];

/** Applies every migration newer than the database's user_version, each in its own transaction. */
export function migrate(db: Database, migrations: readonly Migration[] = MIGRATIONS): number[] {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const latest = sorted.at(-1)?.version ?? 0;
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > latest) {
    throw new Error(`Database schema version ${current} is newer than this code (${latest})`);
  }
  const applied: number[] = [];
  for (const m of sorted) {
    if (m.version <= current) continue;
    // PRAGMA foreign_keys is a no-op inside a transaction, so it is switched outside it.
    const restoreForeignKeys = m.rebuildsTables && db.pragma('foreign_keys', { simple: true }) === 1;
    if (restoreForeignKeys) db.pragma('foreign_keys = OFF');
    try {
      // IMMEDIATE takes the write lock first; re-reading the version inside it means a second
      // process opening a fresh file at the same time skips what the first one just applied.
      const ran = db
        .transaction(() => {
          if ((db.pragma('user_version', { simple: true }) as number) >= m.version) return false;
          db.exec(m.sql);
          if (m.rebuildsTables && (db.pragma('foreign_key_check') as unknown[]).length > 0) {
            throw new Error(`migration ${m.version} left foreign key violations`);
          }
          db.pragma(`user_version = ${m.version}`);
          return true;
        })
        .immediate();
      if (ran) applied.push(m.version);
    } finally {
      if (restoreForeignKeys) db.pragma('foreign_keys = ON');
    }
  }
  return applied;
}
