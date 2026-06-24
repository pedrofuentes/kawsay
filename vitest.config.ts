import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const shared = fileURLToPath(new URL('./shared', import.meta.url));
const renderer = fileURLToPath(new URL('./src', import.meta.url));

// Two test projects share one alias map (extends: true).
//   • `node`     — the existing main/preload/shared suites; pure logic (IPC
//                  validation, handlers, security helpers) on a Node runtime,
//                  with Electron imported type-only so it is erased before run.
//   • `renderer` — the React component/unit tests on jsdom, with Testing Library
//                  matchers + auto-cleanup wired through tests/renderer/setup.ts.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': shared,
      '@renderer': renderer,
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['tests/**/*.test.tsx'],
          setupFiles: ['./tests/renderer/setup.ts'],
        },
      },
    ],
  },
});
