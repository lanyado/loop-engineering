import Link from 'next/link';

/** What the board and the editor show when the server does not answer (Next hides thrown messages). */
export function ServerUnavailable({ message }: { message: string }) {
  return (
    <section className="card error-card" role="alert" data-testid="server-unavailable">
      <h2>The server is not answering</h2>
      <p className="muted">
        The dashboard cannot reach the Loop server ({message}). Is it running? Start it with{' '}
        <code>npm start</code>.
      </p>
      <Link href="/" className="button primary">
        Try again
      </Link>
    </section>
  );
}
