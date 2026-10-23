import { formatDay, newestFinishedFirst, sessionRuntime } from '../lib/format';
import type { TreeSession } from '../lib/schemas';
import { FinishedSessionView } from './finished-session-view';
import { ShowMore } from './show-more';

/** Finished sessions shown at once; the rest sit behind "Show N more", so a long history stays short. */
const FINISHED_SHOWN = 20;

/** One compact line per finished session: title, then when, for how long and on what. */
function FinishedRow({ session, now }: { session: TreeSession; now: number }) {
  const imported = session.source === 'import';
  const day = session.endedAt ?? session.createdAt;
  return (
    <li className="finished-row" data-testid="finished-session" data-session-id={session.id}>
      <span className="finished-title">{session.title}</span>
      <span className="finished-meta muted small">
        {imported && (
          <span className="pill imported" data-testid="imported-chip">
            Imported
          </span>
        )}
        <time dateTime={day} data-testid="finished-date">
          {formatDay(day)}
        </time>
        <span>· ran {sessionRuntime(session.createdAt, session.endedAt, now)}</span>
        <span>· {session.model}</span>
        {session.branch && <span className="mono">· {session.branch}</span>}
        {session.subagents.length > 0 && (
          <span>
            · {session.subagents.length} subagent{session.subagents.length === 1 ? '' : 's'}
          </span>
        )}
        <FinishedSessionView sessionId={session.id} />
      </span>
    </li>
  );
}

export function FinishedGroup({ sessions, now }: { sessions: TreeSession[]; now: number }) {
  const sorted = newestFinishedFirst(sessions);
  const shown = sorted.slice(0, FINISHED_SHOWN);
  const rest = sorted.slice(FINISHED_SHOWN);
  return (
    <details className="ended" data-testid="finished">
      <summary>Finished ({sessions.length})</summary>
      <ShowMore
        first={shown.map((s) => (
          <FinishedRow key={s.id} session={s} now={now} />
        ))}
        rest={rest.map((s) => (
          <FinishedRow key={s.id} session={s} now={now} />
        ))}
        restCount={rest.length}
        total={sorted.length}
      />
    </details>
  );
}
