import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { savedTheme } from '../lib/server/theme';
import './globals.css';

export const metadata: Metadata = {
  title: 'Loop',
  description: 'Loop Engineering dashboard: questions, sessions, PR pipeline, settings.',
  robots: { index: false, follow: false },
};

// The browser chrome colour: the same as --bg in globals.css, light and dark.
const THEME_COLOR = { light: '#f5f6f8', dark: '#0c0e12' };

export async function generateViewport(): Promise<Viewport> {
  const theme = await savedTheme();
  return {
    width: 'device-width',
    initialScale: 1,
    viewportFit: 'cover',
    themeColor: theme
      ? THEME_COLOR[theme]
      : [
          { media: '(prefers-color-scheme: light)', color: THEME_COLOR.light },
          { media: '(prefers-color-scheme: dark)', color: THEME_COLOR.dark },
        ],
  };
}

// The theme is on <html> from the first byte, so a chosen theme never flashes the system one.
export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = await savedTheme();
  return (
    <html lang="en" data-theme={theme ?? undefined}>
      <body>{children}</body>
    </html>
  );
}
