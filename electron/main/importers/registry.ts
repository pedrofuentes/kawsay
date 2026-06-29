import type { Importer, ImporterDeps } from './types';
import { folderImporter } from './folder-importer';
import { whatsappImporter } from './whatsapp-importer';
import { messengerImporter } from './messenger-importer';
import { facebookImporter } from './facebook-importer';
import { linkedinImporter } from './linkedin-importer';
import { imessageImporter } from './imessage-importer';
import { telegramImporter } from './telegram-importer';
import { takeoutImporter } from './takeout-importer';

/**
 * The ordered list of concrete connectors the ingestion worker can run
 * (ARCHITECTURE §3.4). Registration order IS resolution order: {@link
 * selectImporter} returns the FIRST importer whose `canHandle` accepts the
 * dropped path, and `beginImport` (catalog-session) likewise resolves a chosen
 * `sourceType` by `id` from this same array — so a connector is only reachable
 * from `import:start` once it is listed here.
 *
 * Order is by SPECIFICITY, most specific first, because the first match wins:
 *
 * - `whatsapp` claims only on its unique `_chat.txt` marker (a `.zip`
 *   central-directory byte-scan, or that file inside an unpacked folder).
 * - `messenger` claims Facebook Messenger thread exports by shape before the
 *   broader Facebook DYI connector sees the same Meta archive.
 * - `facebook` / `linkedin` claim only on their distinctive named export markers
 *   (Facebook activity/messages/posts paths; LinkedIn `Connections.csv` /
 *   `messages.csv` / `Rich_Media.csv`). They precede `takeout` so an export whose
 *   root also happens to carry a top-level JSON + media file is not swallowed by
 *   Takeout's broad Google-Photos-album fallback.
 * - `imessage` claims only a macOS Messages folder with a readable `chat.db`
 *   carrying the Messages schema plus its sibling `Attachments/` directory. It
 *   precedes `folder` so `~/Library/Messages` is not treated as generic files.
 * - `telegram` claims only Telegram Desktop export folders with a `result.json`
 *   message shape or `messages.html` fallback. It precedes `takeout` because
 *   Telegram media folders also carry top-level JSON + media.
 * - `google_takeout` matches specific Takeout markers (`archive_browser.html`,
 *   `Mail`, `Google Photos`, a `Takeout` basename, a `.mbox`) PLUS a permissive
 *   `hasJson && hasMedia` album heuristic, making it the broadest concrete
 *   connector; it sits directly above the catch-all.
 * - `folder` is LAST: it claims ANY directory (`stat.isDirectory()`), the generic
 *   in-place catch-all. Listed first it would shadow every directory-form export
 *   above; listed last it only runs when no specific connector recognises the
 *   path. (A dropped `.zip`/`.mbox` is never a directory, so `folder` never
 *   competes for those.)
 */
export const importers: readonly Importer[] = [
  whatsappImporter,
  messengerImporter,
  facebookImporter,
  linkedinImporter,
  imessageImporter,
  telegramImporter,
  takeoutImporter,
  folderImporter,
];

/**
 * Pick the importer for a dropped path: the first registered connector whose
 * cheap `canHandle` predicate (markers / magic bytes, over the injected,
 * sandboxed {@link ImporterDeps}) accepts it. Returns `undefined` when no
 * connector recognises the path, so the caller can surface a clear "unsupported
 * source" rather than guessing.
 */
export async function selectImporter(
  inputPath: string,
  deps: ImporterDeps,
): Promise<Importer | undefined> {
  for (const importer of importers) {
    if (await importer.canHandle(inputPath, deps)) {
      return importer;
    }
  }
  return undefined;
}
