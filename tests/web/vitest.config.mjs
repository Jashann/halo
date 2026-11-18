import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
  },
});
