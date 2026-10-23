export function dashboardHost(env: Record<string, string | undefined>): string;
export function isLoopbackHost(host: string): boolean;
export function accessConfig(env: Record<string, string | undefined>): {
  mode: 'none' | 'password' | null;
  problem: string | null;
};
