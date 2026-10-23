import { redirect } from 'next/navigation';
import { safeNextPath } from '../../lib/auth';
import { getAuthConfig, isDemo, noLogin } from '../../lib/server/env';
import { isLoggedIn } from '../../lib/server/session';
import { Logo } from '../../components/logo';
import { LoginForm } from './login-form';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  // DASHBOARD_AUTH=none: there is no login page (the proxy redirects too).
  if (noLogin()) redirect('/');
  if (await isLoggedIn()) redirect(safeNextPath(next));
  const { problem } = getAuthConfig();
  return (
    <main className="login">
      <div className="card login-card">
        <Logo />
        <h1>Loop</h1>
        <p className="muted">Questions, sessions and the PR pipeline.</p>
        {isDemo() && <p className="demo-banner inline">Demo data: no server is connected.</p>}
        {problem ? (
          <p className="error" role="alert">
            {problem}
          </p>
        ) : (
          <LoginForm next={safeNextPath(next)} />
        )}
      </div>
    </main>
  );
}
