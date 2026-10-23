import type { Database } from 'better-sqlite3';
import { NotFoundError } from './errors.js';

export type Db = Database;

export const toBool = (v: number): boolean => v === 1;
export const fromBool = (v: boolean | undefined): number | undefined =>
  v === undefined ? undefined : v ? 1 : 0;
export const parseJson = <T>(v: string): T => JSON.parse(v) as T;
export const toJson = (v: unknown): string | undefined => (v === undefined ? undefined : JSON.stringify(v));

/**
 * UPDATE `table` SET <defined columns> WHERE id = ?. Column names come from repository code,
 * never from callers, so interpolating them is safe. Throws NotFoundError when no row matches.
 */
export function updateById(
  db: Db,
  table: string,
  entity: string,
  id: number,
  columns: Record<string, unknown>,
): void {
  const set = Object.entries(columns).filter(([, v]) => v !== undefined);
  if (set.length === 0) {
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) throw new NotFoundError(entity, id);
    return;
  }
  const sql = `UPDATE ${table} SET ${set.map(([c]) => `${c} = @${c}`).join(', ')} WHERE id = @id`;
  const info = db.prepare(sql).run({ ...Object.fromEntries(set), id });
  if (info.changes === 0) throw new NotFoundError(entity, id);
}

export function deleteById(db: Db, table: string, id: number): boolean {
  return db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes > 0;
}

/**
 * Builds "WHERE a = @a AND b IN (...)" from the defined filters (undefined is skipped, null means
 * IS NULL), plus any fixed SQL conditions written by repository code.
 */
export function where(
  filters: Record<string, unknown>,
  conditions: string[] = [],
): { clause: string; params: Record<string, unknown> } {
  const parts: string[] = [];
  const params: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    const key = column.replace(/\W/g, '_');
    if (Array.isArray(value)) {
      if (value.length === 0) {
        parts.push('0');
        continue;
      }
      const names = value.map((v: unknown, i) => {
        params[`${key}_${i}`] = v;
        return `@${key}_${i}`;
      });
      parts.push(`${column} IN (${names.join(', ')})`);
    } else if (value === null) {
      parts.push(`${column} IS NULL`);
    } else {
      params[key] = value;
      parts.push(`${column} = @${key}`);
    }
  }
  parts.push(...conditions);
  return { clause: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}
