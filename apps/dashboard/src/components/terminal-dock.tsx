'use client';

import { useEffect, useState, useTransition } from 'react';
import { webTerminalUrl } from '../app/actions';
import type { TerminalTab } from '../lib/terminal-tabs';

type Loaded = { url: string } | { error: string };

/**
 * The pipeline's terminals under its row: a tab per agent (the Builder's live window, each stage's log)
 * and the chosen one embedded. A terminal is only started when its tab is opened. The page comes from
 * ttyd on the server's Mac, so it shows where the dashboard runs on that same machine.
 */
export function TerminalDock({ tabs, readOnly }: { tabs: TerminalTab[]; readOnly: boolean }) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [pending, start] = useTransition();
  // Bumped by Reconnect / Try again, so the effect fetches again for the same tab.
  const [reloads, setReloads] = useState(0);
  const active = tabs.find((t) => t.id === chosen) ?? tabs[0];
  const activeId = active?.id;
  const result = activeId ? loaded[activeId] : undefined;

  useEffect(() => {
    if (!open || !active || readOnly || loaded[active.id]) return;
    const id = active.id;
    const put = (r: Loaded) => setLoaded((m) => ({ ...m, [id]: r }));
    start(async () => {
      try {
        const r = await webTerminalUrl(active.target);
        put(r.ok && r.message ? { url: r.message } : { error: r.ok ? 'No terminal' : r.error });
      } catch {
        put({ error: 'Could not reach the dashboard. Reload the page and try again.' });
      }
    });
    // `loaded` is read only to skip tabs already fetched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeId, readOnly, reloads]);

  if (tabs.length === 0) return null;
  const retry = () => {
    setLoaded((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== activeId)));
    setReloads((n) => n + 1);
  };
  return (
    <section className={`dock${open ? ' open' : ''}`} data-testid="terminal-dock" aria-label="Terminals">
      <button
        type="button"
        className="dock-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="terminal-dock-toggle"
      >
        <span className="dock-prompt" aria-hidden="true">
          {'>_'}
        </span>
        Terminals
        <span className="dock-count">{tabs.length}</span>
        <span className="dock-chevron" aria-hidden="true" />
      </button>
      {open && active && (
        <div className="dock-body">
          <div className="dock-tabs" role="tablist" aria-label="Pipeline terminals">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === active.id}
                className={`dock-tab${t.id === active.id ? ' on' : ''}`}
                onClick={() => setChosen(t.id)}
                data-testid="terminal-tab"
              >
                <span className={`dock-dot state-${t.state}`} aria-hidden="true" />
                {t.group && <span className="dock-group">{t.group}</span>}
                {t.label}
                {t.live && <span className="dock-live">live</span>}
              </button>
            ))}
            <span className="grow" />
            {result && 'url' in result && (
              <>
                <button type="button" className="dock-tool" onClick={retry} title="Reconnect">
                  ↻
                </button>
                <a
                  className="dock-tool"
                  href={result.url}
                  target="_blank"
                  rel="noreferrer"
                  title="Open in its own tab"
                >
                  ↗
                </a>
              </>
            )}
          </div>
          <div className="dock-screen">
            {readOnly ? (
              <p className="dock-note">Terminals are not available in the read-only demo.</p>
            ) : result && 'url' in result ? (
              <iframe
                key={`${active.id}-${result.url}`}
                title={`${active.label} terminal`}
                src={result.url}
                className="dock-frame"
              />
            ) : result ? (
              <div className="dock-note" role="alert">
                {result.error}
                <button type="button" onClick={retry}>
                  Try again
                </button>
              </div>
            ) : (
              <p className="dock-note">{pending ? 'Starting terminal…' : ''}</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
