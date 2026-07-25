import { defineConfig } from 'vitest/config';

// Plain vitest over pure functions, not @cloudflare/vitest-pool-workers — see
// worker/README.md "Testing" section for why. Nothing under test touches a
// D1 binding directly; the D1-touching code in src/db.ts, src/scheduled.ts,
// and src/routes/* is exercised instead by the end-to-end curl transcript
// against `wrangler dev` in the verification report.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
