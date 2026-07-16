/**
 * Journeys: open a memory on its own view (USER_FLOWS Journey B/#136), ←/→
 * navigation between memories (Journey F/#434), and the favourite toggle with
 * persistence across an app restart (#434). Runs against a real, freshly-imported
 * library so every memory is genuine catalog data read back over IPC.
 *
 * The four fixture messages are all in March 2023, newest-first on the timeline:
 *   index 0 (newest) "…apple pie…"  ← no "Previous" neighbour
 *   index 1          "…lighthouse…"
 *   index 2          "…roses…"
 *   index 3 (oldest) "Good morning…" ← no "Next" neighbour
 * The Prev/Next boundary buttons therefore prove WHERE arrow-nav has landed,
 * locale-independently (ItemView shows only the "Message" type heading + a
 * locale-formatted date, so neither uniquely identifies a memory).
 */
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  launchKawsay,
  makeLibraryDir,
  completeOnboardingWithImport,
  openExistingLibrary,
  landOnTimeline,
  memoryCard,
  nativeCatalogAvailable,
  NATIVE_DB_SKIP_REASON,
} from './support/harness';

const NAME = 'Grandma';
const NEWEST = 'I made your favourite apple pie recipe again';

test.describe.serial('open a memory, arrow-navigate, and favourite it', () => {
  let app: ElectronApplication | undefined;
  let page: Page;
  let libraryDir: string;

  test.beforeAll(async () => {
    test.skip(!(await nativeCatalogAvailable()), NATIVE_DB_SKIP_REASON);
    ({ app, page } = await launchKawsay());
    libraryDir = makeLibraryDir();
    await completeOnboardingWithImport(page, { name: NAME, libraryDir });
  });

  test.afterAll(async () => {
    if (app !== undefined) await app.close();
  });

  test('opens a memory on its own view and steps through with ←/→', async () => {
    await page.getByRole('button', { name: `Open ${NEWEST}` }).click();

    await test.step('lands on the memory (newest — no Previous neighbour)', async () => {
      await expect(page.getByRole('button', { name: 'Back' })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1, name: 'Message' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Next' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Previous' })).toHaveCount(0);
    });

    await test.step('ArrowRight advances to the next memory', async () => {
      await page.keyboard.press('ArrowRight');
      await expect(
        page.getByText('Now showing the next memory: Message.'),
      ).toBeAttached();
      // Off the newest boundary now, so a Previous neighbour exists.
      await expect(page.getByRole('button', { name: 'Previous' })).toBeVisible();
    });

    await test.step('ArrowRight reaches the oldest memory (no Next neighbour)', async () => {
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await expect(page.getByRole('button', { name: 'Previous' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Next' })).toHaveCount(0);
    });

    await test.step('ArrowLeft steps back toward newer memories', async () => {
      await page.keyboard.press('ArrowLeft');
      await expect(
        page.getByText('Now showing the previous memory: Message.'),
      ).toBeAttached();
      await expect(page.getByRole('button', { name: 'Next' })).toBeVisible();
    });

    await page.getByRole('button', { name: 'Back' }).click();
    await landOnTimeline(page, NAME);
  });

  test('marks the newest memory as a favourite', async () => {
    await page.getByRole('button', { name: `Open ${NEWEST}` }).click();
    const toggle = page.getByRole('button', { name: 'Mark as favourite' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();

    // The heart flips and, once the catalog:setFavourite save settles, the toggle
    // re-enables — proof it persisted, not merely an optimistic flip.
    const marked = page.getByRole('button', { name: 'Remove from favourites' });
    await expect(marked).toHaveAttribute('aria-pressed', 'true');
    await expect(marked).toBeEnabled();

    await page.getByRole('button', { name: 'Back' }).click();
    await landOnTimeline(page, NAME);
  });

  test('the favourite survives an app restart (persisted to the library)', async () => {
    // A brand-new process with a fresh user-data dir, re-opening the SAME library
    // folder — so anything read back came from the on-disk catalog, not memory.
    if (app !== undefined) await app.close();
    ({ app, page } = await launchKawsay());
    await openExistingLibrary(page, { name: NAME, libraryDir });

    // The timeline tile reads is_favourite from the reopened catalog and shows the
    // heart, and the memory opens already-favourited.
    await expect(memoryCard(page, NEWEST).getByRole('img', { name: 'Favourite' })).toBeVisible();
    await page.getByRole('button', { name: `Open ${NEWEST}` }).click();
    await expect(page.getByRole('button', { name: 'Remove from favourites' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
