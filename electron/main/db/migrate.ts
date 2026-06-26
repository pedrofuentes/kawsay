import type { Database } from 'better-sqlite3';
import initial001 from './migrations/001_initial.sql?raw';
import transcripts002 from './migrations/002_transcripts.sql?raw';

export interface Migration {
  /** Stable, ordered name recorded in the `migrations` table for provenance. */
  readonly name: string;
  /** The forward-only DDL/DML for this step. */
  readonly sql: string;
}

/**
 * The ordered, forward-only migration list. Index + 1 is the schema version
 * written to `PRAGMA user_version`. Append new migrations — never reorder or
 * edit a shipped one (authoring a migration is a HUMAN-REQUIRED action gated by
 * ADR-0008; ARCHITECTURE §4.3).
 */
export const MIGRATIONS: readonly Migration[] = [
  { name: '001_initial', sql: initial001 },
  { name: '002_transcripts', sql: transcripts002 },
];

/**
 * Apply every migration whose 1-based version exceeds the catalog's current
 * `user_version`. Each step runs in its own transaction (DDL + the bookkeeping
 * row + the version bump commit or roll back together), so the runner is
 * ordered, idempotent, and crash-safe. Returns the resulting schema version.
 *
 * `user_version` is the authoritative gate (a single integer header read);
 * the `migrations` table additionally records each step by name for humans.
 */
export function runMigrations(
  db: Database,
  migrations: readonly Migration[] = MIGRATIONS,
): number {
  const current = Number(db.pragma('user_version', { simple: true }));

  for (let index = current; index < migrations.length; index += 1) {
    const migration = migrations[index];
    const version = index + 1;
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO migrations (name) VALUES (?)').run(migration.name);
      // `version` is a controlled loop integer (never user input), so inlining
      // it is injection-safe — and PRAGMA does not accept bound parameters.
      db.exec(`PRAGMA user_version = ${version}`);
    });
    apply();
  }

  return migrations.length;
}
