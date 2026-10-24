import { ValidationError } from '../errors.js';
import { fromBool, parseJson, toBool, toJson, type Db } from '../sql.js';
import type { Settings } from '../types.js';

interface SettingsRow {
  session_model: string;
  fallback_model: string;
  telegram_allowlist: string;
  claude_enabled: number;
  opencode_enabled: number;
  opencode_backup_models: string;
  dashboard_layout: string;
}

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  get(): Settings {
    const row = this.db.prepare<[], SettingsRow>('SELECT * FROM settings WHERE id = 1').get();
    if (!row) throw new Error('settings row missing; was the database migrated?');
    return {
      sessionModel: row.session_model,
      fallbackModel: row.fallback_model,
      telegramAllowlist: parseJson<number[]>(row.telegram_allowlist),
      claudeEnabled: toBool(row.claude_enabled),
      opencodeEnabled: toBool(row.opencode_enabled),
      opencodeBackupModels: parseJson<string[]>(row.opencode_backup_models),
      dashboardLayout: parseJson<Record<string, unknown>>(row.dashboard_layout),
    };
  }

  /** The router's reserved session for routing questions (see migration 7); null until it makes one. */
  getRouterSessionId(): number | null {
    const row = this.db
      .prepare<[], { router_session_id: number | null }>(
        'SELECT router_session_id FROM settings WHERE id = 1',
      )
      .get();
    return row?.router_session_id ?? null;
  }

  setRouterSessionId(sessionId: number | null): void {
    this.db.prepare('UPDATE settings SET router_session_id = ? WHERE id = 1').run(sessionId);
  }

  update(patch: Partial<Settings>): Settings {
    if (patch.fallbackModel !== undefined && patch.fallbackModel.trim() === '') {
      throw new ValidationError('fallbackModel must not be empty');
    }
    if (patch.sessionModel !== undefined && patch.sessionModel.trim() === '') {
      throw new ValidationError('sessionModel must not be empty');
    }
    if (patch.telegramAllowlist?.some((id) => !Number.isSafeInteger(id))) {
      throw new ValidationError('telegramAllowlist must contain integer Telegram user IDs');
    }
    if (patch.opencodeBackupModels?.some((m) => m.trim() === '' || /\s/.test(m.trim()))) {
      throw new ValidationError('opencodeBackupModels must be model names like opencode/big-pickle');
    }
    const current = this.get();
    if (
      !(patch.claudeEnabled ?? current.claudeEnabled) &&
      !(patch.opencodeEnabled ?? current.opencodeEnabled)
    ) {
      throw new ValidationError('keep Claude Code or OpenCode on: the loop needs one of them');
    }
    const allowlist = patch.telegramAllowlist && [...new Set(patch.telegramAllowlist)];
    const columns = {
      session_model: patch.sessionModel,
      fallback_model: patch.fallbackModel,
      telegram_allowlist: toJson(allowlist),
      claude_enabled: fromBool(patch.claudeEnabled),
      opencode_enabled: fromBool(patch.opencodeEnabled),
      dashboard_layout: toJson(patch.dashboardLayout),
      opencode_backup_models: toJson(
        patch.opencodeBackupModels && [...new Set(patch.opencodeBackupModels.map((m) => m.trim()))],
      ),
    };
    const set = Object.entries(columns).filter(([, v]) => v !== undefined);
    if (set.length > 0) {
      this.db
        .prepare(`UPDATE settings SET ${set.map(([c]) => `${c} = @${c}`).join(', ')} WHERE id = 1`)
        .run(Object.fromEntries(set));
    }
    return this.get();
  }
}
