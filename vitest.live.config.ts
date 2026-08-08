import { defineConfig } from 'vitest/config';

/**
 * The LIVE smoke suite. Deliberately NOT part of `npm test`.
 *
 * These tests open real sockets to the public internet: the Radio Browser API
 * and a handful of real stations. They therefore fail for reasons that have
 * nothing to do with this codebase — a station retires, a mirror reboots, a
 * cafe wifi captive portal intercepts port 80. That is acceptable for a smoke
 * check and completely unacceptable for a gate on `npm test`, which is why the
 * two suites live under separate configs and separate directories.
 *
 * Run with: npm run test:live
 */
export default defineConfig({
  test: {
    include: ['test/live/**/*.test.ts'],
    environment: 'node',
    // Real networks are slow and retry; give them room.
    testTimeout: 45_000,
    hookTimeout: 45_000,
    // Serial, to be a polite client of a free community API.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    reporters: ['default'],
  },
});
