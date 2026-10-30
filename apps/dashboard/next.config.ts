import type { NextConfig } from 'next';

const config: NextConfig = {
  // The build type-checks app code only; tests and e2e specs are checked by `npm run typecheck`.
  typescript: { tsconfigPath: 'tsconfig.next.json' },
  poweredByHeader: false,
  // Prompts can carry attached files (up to 5 x 5 MB, sent as base64 in the action call). The limit
  // covers every server action, the login one too: the price of not adding a separate upload route.
  experimental: { serverActions: { bodySizeLimit: '40mb' } },
  // The old tabs are one screen now (the board at /); keep their links working.
  redirects: () =>
    Promise.resolve(
      ['/tree', '/prs', '/metrics', '/settings', '/new'].map((source) => ({
        source,
        destination: '/',
        permanent: false,
      })),
    ),
  headers: () =>
    Promise.resolve([
      {
        source: '/:path*',
        headers: [
          // No framing (clickjacking) and no Referer leaving the dashboard, in both auth modes.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ]),
};

export default config;
