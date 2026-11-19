import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 30000, env: { TIKTOK_MAINTENANCE: 'false' }, hookTimeout: 60000, fileParallelism: false },
});
