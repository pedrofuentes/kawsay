// Setup for the jsdom-backed renderer test project (vitest.config.ts → projects).
// Registers the jest-dom matchers on Vitest's `expect` and unmounts every React
// tree after each test so trees never bleed across cases.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { resetQueryCache } from '@renderer/lib/use-query';

afterEach(() => {
  cleanup();
  // Drop the shared stale-while-revalidate cache so a value retained by one test's
  // useQuery hook never leaks into the next (#443).
  resetQueryCache();
});
