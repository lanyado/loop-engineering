/** Ports and throwaway secrets shared by playwright.config.ts and the specs. */
export const E2E = {
  password: 'e2e-dashboard-password-0001',
  sessionSecret: 'e2e-session-secret-0000000000000000000000000001',
  dashboardToken: 'e2e-dashboard-token-0000000001',
  mcpToken: 'e2e-mcp-token-000000000000000001',
  serverPort: 3102,
  demoPort: 3101,
  livePort: 3103,
  /** Demo data with DASHBOARD_AUTH=password, so the login path stays covered. */
  passwordPort: 3104,
  get serverUrl() {
    return `http://127.0.0.1:${this.serverPort}`;
  },
  get demoUrl() {
    return `http://localhost:${this.demoPort}`;
  },
  get liveUrl() {
    return `http://localhost:${this.livePort}`;
  },
  get passwordUrl() {
    return `http://localhost:${this.passwordPort}`;
  },
};
