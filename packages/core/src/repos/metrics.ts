import { NotFoundError, ValidationError } from '../errors.js';
import type { Db } from '../sql.js';
import type { LoopMetrics } from '../types.js';

/** Rounds are not recorded here: bump PullRequest.round instead. */
export type MetricsDelta = Partial<Pick<LoopMetrics, 'costUsd' | 'tokensIn' | 'tokensOut' | 'failures'>>;

interface MetricsRow {
  pr_id: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  rounds: number;
  failures: number;
}

const toMetrics = (r: MetricsRow): LoopMetrics => ({
  prId: r.pr_id,
  costUsd: r.cost_usd,
  tokensIn: r.tokens_in,
  tokensOut: r.tokens_out,
  rounds: r.rounds,
  failures: r.failures,
});

// One row per PR; counters read as 0 until something is recorded.
const SELECT = `
  SELECT p.id AS pr_id, p.round AS rounds,
         COALESCE(m.cost_usd, 0) AS cost_usd, COALESCE(m.tokens_in, 0) AS tokens_in,
         COALESCE(m.tokens_out, 0) AS tokens_out, COALESCE(m.failures, 0) AS failures
  FROM pull_requests p LEFT JOIN loop_metrics m ON m.pr_id = p.id`;

/** Per-PR loop counters. They only grow: record() adds a delta. */
export class MetricsRepo {
  constructor(private readonly db: Db) {}

  get(prId: number): LoopMetrics {
    const row = this.db.prepare<[number], MetricsRow>(`${SELECT} WHERE p.id = ?`).get(prId);
    if (!row) throw new NotFoundError('pull request', prId);
    return toMetrics(row);
  }

  record(prId: number, delta: MetricsDelta): LoopMetrics {
    const d = {
      costUsd: delta.costUsd ?? 0,
      tokensIn: delta.tokensIn ?? 0,
      tokensOut: delta.tokensOut ?? 0,
      failures: delta.failures ?? 0,
    };
    for (const [key, value] of Object.entries(d)) {
      if (!Number.isFinite(value) || value < 0)
        throw new ValidationError(`${key} must be a non-negative number`);
      if (key !== 'costUsd' && !Number.isInteger(value))
        throw new ValidationError(`${key} must be an integer`);
    }
    if (!this.db.prepare('SELECT 1 FROM pull_requests WHERE id = ?').get(prId)) {
      throw new NotFoundError('pull request', prId);
    }
    this.db
      .prepare(
        `INSERT INTO loop_metrics (pr_id, cost_usd, tokens_in, tokens_out, failures)
         VALUES (@prId, @costUsd, @tokensIn, @tokensOut, @failures)
         ON CONFLICT (pr_id) DO UPDATE SET
           cost_usd = cost_usd + excluded.cost_usd,
           tokens_in = tokens_in + excluded.tokens_in,
           tokens_out = tokens_out + excluded.tokens_out,
           failures = failures + excluded.failures`,
      )
      .run({ prId, ...d });
    return this.get(prId);
  }

  /** Metrics for every PR (zeros where nothing was recorded), optionally for one project. */
  list(filter: { projectId?: number } = {}): LoopMetrics[] {
    const rows =
      filter.projectId === undefined
        ? this.db.prepare<[], MetricsRow>(`${SELECT} ORDER BY p.id`).all()
        : this.db
            .prepare<[number], MetricsRow>(`${SELECT} WHERE p.project_id = ? ORDER BY p.id`)
            .all(filter.projectId);
    return rows.map(toMetrics);
  }
}
