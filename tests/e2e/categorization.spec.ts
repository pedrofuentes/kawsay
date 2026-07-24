/**
 * Journey: AC-32 categorization — organize imported photos into a suggested
 * collection and accept it (USER_FLOWS "Organize", #510). Drives the REAL built
 * app end to end: first-run onboarding → import a folder of GPS-tagged photos →
 * open Settings → opt into categorization → run it with the "Organize now" control
 * → accept the "Shanghai" place suggestion it surfaces → confirm the collection
 * now exists.
 *
 * Fully offline (AC-4): the photos carry EXIF GPS clustered near the committed
 * sample gazetteer's Shanghai entry, so the PLACE path yields a deterministic
 * suggestion with no embedder model and no network. The theme path (which needs
 * the 119 MB model) is deliberately never exercised.
 */
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  launchKawsay,
  makeLibraryDir,
  completeOnboardingWithPhotoImport,
  nativeCatalogAvailable,
  stageGazetteerForE2e,
  NATIVE_DB_SKIP_REASON,
} from './support/harness';

test.describe.serial('categorization: organize photos into a suggested collection', () => {
  const NAME = 'Mateo';
  let app: ElectronApplication | undefined;
  let page: Page;

  test.beforeAll(async () => {
    test.skip(!(await nativeCatalogAvailable()), NATIVE_DB_SKIP_REASON);
    // The place path needs the gazetteer; stage the committed sample where the
    // standalone-launched build resolves it (#510).
    stageGazetteerForE2e();
    ({ app, page } = await launchKawsay());
  });

  test.afterAll(async () => {
    if (app !== undefined) await app.close();
  });

  test('imports a folder of GPS photos and lands on the timeline', async () => {
    await completeOnboardingWithPhotoImport(page, { name: NAME, libraryDir: makeLibraryDir() });
    // The three fixture photos are now openable tiles on the timeline.
    await expect(page.getByRole('region', { name: `${NAME}'s memories` })).toBeVisible();
  });

  test('opts into categorization and runs it from Settings', async () => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();

    // Opt in — the surface is default-off; the switch turns it on.
    const consent = page.getByRole('switch', { name: /organi[sz]e|categor/i });
    await consent.click();
    await expect(consent).toBeChecked();

    // Run it. `startCategorization` awaits the whole run, so the completion face
    // appears once the place path has clustered the three photos into "Shanghai".
    await page.getByRole('button', { name: 'Organize now' }).click();
    await expect(page.getByText(/Done .* Kawsay gathered/)).toBeVisible({ timeout: 60_000 });
  });

  test('surfaces the Shanghai place suggestion live and accepts it', async () => {
    // The tray refetches when the run completes (#510), so the suggestion appears
    // without navigating away — matching the completion copy's promise.
    await expect(page.getByRole('heading', { name: 'Suggested collections' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('textbox', { name: 'Suggested name' })).toHaveValue(/Shanghai/);

    await page.getByRole('button', { name: 'Accept' }).click();

    // Accepting the only suggestion empties the tray (it hides when caught up).
    await expect(page.getByRole('heading', { name: 'Suggested collections' })).toBeHidden();
  });

  test('the accepted collection now exists in Collections', async () => {
    await page.getByRole('button', { name: 'Collections' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Collections' })).toBeVisible();
    // Materialised as a real, openable collection (button aria-label "Open <name>, …").
    await expect(page.getByRole('button', { name: /Open Shanghai/ })).toBeVisible();
  });
});
