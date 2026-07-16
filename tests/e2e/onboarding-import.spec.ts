/**
 * Journey: first-run onboarding → import → land on the timeline (#445, the
 * flagship journey — USER_FLOWS "First run"). Drives the REAL built app all the
 * way from the welcome screen through creating a library, choosing the WhatsApp
 * source, its guided walkthrough, pointing at a committed export FIXTURE, a live
 * off-thread import, and out onto a populated timeline. Fully offline — the
 * fixture is a text-only chat, so no ffmpeg / model / network is touched.
 */
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  launchKawsay,
  makeLibraryDir,
  startOnboarding,
  enterName,
  driveWhatsAppImportToCompletion,
  landOnTimeline,
  nativeCatalogAvailable,
  NATIVE_DB_SKIP_REASON,
  FIXTURE_MESSAGES,
} from './support/harness';

test.describe.serial('first-run onboarding and import', () => {
  const NAME = 'Grandma';
  let app: ElectronApplication | undefined;
  let page: Page;

  test.beforeAll(async () => {
    test.skip(!(await nativeCatalogAvailable()), NATIVE_DB_SKIP_REASON);
    ({ app, page } = await launchKawsay());
  });

  test.afterAll(async () => {
    if (app !== undefined) await app.close();
  });

  test('welcomes, then walks to the name step', async () => {
    await startOnboarding(page);
    await expect(page.getByRole('heading', { name: 'Who are you honoring?' })).toBeVisible();
  });

  test('creates a library in the chosen folder', async () => {
    await enterName(page, NAME);
    await expect(
      page.getByRole('heading', { name: `Where should we keep ${NAME}'s memories?` }),
    ).toBeVisible();
    await page.getByLabel(`Folder for ${NAME}'s memories`).fill(makeLibraryDir());
    await page.getByRole('button', { name: `Create ${NAME}'s library` }).click();
    // A created library routes into the source picker (its first-run heading).
    await expect(
      page.getByRole('heading', { name: `Where are some of ${NAME}'s memories?` }),
    ).toBeVisible();
  });

  test('imports the WhatsApp export and reports what was gathered', async () => {
    await driveWhatsAppImportToCompletion(page, { name: NAME });
    // The completion face counts the four messages the fixture carries.
    await expect(page.getByText(`4 memories are now in ${NAME}'s library.`)).toBeVisible();
  });

  test('lands on the timeline showing the imported memories', async () => {
    await page.getByRole('button', { name: 'See everything' }).click();
    await landOnTimeline(page, NAME);
    await expect(
      page.getByRole('region', { name: `${NAME}'s memories` }),
    ).toBeVisible();
    // Each imported message is an openable tile (newest-first ordering).
    for (const message of FIXTURE_MESSAGES) {
      await expect(page.getByRole('button', { name: `Open ${message}` })).toBeVisible();
    }
  });
});
