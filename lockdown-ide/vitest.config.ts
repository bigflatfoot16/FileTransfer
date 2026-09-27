import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so unit tests don't start Electron.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
