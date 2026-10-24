import Link from 'next/link';
import type { ReactNode } from 'react';
import { LiveUpdates } from '../../components/live-updates';
import { Logo } from '../../components/logo';
import { BackupModels, ModelField, ProviderSwitches, ThemeSwitch } from '../../components/settings-controls';
import { UsageMeters } from '../../components/usage-meters';
import { noLogin } from '../../lib/server/env';
import { formatClock } from '../../lib/format';
import { requestTime } from '../../lib/server/clock';
import { backendForViewer } from '../../lib/server/session';
import { savedTheme } from '../../lib/server/theme';
import { logout } from '../actions';

// Live data on every request; nothing here may be prerendered at build time.
export const dynamic = 'force-dynamic';

/**
 * One screen, no tabs: the top bar holds Claude's usage limits and the settings shared by every
 * project; the page under it is the board of pipelines. A new session is started from the
 * "+ Session" button in a project's header, not from the top bar.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const backend = await backendForViewer();
  const [usage, settings, offlineSince, theme] = await Promise.all([
    backend.usage().catch(() => null),
    backend.settings().catch(() => null),
    // Null also when the loop is off (the server answers 503): no banner then.
    backend.offlineSince().catch(() => null),
    savedTheme(),
  ]);
  const readOnly = backend.demo;
  return (
    <div className="app">
      <header className="topbar">
        <Link href="/" className="brand">
          <Logo />
          Loop
        </Link>
        <LiveUpdates demo={backend.demo} />
        <UsageMeters usage={usage} now={requestTime()} />
        <div className="topbar-actions">
          <details className="sheet" data-testid="settings-sheet">
            <summary className="button ghost small icon-button" aria-label="Settings for every project">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
              </svg>
            </summary>
            <div className="sheet-panel stack">
              <ThemeSwitch theme={theme} />
              <h2>Every project</h2>
              {settings ? (
                <>
                  <ProviderSwitches
                    claude={settings.claudeEnabled}
                    opencode={settings.opencodeEnabled}
                    readOnly={readOnly}
                  />
                  <ModelField
                    key={`s-${settings.sessionModel}`}
                    field="sessionModel"
                    label="Session model"
                    hint="Main sessions run on this model (the strongest)."
                    value={settings.sessionModel}
                    readOnly={readOnly}
                  />
                  <ModelField
                    key={`f-${settings.fallbackModel}`}
                    field="fallbackModel"
                    label="Fallback model"
                    hint="Used when Claude usage runs out, with the same rights."
                    value={settings.fallbackModel}
                    readOnly={readOnly}
                  />
                  <BackupModels
                    key={`b-${settings.opencodeBackupModels.join(',')}`}
                    models={settings.opencodeBackupModels}
                    readOnly={readOnly}
                  />
                </>
              ) : (
                <p className="muted small" data-testid="settings-unavailable">
                  Server settings are unavailable right now.
                </p>
              )}
              <p className="muted small">
                Each project&apos;s own settings are behind the slider icon in its header.
              </p>
              {!noLogin() && (
                <form action={logout}>
                  <button type="submit" className="ghost small">
                    Log out
                  </button>
                </form>
              )}
            </div>
          </details>
        </div>
      </header>
      {backend.demo && (
        <p className="demo-banner" data-testid="demo-banner">
          Demo data · read-only. Set SERVER_URL and DASHBOARD_TOKEN to connect the real server.
        </p>
      )}
      {offlineSince && (
        <p className="offline-banner" data-testid="offline-banner">
          Offline since {formatClock(offlineSince)}, the loop is paused
        </p>
      )}
      <main className="content">{children}</main>
    </div>
  );
}
