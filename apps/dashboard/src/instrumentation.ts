/** Runs once when the Next server starts: refuses an unsafe access setup (see lib/access). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // The build also loads this file; the runtime environment is what counts.
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  // `npm run dev|start` (scripts/serve.mjs) refuses before Next starts; this catches any other
  // launch (`npx next start -H 0.0.0.0`, a bare `next start`), judged on the socket really bound.
  const { refuseUnsafeStart } = await import('./lib/server/startup');
  refuseUnsafeStart(process.env);
}
