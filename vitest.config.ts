import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Workspace packages resolve to their sources, so tests never need a build first.
const packagesDir = fileURLToPath(new URL('./packages/', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@loop-engineering\/(.+)$/, replacement: `${packagesDir}$1/src/index.ts` }],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
  },
});
