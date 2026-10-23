'use client';

import { useActionState } from 'react';
import { login, type LoginState } from '../actions';

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, { error: null });
  return (
    <form action={action} className="stack">
      <input type="hidden" name="next" value={next} />
      <label className="field">
        <span>Password</span>
        <input type="password" name="password" autoComplete="current-password" required autoFocus />
      </label>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <button type="submit" className="primary" disabled={pending}>
        {pending ? 'Checking…' : 'Log in'}
      </button>
    </form>
  );
}
