// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The sync engine binds window, document.visibilityState and navigator.onLine,
    // so it needs a DOM. Node's default environment has none of them.
    environment: 'jsdom',
    setupFiles:  ['./vitest.setup.ts'],
    include:     ['utils/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
