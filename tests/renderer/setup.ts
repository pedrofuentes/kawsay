// Setup for the jsdom-backed renderer test project (vitest.config.ts → projects).
// Registers the jest-dom matchers on Vitest's `expect` and unmounts every React
// tree after each test so trees never bleed across cases.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
