/** The viewer's colour scheme, kept in a per-browser cookie. */

export const THEME_COOKIE = 'loop-theme';

export type Theme = 'light' | 'dark';

/** A stored or submitted theme; anything else (including "system") means follow the system. */
export function parseTheme(value: unknown): Theme | null {
  return value === 'light' || value === 'dark' ? value : null;
}
