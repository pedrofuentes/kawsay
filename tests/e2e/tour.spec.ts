/**
 * Journey: the "Show me around first" welcome tour (#434 / USER_FLOWS "Returning
 * user"). A calm, skippable 3-card preview reachable from the welcome screen;
 * both finishing and skipping land in the main app on the timeline. No library is
 * created on this path, so the tour is asserted purely on its own navigation.
 */
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchKawsay } from './support/harness';

test.describe.serial('welcome tour', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    ({ app, page } = await launchKawsay());
  });

  test.afterEach(async () => {
    await app.close();
  });

  test('walks the three cards through to the timeline', async () => {
    await expect(
      page.getByRole('heading', { name: /A calm place to gather the memories/ }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Show me around first' }).click();

    await expect(page.getByText('Step 1 of 3')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'The timeline is where every memory gathers' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();

    await expect(page.getByText('Step 2 of 3')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: "Add memories whenever you're ready" }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();

    await expect(page.getByText('Step 3 of 3')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Nothing ever leaves this computer' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Take me to the timeline' }).click();

    // Both finishing and skipping land in the main app (the timeline section).
    await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
  });

  test('can be skipped from the first card', async () => {
    await page.getByRole('button', { name: 'Show me around first' }).click();
    await expect(page.getByText('Step 1 of 3')).toBeVisible();
    await page.getByRole('button', { name: 'Skip tour' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
  });
});
