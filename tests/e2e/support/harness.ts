/**
 * Shared harness for the Kawsay user-journey e2e suite (#445).
 *
 * Every spec drives the REAL built Electron app (out/main/index.js) through
 * Playwright's `_electron`, exactly like the AC-4 renderer-egress probe: the app
 * is launched with `ELECTRON_RENDERER_URL` unset (so it loads the packaged
 * file:// renderer under the production CSP) and its own bundled Chromium — so no
 * `playwright install` / browser download is ever needed.
 *
 * Determinism + offline (zero-egress) come from three choices:
 *   - Every launch gets a THROWAWAY, per-test `--user-data-dir` under the
 *     git-ignored `test-results/`, so consent stores / caches never leak between
 *     tests or touch a developer's real Kawsay data.
 *   - `KAWSAY_E2E=1` lets a media-free import proceed on any platform (the
 *     packaged app ships ffmpeg/ffprobe only for macOS + Windows; see the hook in
 *     electron/main/index.ts). No model download is ever triggered by these
 *     journeys, so the app stays fully offline — the AC-4 invariant holds.
 *   - The library is created in a per-test temp dir and populated by importing a
 *     tiny committed WhatsApp text-export FIXTURE (messages only — no attachment
 *     bytes, so no ffmpeg/ffprobe/network is exercised), giving deterministic,
 *     assertable memories.
 *
 * The app boots to onboarding on EVERY launch (there is no persisted first-run
 * flag), so each journey scripts through the onboarding step machine with robust
 * role/label selectors (never brittle CSS) and explicit visibility sync points
 * (never arbitrary sleeps).
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

/** Repo root + the built main entry the packaged app boots from (package.json "main"). */
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const mainEntry = fileURLToPath(new URL('../../../out/main/index.js', import.meta.url));

/** The committed WhatsApp export FIXTURE: a folder holding a `_chat.txt` of plain
 *  text messages. Pointing the WhatsApp connector at a folder (rather than a zip)
 *  is a first-class input, and a chat with no attachments produces only `message`
 *  memories — so the import needs no ffmpeg/ffprobe and no network. */
export const WHATSAPP_FIXTURE_DIR = fileURLToPath(
  new URL('../fixtures/whatsapp-export', import.meta.url),
);

/** A SECOND, distinct WhatsApp export FIXTURE (two messages) used to prove the
 *  "Add memories" re-entry brings genuinely new memories into an open library. */
export const WHATSAPP_MORE_FIXTURE_DIR = fileURLToPath(
  new URL('../fixtures/whatsapp-more', import.meta.url),
);

/** The four messages the fixture yields, in the chat order. Newest-first on the
 *  timeline, so index 3 (14 March) is the top tile and index 0 the bottom. */
export const FIXTURE_MESSAGES = [
  'Good morning, sweetheart',
  'The garden roses are blooming beautifully today',
  'I still remember our trip to the lighthouse',
  'I made your favourite apple pie recipe again',
] as const;

export interface KawsayApp {
  app: ElectronApplication;
  page: Page;
  /** The throwaway Electron user-data dir for this launch. */
  userDataDir: string;
}

/**
 * Launch the built app EXACTLY as the packaged run resolves the renderer — with
 * `ELECTRON_RENDERER_URL` unset (production file:// + CSP) — plus `KAWSAY_E2E=1`
 * so a media-free import is permitted offline on any platform.
 */
