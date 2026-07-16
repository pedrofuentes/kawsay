/**
 * Journey: search (USER_FLOWS Journey C / U2). From a populated library, open the
 * Search section from the sidebar, look for a memory by a few plain words, and
 * open the match. Search runs entirely on-device over the catalog (exact FTS) —
 * no network, no model needed.
 */
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  launchKawsay,
  makeLibraryDir,
  completeOnboardingWithImport,
  nativeCatalogAvailable,
  NATIVE_DB_SKIP_REASON,
} from './support/harness';

const NAME = 'Grandma';

test.describe.serial('search the gathered memories', () => {
  let app: ElectronApplication | undefined;
  let page: Page;

  test.beforeAll(async () => {
    test.skip(!(await nativeCatalogAvailable()), NATIVE_DB_SKIP_REASON);
    ({ app, page } = await launchKawsay());
    await completeOnboardingWithImport(page, { name: NAME, libraryDir: makeLibraryDir() });
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Search' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Search' })).toBeVisible();
  });

  test.afterAll(async () => {
    if (app !== undefined) await app.close();
  });

  test('starts empty, inviting a query', async () => {
    await expect(page.getByRole('searchbox')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Start typing to search' })).toBeVisible();
  });

  test('finds the one memory that mentions a word and opens it', async () => {
    await page.getByRole('searchbox').fill('lighthouse');
    await expect(page.getByRole('status')).toHaveText(/1 memory found/);

    const result = page.getByRole('button', { name: 'Open I still remember our trip to the lighthouse' });
    await expect(result).toBeVisible();
    await result.click();

    // Opening a search result lands on that memory's own view.
    await expect(page.getByRole('heading', { level: 1, name: 'Message' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back' })).toBeVisible();
  });

  test('reports plainly when nothing matches', async () => {
    // Back to Search, then a query that matches no memory.
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Search' }).click();
    await page.getByRole('searchbox').fill('zzznowaymatch');
    await expect(page.getByRole('status')).toHaveText(/No memories found/);
    await expect(
      page.getByRole('heading', { name: /We couldn.t find anything/ }),
    ).toBeVisible();
  });
});
