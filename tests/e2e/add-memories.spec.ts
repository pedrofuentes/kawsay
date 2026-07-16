/**
 * Journey: the "Add memories" re-entry (#427 / USER_FLOWS Journey E). After
 * onboarding, a returning user brings in a SECOND source from inside the app —
 * the same guided source → walkthrough → locate → import flow, but hosted in the
 * main shell (sidebar stays; no welcome / naming / privacy intro; no "I'll add
 * this later" escape — the only way out is "Go back" to the timeline).
 */
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  launchKawsay,
  makeLibraryDir,
  completeOnboardingWithImport,
  driveWhatsAppImportToCompletion,
  landOnTimeline,
  nativeCatalogAvailable,
  NATIVE_DB_SKIP_REASON,
  WHATSAPP_MORE_FIXTURE_DIR,
} from './support/harness';

const NAME = 'Grandma';

test.describe.serial('add memories re-entry', () => {
  let app: ElectronApplication | undefined;
  let page: Page;

  test.beforeAll(async () => {
    test.skip(!(await nativeCatalogAvailable()), NATIVE_DB_SKIP_REASON);
    ({ app, page } = await launchKawsay());
    await completeOnboardingWithImport(page, { name: NAME, libraryDir: makeLibraryDir() });
  });

  test.afterAll(async () => {
    if (app !== undefined) await app.close();
  });

  test('re-enters the guided import from the sidebar', async () => {
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Add memories' }).click();

    // The re-entry surface: the source picker retitled "Add memories", WITHOUT the
    // onboarding-only "I'll add this later" escape.
    await expect(page.getByRole('heading', { level: 1, name: 'Add memories' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'WhatsApp chats' })).toBeVisible();
    await expect(page.getByRole('button', { name: "I'll add this later" })).toHaveCount(0);

    // "Go back" is the calm way out, straight to the timeline.
    await page.getByRole('button', { name: 'Go back' }).click();
    await landOnTimeline(page, NAME);
  });

  test('brings a second source into the open library', async () => {
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Add memories' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Add memories' })).toBeVisible();

    await driveWhatsAppImportToCompletion(page, { name: NAME, exportPath: WHATSAPP_MORE_FIXTURE_DIR });
    await expect(page.getByText(`2 memories are now in ${NAME}'s library.`)).toBeVisible();

    await page.getByRole('button', { name: 'See everything' }).click();
    await landOnTimeline(page, NAME);
    // The newly-added memories now sit alongside the original import.
    await expect(
      page.getByRole('button', { name: 'Open We should plant tomatoes this summer' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Open I made your favourite apple pie recipe again' }),
    ).toBeVisible();
  });
});
