import { fileURLToPath } from 'node:url';
import { coverageConfigDefaults, defineConfig } from 'vitest/config';

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
    // Coverage aggregates across both projects below. The DoD bar is ≥80%
    // (AGENTS.md Ratchet, docs/SENTINEL.md §Coverage); thresholds fail the run
    // if it regresses. v8 is the native, zero-instrumentation provider.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      // The shipped TypeScript: main-process, preload, shared contract, renderer.
      include: ['electron/**/*.{ts,tsx}', 'shared/**/*.{ts,tsx}', 'src/**/*.{ts,tsx}'],
      exclude: [
        ...coverageConfigDefaults.exclude,
        // Ambient/type-only declarations carry no executable lines.
        '**/*.d.ts',
        // Process entry/bootstrap glue: imports Electron/DOM globals and wires
        // singletons at module load, so it cannot run under vitest/jsdom. Each
        // collaborator it composes is unit-tested in isolation.
        'electron/main/index.ts', // main-process entry (app/BrowserWindow bootstrap)
        'electron/preload/index.ts', // preload bootstrap (contextBridge.exposeInMainWorld)
        'electron/main/importers/workers/ingestion-worker.ts', // worker_threads entry
        'src/main.tsx', // React renderer bootstrap (createRoot)
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
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
