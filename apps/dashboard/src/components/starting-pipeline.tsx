export type Starting = {
  id: number;
  text: string;
  /** The row count at which its real row has arrived. */ after: number;
};

/** The row count at which a session started now shows up, given the placeholders still waiting. */
export const startingAfter = (waiting: readonly Starting[], rowCount: number): number =>
  Math.max(rowCount, ...waiting.map((s) => s.after)) + 1;

/** The placeholders whose real row has not arrived yet. */
export const visibleStarting = (list: readonly Starting[], rowCount: number): Starting[] =>
  list.filter((s) => rowCount < s.after);

/** First line of the brief, cut short: the title the Planner will replace. */
const headline = (text: string) => {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

/**
 * A pipeline drawn the moment "Start session" is sent, before the server has made the session:
 * the same canvas, with the Planner lit and the rest waiting. The real row replaces it.
 */
export function StartingPipeline({ text }: { text: string }) {
  return (
    <li className="session-row starting-pipeline" data-testid="starting-pipeline">
      <div className="canvas">
        <div className="session-header">
          <div className="session-heading">
            <h3 className="session-title">{headline(text)}</h3>
            <div className="session-meta">
              <span>Starting…</span>
            </div>
          </div>
        </div>
        <div className="flow">
          <div className="node node-current node-planner starting-node">
            <span className="node-icon starting-spark" />
            <span className="node-body">
              <span className="node-title">Planner</span>
              <span className="node-detail">starting</span>
            </span>
          </div>
          <span className="edge edge-todo starting-edge" aria-hidden="true" />
          <div className="node node-todo starting-node">
            <span className="node-icon" />
            <span className="node-body">
              <span className="node-title">Builder</span>
            </span>
          </div>
        </div>
      </div>
    </li>
  );
}
