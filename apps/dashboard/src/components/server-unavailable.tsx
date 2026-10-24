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
  // 503: the request never reached the server (http-backend.ts); anything else is the server's answer.
  const down = error.status === 503;
  return (
    <section className="card error-card" role="alert" data-testid="server-unavailable">
      <h2>
        {refused
          ? 'The server refused the dashboard'
          : down
            ? 'The server is not answering'
            : 'The server had a problem'}
      </h2>
      <p className="muted">
        {refused
          ? 'Its DASHBOARD_TOKEN does not match the one in .env. Run npm run setup, then restart npm start.'
          : down
            ? `The dashboard cannot reach the Loop server (${error.message}). Is it running? Start it with npm start.`
            : `It answered: ${error.message}. Its log says more.`}
      </p>
      <div className="row-actions">
        {/* A full page load, so the server is asked again. */}
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
