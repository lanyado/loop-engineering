export type BackendConfig =
  { kind: 'demo' } | { kind: 'http'; serverUrl: string; token: string } | { kind: 'broken'; problem: string };

/** Demo mode exactly when SERVER_URL is unset; a set URL needs DASHBOARD_TOKEN too. */
export function backendConfig(env: Record<string, string | undefined>): BackendConfig {
  const serverUrl = env.SERVER_URL?.trim();
  if (!serverUrl) return { kind: 'demo' };
  const token = env.DASHBOARD_TOKEN?.trim();
  if (!token) return { kind: 'broken', problem: 'SERVER_URL is set but DASHBOARD_TOKEN is not.' };
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return { kind: 'broken', problem: 'SERVER_URL must be an http(s) URL.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { kind: 'broken', problem: 'SERVER_URL must be an http(s) URL.' };
  }
  return { kind: 'http', serverUrl, token };
}
