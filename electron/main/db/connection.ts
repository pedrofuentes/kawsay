import Database, { type Database as CatalogDatabase } from 'better-sqlite3';

export type { CatalogDatabase };

/**
 * Open (creating if absent) the SQLite catalog at `filename` and apply the
 * tuned pragmas from ARCHITECTURE §4.1. `better-sqlite3` is synchronous: browse/
 * search reads run on the main thread, writes run in the ingestion worker; WAL
 * keeps reads concurrent with an in-flight import. Pass `:memory:` for tests
 * that don't need an on-disk file.
 */
/** Signature of a native-addon load/ABI failure (better-sqlite3 not rebuilt for
 *  this runtime's NODE_MODULE_VERSION, a dlopen/ELF error, etc.). */
const NATIVE_MODULE_ERROR =
  /NODE_MODULE_VERSION|was compiled against a different Node\.js|better[_-]?sqlite3(\.node)?|dlopen|invalid ELF|\.node['"]?\b/iu;

/** A stable, NON-PII code for a native-module load failure. It is environmental
 *  (the addon isn't built for this ABI), not user data, so it may safely cross the
 *  redacted IPC envelope (#440) — letting callers (and the e2e ABI probe) recognise
 *  a skip condition after the raw message is dropped. */
export const ERR_NATIVE_MODULE = 'ERR_NATIVE_MODULE';

export function openCatalog(filename: string): CatalogDatabase {
  let db: CatalogDatabase;
  try {
    db = new Database(filename);
  } catch (error) {
    // Re-tag a native-addon/ABI failure with a stable code so it survives the IPC
    // redaction; anything else propagates untouched.
    if (error instanceof Error && NATIVE_MODULE_ERROR.test(error.message)) {
      throw Object.assign(new Error('native catalog module unavailable for this runtime'), {
        name: 'NativeModuleError',
        code: ERR_NATIVE_MODULE,
      });
    }
    throw error;
  }
  db.pragma('journal_mode = WAL'); // concurrent reads during ingestion
  db.pragma('synchronous = NORMAL'); // safe + fast with WAL
  db.pragma('foreign_keys = ON'); // enforce occurrence/asset cascades
  db.pragma('cache_size = -32000'); // 32 MB page cache
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 134217728'); // 128 MB mmap I/O
  return db;
}