export async function launchKawsay(): Promise<KawsayApp> {
  mkdirSync(join(projectRoot, 'test-results'), { recursive: true });
  const userDataDir = mkdtempSync(join(projectRoot, 'test-results', 'e2e-user-data-'));

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // electron-vite sets this only under `dev`; unsetting it selects the file://
  // renderer + production CSP — the packaged code path the journeys must exercise.
  delete env['ELECTRON_RENDERER_URL'];
  // Let a media-free import run on Linux CI / an unstaged checkout (see index.ts).
  env['KAWSAY_E2E'] = '1';

  const app = await electron.launch({
    args: [mainEntry, `--user-data-dir=${userDataDir}`],
    env,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('load');
  await expect(page).toHaveTitle('Kawsay');
  // Prove we are on a REAL, mounted renderer (a blank page would pass vacuously).
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return { app, page, userDataDir };
}

/** Make a fresh, empty temp directory to be used as a Kawsay library root. */
export function makeLibraryDir(): string {
  mkdirSync(join(projectRoot, 'test-results'), { recursive: true });
  return mkdtempSync(join(projectRoot, 'test-results', 'e2e-library-'));
}

/**
 * The message a SQLite-backed journey is skipped with when the catalog cannot be
 * opened under Electron. The catalog is `better-sqlite3`, a NATIVE addon: `pnpm
 * install` compiles it against the host Node's ABI, but Electron embeds a
 * different `NODE_MODULE_VERSION`, so `openCatalog` throws unless the module was
 * rebuilt for Electron (`npx @electron/rebuild -v <electron> -o better-sqlite3`).
 * The existing renderer-egress CI job never opens a library, so it does neither —
 * these journeys therefore auto-skip there rather than hard-fail, and RUN wherever
 * the addon matches Electron's ABI. See the PR body for the CI follow-up.
 */
export const NATIVE_DB_SKIP_REASON =
  'better-sqlite3 is not built for this Electron ABI — run `npx @electron/rebuild -v <electron> -o better-sqlite3` (or add an electron-rebuild step to the e2e CI job) to exercise the library-backed journeys';

let nativeDbProbe: Promise<boolean> | undefined;

/**
 * Whether the running Electron build can actually open a Kawsay catalog — probed
 * ONCE (cached) by launching a throwaway app and attempting a real library
 * creation over the IPC bridge. A native-ABI mismatch surfaces as a rejected
 * invoke mentioning `NODE_MODULE_VERSION`; anything else (a genuine bug) is NOT
 * swallowed — it re-throws so a real regression still fails loudly.
 */
export async function nativeCatalogAvailable(): Promise<boolean> {
  nativeDbProbe ??= (async (): Promise<boolean> => {
    const { app, page } = await launchKawsay();
    try {
      const probeDir = makeLibraryDir();
      const outcome = await page.evaluate(async (path): Promise<{ ok: boolean; message: string }> => {
        const bridge = (window as unknown as {
          kawsayAPI: { createLibrary(input: { path: string; personName?: string }): Promise<unknown> };
        }).kawsayAPI;
        try {
          await bridge.createLibrary({ path, personName: 'ABI probe' });
          return { ok: true, message: '' };
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
      }, probeDir);
      if (outcome.ok) return true;
      // Any NATIVE-addon load/ABI failure means the library-backed journeys cannot
      // run here — degrade to a skip (never a hard CI failure). A non-native error
      // (a genuine logic regression) is NOT swallowed: it re-throws and fails loud.
      if (
        /NODE_MODULE_VERSION|was compiled against a different Node\.js|better_sqlite3(\.node)?|dlopen|invalid ELF|\.node['"]?\b/iu.test(
          outcome.message,
        )
      ) {
        return false;
      }
      throw new Error(`unexpected library:create failure during ABI probe: ${outcome.message}`);
    } finally {
      await app.close();
    }
  })();
  return nativeDbProbe;
}

/** The onboarding welcome screen → the name step. */
export async function startOnboarding(page: Page): Promise<void> {
  await expect(
    page.getByRole('heading', { name: /A calm place to gather the memories/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Start bringing memories' }).click();
}

/** Name step → library-location step. */
export async function enterName(page: Page, name: string): Promise<void> {
  await page.getByLabel('Who are you honoring?').fill(name);
  await page.getByRole('button', { name: 'Continue' }).click();
}

/**
 * Drive the WHOLE first-run journey: welcome → name → create library → pick
 * WhatsApp → walkthrough → locate (type the fixture folder) → import → land on
 * the timeline with the imported memories. Returns the library root so a caller
 * can re-open it in a later launch (persistence journeys).
 */
export async function completeOnboardingWithImport(
  page: Page,
  options: { name: string; libraryDir: string; exportPath?: string },
): Promise<{ libraryDir: string }> {
  const { name, libraryDir } = options;
  const exportPath = options.exportPath ?? WHATSAPP_FIXTURE_DIR;

  await startOnboarding(page);
  await enterName(page, name);

  // Library location (create mode is the default).
  await expect(page.getByRole('heading', { name: `Where should we keep ${name}'s memories?` })).toBeVisible();
  await page.getByLabel(`Folder for ${name}'s memories`).fill(libraryDir);
  await page.getByRole('button', { name: `Create ${name}'s library` }).click();

  await driveWhatsAppImportToCompletion(page, { name, exportPath });
  await page.getByRole('button', { name: 'See everything' }).click();
  await landOnTimeline(page, name);
  return { libraryDir };
}

/**
 * Shared tail of both onboarding-import and the Add-memories re-entry: choose the
 * WhatsApp source, acknowledge the walkthrough, point at the export, and wait for
 * the import to finish on the "They're here" completion face. Stops there (does
 * NOT click "See everything") so a caller can assert the completion copy first.
 */
export async function driveWhatsAppImportToCompletion(
  page: Page,
  options: { name: string; exportPath?: string },
): Promise<void> {
  const exportPath = options.exportPath ?? WHATSAPP_FIXTURE_DIR;

  await page.getByRole('button', { name: 'WhatsApp chats' }).click();

  // Walkthrough ("Step 1 of 2") → locate ("Step 2 of 2").
  await expect(page.getByText('Step 1 of 2')).toBeVisible();
  await page.getByRole('button', { name: "I've done this" }).click();

  await expect(page.getByRole('heading', { name: 'Where is the file you saved?' })).toBeVisible();
  await page.getByLabel('Where is the WhatsApp file you saved?').fill(exportPath);
  await page.getByRole('button', { name: `Bring ${options.name}'s memories in` }).click();

  // The import runs off-thread; wait on the deterministic completion heading
  // rather than any timer. A failed resolve would land on "We hit a small snag".
  await expect(page.getByRole('heading', { name: "They're here" })).toBeVisible({ timeout: 30_000 });
}

/** Re-open an existing (already-populated) library and land on its timeline, via
 *  the returning-user onboarding branch and the "I'll add this later" escape. */
export async function openExistingLibrary(
  page: Page,
  options: { name: string; libraryDir: string },
): Promise<void> {
  const { name, libraryDir } = options;
  await startOnboarding(page);
  await enterName(page, name);

  await page.getByRole('button', { name: 'Open a library I already made' }).click();
  await expect(page.getByRole('heading', { name: `Where is ${name}'s library?` })).toBeVisible();
  await page.getByLabel(`Folder where ${name}'s library is`).fill(libraryDir);
  await page.getByRole('button', { name: 'Open this library' }).click();

  // Opening a library still routes through the source picker; take the calm exit
  // straight to the timeline of the memories already gathered.
  await expect(page.getByRole('button', { name: "I'll add this later" })).toBeVisible();
  await page.getByRole('button', { name: "I'll add this later" }).click();
  await landOnTimeline(page, name);
}

/** Wait until the timeline for `name` is mounted (its auto-focused <h1>). */
export async function landOnTimeline(page: Page, name: string): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: `${name}'s timeline` })).toBeVisible();
}

/** The timeline tile (an <article>) whose accessible name contains `caption`. */
export function memoryCard(page: Page, caption: string) {
  return page.getByRole('article', { name: new RegExp(escapeRegExp(caption)) });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
