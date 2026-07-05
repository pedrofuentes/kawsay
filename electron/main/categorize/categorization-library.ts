// The host-side categorization LIBRARY port (T-M4-2h / #270). It is the single seam
// the #270 IPC layer drives for the OPEN library, composing the categorizer's parts
// over one catalog connection: the per-item read/correction service
// (`listForItem` / `applyCorrection`) and the batch orchestrator (#269) it builds
// from the catalog's `category_status` store + categories repo (`start` / `cancel` /
// `status`). It owns NO worker and NO IPC — the cluster transport and the gate are
// injected — so it unit-tests over an in-memory DB with the deterministic inline
// transport, exactly the shape the AC-30 integration test wires.
//
// Correction durability (AC-30) is inherited, not re-implemented: corrections go
// through the same `source='user'` writes the categories repo guarantees are
// structurally untouchable by a re-cluster, so a fresh port over the same on-disk
// state (a "relaunch") reads them back unchanged.

import type { CatalogDatabase } from '../db/connection';
import { createCategoriesRepo } from './categories-repo';
import { createItemCategorizationService } from './item-categorization';
import {
  createCategorizationOrchestrator,
  createCategorizationStore,
  type CategorizationOrchestratorOptions,
  type CategorizationRunResult,
  type CategorizationRunSnapshot,
} from './categorization-orchestrator';
import type { CategorizationCorrectionDTO, ItemCategoryDTO } from '@shared/ipc/schemas';

/** The per-library categorization port the catalog session hands to the IPC handlers. */
export interface CategorizationLibraryPort {
  /** Resolve ONE item's visible, explainable category chips (USER over AUTO, tombstones hidden). */
  listForItem(itemId: string): ItemCategoryDTO[];
  /** Apply a user correction (confirm/remove/reassign/rename) and return the refreshed chips. */
  applyCorrection(input: CategorizationCorrectionDTO): ItemCategoryDTO[];
  /** Drain every pending item into its place/theme categories (gated, resilient, cancellable). */
  start(): Promise<CategorizationRunResult>;
  /** Cooperatively cancel the in-flight run. */
  cancel(): { cancelled: boolean };
  /** The current run snapshot (state + counts + last settled item). */
  status(): CategorizationRunSnapshot;
}

/**
 * Collaborators for {@link createCategorizationLibraryPort}: everything the
 * orchestrator needs EXCEPT the `store` + `categories` (both derived from the open
 * `db`), so a caller supplies only the live catalog, the reverse-geocoder, the
 * cluster transport, and the fresh-at-run gate.
 */
export interface CreateCategorizationLibraryPortOptions extends Omit<
  CategorizationOrchestratorOptions,
  'store' | 'categories'
> {
  /** The open, migrated catalog connection. */
  db: CatalogDatabase;
}

/** Build the categorization library port over the open catalog. */
export function createCategorizationLibraryPort(
  options: CreateCategorizationLibraryPortOptions,
): CategorizationLibraryPort {
  const { db, ...orchestratorOptions } = options;
  const service = createItemCategorizationService(db);
  const orchestrator = createCategorizationOrchestrator({
    ...orchestratorOptions,
    store: createCategorizationStore(db),
    categories: createCategoriesRepo(db),
  });

  return {
    listForItem: (itemId) => service.listForItem(itemId),
    applyCorrection: (input) => service.applyCorrection(input),
    start: () => orchestrator.run(),
    cancel: () => orchestrator.cancel(),
    status: () => orchestrator.status(),
  };
}
