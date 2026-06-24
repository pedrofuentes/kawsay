import type { Importer, ImporterDeps } from './types';
import { folderImporter } from './folder-importer';
import { whatsappImporter } from './whatsapp-importer';

/**
 * The ordered list of concrete connectors the ingestion worker can run
 * (ARCHITECTURE §3.4). Registration order IS resolution order: {@link
 * selectImporter} returns the FIRST importer whose `canHandle` accepts the
 * dropped path, so more permissive importers are listed last. Today only the two
 * connectors merged on main are wired in; C4/C5 (Takeout, Facebook/LinkedIn)
 * append here with no other layer change.
 *
 * `folder` precedes `whatsapp` because a WhatsApp export is recognised by its
 * `.zip` (or an unpacked `_chat.txt` folder) while `folder` only ever claims a
 * directory — so a dropped `.zip` falls through to `whatsapp`, and a plain photo
 * directory is handled in place by `folder`.
 */
export const importers: readonly Importer[] = [folderImporter, whatsappImporter];

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
