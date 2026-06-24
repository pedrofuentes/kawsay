import Database, { type Database as CatalogDatabase } from 'better-sqlite3';

export type { CatalogDatabase };

/**
 * Open (creating if absent) the SQLite catalog at `filename` and apply the
 * tuned pragmas from ARCHITECTURE §4.1. `better-sqlite3` is synchronous: browse/
 * search reads run on the main thread, writes run in the ingestion worker; WAL
 * keeps reads concurrent with an in-flight import. Pass `:memory:` for tests
 * that don't need an on-disk file.
 */
export function openCatalog(filename: string): CatalogDatabase {
  const db = new Database(filename);
  db.pragma('journal_mode = WAL'); // concurrent reads during ingestion
  db.pragma('synchronous = NORMAL'); // safe + fast with WAL
  db.pragma('foreign_keys = ON'); // enforce occurrence/asset cascades
  db.pragma('cache_size = -32000'); // 32 MB page cache
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 134217728'); // 128 MB mmap I/O
  return db;
}
