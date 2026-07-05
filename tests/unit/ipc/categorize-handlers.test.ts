import { describe, expect, it, vi } from 'vitest';
import {
  handleCategorizationApplyCorrection,
  handleCategorizationCancel,
  handleCategorizationListForItem,
  handleCategorizationSetConsent,
  handleCategorizationStart,
  handleCategorizationStatus,
  type CategorizationConsentPort,
  type CategorizationLibraryProvider,
} from '../../../electron/main/ipc/handlers/categorize';
import {
  CATEGORIZE_APPLY_CORRECTION,
  CATEGORIZE_CANCEL,
  CATEGORIZE_LIST_FOR_ITEM,
  CATEGORIZE_SET_CONSENT,
  CATEGORIZE_START,
  CATEGORIZE_STATUS,
  ipcContract,
} from '@shared/ipc/contract';
import type {
  CategorizationStartResultDTO,
  ItemCategoriesDTO,
  ItemCategoryDTO,
} from '@shared/ipc/schemas';

const ITEM_ID = '11111111-1111-4111-8111-111111111111';
const CATEGORY_ID = '22222222-2222-4222-8222-222222222222';

function makeConsent(over: Partial<CategorizationConsentPort> = {}): CategorizationConsentPort {
  let optedIn = false;
  return {
    isOptedIn: vi.fn(() => optedIn),
    setOptedIn: vi.fn((value: boolean) => {
      optedIn = value;
    }),
    ...over,
  };
}

function placeChip(over: Partial<ItemCategoryDTO> = {}): ItemCategoryDTO {
  return {
    categoryId: CATEGORY_ID,
    kind: 'place',
    name: 'Cusco, Perú',
    source: 'auto',
    signal: 'gps',
    confidence: 0.92,
    explanation: 'Near Cusco, Perú (from photo GPS)',
    ...over,
  };
}

function makeLibrary(over: Partial<CategorizationLibraryProvider> = {}): CategorizationLibraryProvider {
  const idle: CategorizationStartResultDTO = {
    outcome: 'idle',
    reason: null,
    counts: { categorized: 0, skipped: 0, failed: 0, inFlight: 0 },
  };
  return {
    listForItem: vi.fn((): ItemCategoriesDTO => [placeChip()]),
    applyCorrection: vi.fn((): ItemCategoriesDTO => [placeChip({ source: 'user' })]),
    start: vi.fn(() => Promise.resolve(idle)),
    cancel: vi.fn(() => ({ cancelled: false })),
    ...over,
  };
}

describe('categorize IPC handlers — status + consent', () => {
  it('status layers the build-time offered gate onto the consent snapshot', async () => {
    const consent = makeConsent({ isOptedIn: vi.fn(() => true) });
    const response = await handleCategorizationStatus({ consent, isOffered: () => true });
    expect(response).toEqual({ optedIn: true, offered: true });
    expect(ipcContract[CATEGORIZE_STATUS].response.safeParse(response).success).toBe(true);
  });

  it('status reports offered:false while the gazetteer asset is not bundled', async () => {
    const consent = makeConsent();
    const response = await handleCategorizationStatus({ consent, isOffered: () => false });
    expect(response).toEqual({ optedIn: false, offered: false });
  });

  it('setConsent persists the choice and echoes the resolved state', async () => {
    const consent = makeConsent();
    const response = await handleCategorizationSetConsent({ consent }, { optedIn: true });
    expect(consent.setOptedIn).toHaveBeenCalledWith(true);
    expect(response).toEqual({ optedIn: true });
    expect(ipcContract[CATEGORIZE_SET_CONSENT].response.safeParse(response).success).toBe(true);
  });

  it('setConsent can turn the feature back OFF', async () => {
    const consent = makeConsent({ isOptedIn: vi.fn(() => false) });
    const response = await handleCategorizationSetConsent({ consent }, { optedIn: false });
    expect(consent.setOptedIn).toHaveBeenCalledWith(false);
    expect(response).toEqual({ optedIn: false });
  });
});

describe('categorize IPC handlers — per-item read + corrections', () => {
  it('listForItem returns the resolved chips and satisfies the contract schema', async () => {
    const library = makeLibrary();
    const response = await handleCategorizationListForItem(
      { getLibrary: () => library },
      { itemId: ITEM_ID },
    );
    expect(library.listForItem).toHaveBeenCalledWith(ITEM_ID);
    expect(response).toEqual([placeChip()]);
    expect(ipcContract[CATEGORIZE_LIST_FOR_ITEM].response.safeParse(response).success).toBe(true);
  });

  it('applyCorrection forwards the correction and returns the refreshed list', async () => {
    const library = makeLibrary();
    const correction = { kind: 'confirm', itemId: ITEM_ID, categoryId: CATEGORY_ID } as const;
    const response = await handleCategorizationApplyCorrection(
      { getLibrary: () => library },
      correction,
    );
    expect(library.applyCorrection).toHaveBeenCalledWith(correction);
    expect(response[0].source).toBe('user');
    expect(ipcContract[CATEGORIZE_APPLY_CORRECTION].response.safeParse(response).success).toBe(true);
  });
});

describe('categorize IPC handlers — run lifecycle', () => {
  it('start passes the run result through and satisfies the discriminated-union schema', async () => {
    const completed: CategorizationStartResultDTO = {
      outcome: 'completed',
      reason: null,
      counts: { categorized: 3, skipped: 1, failed: 0, inFlight: 0 },
    };
    const library = makeLibrary({ start: vi.fn(() => Promise.resolve(completed)) });
    const response = await handleCategorizationStart({ getLibrary: () => library });
    expect(response).toEqual(completed);
    expect(ipcContract[CATEGORIZE_START].response.safeParse(response).success).toBe(true);
  });

  it('start surfaces a typed refusal (opted-out) without throwing', async () => {
    const refused: CategorizationStartResultDTO = {
      outcome: 'refused',
      reason: 'not-opted-in',
      counts: { categorized: 0, skipped: 0, failed: 0, inFlight: 0 },
    };
    const library = makeLibrary({ start: vi.fn(() => Promise.resolve(refused)) });
    const response = await handleCategorizationStart({ getLibrary: () => library });
    expect(response).toEqual(refused);
  });

  it('cancel reports whether a run was stopped', async () => {
    const library = makeLibrary({ cancel: vi.fn(() => ({ cancelled: true })) });
    const response = await handleCategorizationCancel({ getLibrary: () => library });
    expect(response).toEqual({ cancelled: true });
    expect(ipcContract[CATEGORIZE_CANCEL].response.safeParse(response).success).toBe(true);
  });
});
