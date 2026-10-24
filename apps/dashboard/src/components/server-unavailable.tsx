import Link from 'next/link';
import { BackendError } from '../lib/backend';

/** For `.catch()` on a page's loads: a BackendError becomes the value to show, anything else is thrown. */
export function backendFailure(error: unknown): BackendError {
  if (error instanceof BackendError) return error;
  throw error;
}

/** What a page shows when the server does not answer or refuses it (Next hides thrown messages). */
export function ServerUnavailable({ error, path }: { error: BackendError; path: string }) {
  const refused = error.status === 401 || error.status === 403;
  return (
    <section className="card error-card" role="alert" data-testid="server-unavailable">
      <h2>{refused ? 'The server refused the dashboard' : 'The server is not answering'}</h2>
      <p className="muted">
        {refused
          ? 'Its DASHBOARD_TOKEN does not match the one in .env. Run npm run setup, then restart npm start.'
          : `The dashboard cannot reach the Loop server (${error.message}). Is it running? Start it with npm start.`}
      </p>
      <div className="row-actions">
        <a href={path} className="button primary">
          Try again
        </a>
        {path !== '/' && (
          <Link href="/" className="button ghost">
            Back to the board
          </Link>
        )}
      </div>
    </section>
  );
}
