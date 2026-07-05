// The durable categorization opt-in store (T-M4-2h / #270). Categorization is a
// SEPARATE, independently-gated feature: like smart search it REUSES the
// parameterized M2 consent store but with its OWN key + label + file, so opting in
// to categorization never implies transcription or smart search (and vice versa).
// The calm, privacy-preserving default — for an absent OR corrupt config — is
// OPTED-OUT, so no place/theme clustering ever runs until an explicit, well-formed
// opt-in. No new dependency, no DB migration: a single tiny JSON file.

import {
  createConsentStore,
  type ConsentStore,
  type ConsentStoreFs,
} from '../transcription/consent-store';
import {
  CATEGORIZATION_CONSENT_KEY,
  CATEGORIZATION_CONSENT_LABEL,
} from './categorization-orchestrator';

/**
 * Build the durable categorization opt-in store (its own file + its own key),
 * REUSING the M2 consent store with the #269 key/label constants. The default — for
 * an absent OR corrupt file — is the calm OPTED-OUT, so categorization stays off
 * until an explicit, well-formed opt-in.
 */
export function createCategorizationConsentStore(options: {
  filePath: string;
  fs?: ConsentStoreFs;
}): ConsentStore {
  return createConsentStore({
    filePath: options.filePath,
    key: CATEGORIZATION_CONSENT_KEY,
    label: CATEGORIZATION_CONSENT_LABEL,
    ...(options.fs ? { fs: options.fs } : {}),
  });
}
