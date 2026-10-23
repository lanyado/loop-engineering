'use client';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="card error-card" role="alert">
      <h2>Could not load this page</h2>
      <p className="muted">{error.message || 'The server did not answer.'}</p>
      <button type="button" className="primary" onClick={reset}>
        Try again
      </button>
    </section>
  );
}
