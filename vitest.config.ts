import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests cover pure logic (IPC validation, handlers, security helpers) and
// run in a Node environment with no Electron runtime — Electron is imported
// type-only in the modules under test, so it is erased before execution.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
