import 'server-only';
import { cookies } from 'next/headers';
import { parseTheme, THEME_COOKIE, type Theme } from '../theme';

/** The theme this browser chose, or null to follow the system. */
export async function savedTheme(): Promise<Theme | null> {
  return parseTheme((await cookies()).get(THEME_COOKIE)?.value);
}
