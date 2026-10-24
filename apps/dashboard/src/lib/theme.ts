/** The viewer's colour scheme: a per-browser cookie, so it works in read-only demo mode too. */

export const THEME_COOKIE = 'loop-theme';
export const THEME_MAX_AGE_S = 365 * 24 * 60 * 60;
export const THEME_OPTIONS = ['system', 'light', 'dark'] as const;

export type Theme = 'light' | 'dark';
export type ThemeOption = (typeof THEME_OPTIONS)[number];

/** A stored or submitted theme; anything else (including "system") means follow the system. */
export function parseTheme(value: unknown): Theme | null {
  return value === 'light' || value === 'dark' ? value : null;
}
