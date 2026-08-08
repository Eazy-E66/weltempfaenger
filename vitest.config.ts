import { defineConfig } from 'vitest/config';

/**
 * The deterministic suite. Everything here runs with the network cable pulled:
 * playlists come from real files under test/fixtures, and the servers that
 * serve them are spun up in-process on ephemeral ports. `test/live` is excluded
 * on purpose — see vitest.live.config.ts.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/live/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Local HTTP servers on ephemeral ports; no shared state between files.
    pool: 'forks',
    reporters: ['default'],
  },
});
