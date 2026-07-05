import { describe, expect, it, vi } from 'vitest';
import {
  handleSuggestionsAccept,
  handleSuggestionsDismiss,
  handleSuggestionsList,
  handleSuggestionsMerge,
  type SuggestionsLibraryProvider,
} from '../../../electron/main/ipc/handlers/suggestions';
import {
  SUGGESTIONS_ACCEPT,
  SUGGESTIONS_DISMISS,
  SUGGESTIONS_LIST,
  SUGGESTIONS_MERGE,
  ipcContract,
} from '@shared/ipc/contract';
import type { SuggestionDTO, SuggestionsViewDTO } from '@shared/ipc/schemas';

const PLACE_CATEGORY = 'cccc0001-0000-4000-8000-000000000001';
const THEME_CATEGORY = 'cccc0002-0000-4000-8000-000000000002';
const COLLECTION_ID = 'dddd0001-0000-4000-8000-000000000001';
const EXAMPLE_ITEM = 'aaaaaaaa-0000-4000-8000-000000000001';

function placeSuggestion(over: Partial<SuggestionDTO> = {}): SuggestionDTO {
  return {
    categoryId: PLACE_CATEGORY,
    kind: 'place',
    name: 'Cusco, Perú',
    memberCount: 12,
    examples: [{ id: EXAMPLE_ITEM, mediaType: 'photo', title: 'A quiet afternoon', hasThumbnail: true }],
    ...over,
  };
}

function view(over: Partial<SuggestionsViewDTO> = {}): SuggestionsViewDTO {
  return {
    suggestions: [placeSuggestion()],
    collections: [{ collectionId: COLLECTION_ID, name: 'Our trips', origin: 'user' }],
    ...over,
  };
}

function makeLibrary(over: Partial<SuggestionsLibraryProvider> = {}): SuggestionsLibraryProvider {
  return {
    list: vi.fn((): SuggestionsViewDTO => view()),
    // A mutation returns the REFRESHED view — the acted-on suggestion is gone.
    accept: vi.fn((): SuggestionsViewDTO => view({ suggestions: [] })),
    merge: vi.fn((): SuggestionsViewDTO => view({ suggestions: [] })),
    dismiss: vi.fn((): SuggestionsViewDTO => view({ suggestions: [] })),
    ...over,
  };
}

describe('suggestions IPC handlers — list', () => {
  it('list returns the derived tray view and satisfies the contract schema', async () => {
    const library = makeLibrary();
    const response = await handleSuggestionsList({ getLibrary: () => library });
    expect(library.list).toHaveBeenCalledOnce();
    expect(response).toEqual(view());
    expect(ipcContract[SUGGESTIONS_LIST].response.safeParse(response).success).toBe(true);
  });
});

describe('suggestions IPC handlers — curation actions', () => {
  it('accept forwards the categoryId (+ optional rename) and returns the refreshed view', async () => {
    const library = makeLibrary();
    const request = { categoryId: PLACE_CATEGORY, name: 'Our Cusco trip' } as const;
    const response = await handleSuggestionsAccept({ getLibrary: () => library }, request);
    expect(library.accept).toHaveBeenCalledWith(request);
    expect(response.suggestions).toEqual([]);
    expect(ipcContract[SUGGESTIONS_ACCEPT].response.safeParse(response).success).toBe(true);
  });

  it('accept works with no rename (name omitted)', async () => {
    const library = makeLibrary();
    const request = { categoryId: PLACE_CATEGORY } as const;
    const response = await handleSuggestionsAccept({ getLibrary: () => library }, request);
    expect(library.accept).toHaveBeenCalledWith(request);
    expect(ipcContract[SUGGESTIONS_ACCEPT].response.safeParse(response).success).toBe(true);
  });

  it('merge forwards the categoryId + target collection and returns the refreshed view', async () => {
    const library = makeLibrary();
    const request = { categoryId: PLACE_CATEGORY, intoCollectionId: COLLECTION_ID } as const;
    const response = await handleSuggestionsMerge({ getLibrary: () => library }, request);
    expect(library.merge).toHaveBeenCalledWith(request);
    expect(response.suggestions).toEqual([]);
    expect(ipcContract[SUGGESTIONS_MERGE].response.safeParse(response).success).toBe(true);
  });

  it('dismiss forwards the categoryId and returns the refreshed view', async () => {
    const library = makeLibrary();
    const request = { categoryId: THEME_CATEGORY } as const;
    const response = await handleSuggestionsDismiss({ getLibrary: () => library }, request);
    expect(library.dismiss).toHaveBeenCalledWith(request);
    expect(response.suggestions).toEqual([]);
    expect(ipcContract[SUGGESTIONS_DISMISS].response.safeParse(response).success).toBe(true);
  });
});

describe('suggestions IPC contract — zod rejects malformed REQUESTS', () => {
  it('accept rejects a non-uuid categoryId (a path/traversal string can never validate)', () => {
    expect(
      ipcContract[SUGGESTIONS_ACCEPT].request.safeParse({ categoryId: '../etc/passwd' }).success,
    ).toBe(false);
  });

  it('accept rejects an empty rename name', () => {
    expect(
      ipcContract[SUGGESTIONS_ACCEPT].request.safeParse({ categoryId: PLACE_CATEGORY, name: '' })
        .success,
    ).toBe(false);
  });

  it('accept rejects an unknown key (strictObject)', () => {
    expect(
      ipcContract[SUGGESTIONS_ACCEPT].request.safeParse({ categoryId: PLACE_CATEGORY, evil: 1 })
        .success,
    ).toBe(false);
  });

  it('merge rejects a missing target collection', () => {
    expect(
      ipcContract[SUGGESTIONS_MERGE].request.safeParse({ categoryId: PLACE_CATEGORY }).success,
    ).toBe(false);
  });

  it('merge rejects a non-uuid target collection', () => {
    expect(
      ipcContract[SUGGESTIONS_MERGE].request.safeParse({
        categoryId: PLACE_CATEGORY,
        intoCollectionId: 'not-a-uuid',
      }).success,
    ).toBe(false);
  });

  it('dismiss rejects a non-uuid categoryId', () => {
    expect(ipcContract[SUGGESTIONS_DISMISS].request.safeParse({ categoryId: 'nope' }).success).toBe(
      false,
    );
  });

  it('list rejects any payload with keys (strictObject {})', () => {
    expect(ipcContract[SUGGESTIONS_LIST].request.safeParse({ page: 1 }).success).toBe(false);
  });
});

describe('suggestions IPC contract — zod rejects malformed RESPONSES', () => {
  it('rejects a suggestion of an out-of-scope kind (person)', () => {
    const bad = view({ suggestions: [placeSuggestion({ kind: 'person' as never })] });
    expect(ipcContract[SUGGESTIONS_LIST].response.safeParse(bad).success).toBe(false);
  });

  it('rejects a suggestion carrying more than the example cap', () => {
    const tooMany = Array.from({ length: 5 }, (_, i) => ({
      id: `aaaaaaaa-0000-4000-8000-00000000000${i + 1}`,
      mediaType: 'photo' as const,
      title: null,
      hasThumbnail: true,
    }));
    const bad = view({ suggestions: [placeSuggestion({ examples: tooMany })] });
    expect(ipcContract[SUGGESTIONS_LIST].response.safeParse(bad).success).toBe(false);
  });

  it('rejects a negative member count', () => {
    const bad = view({ suggestions: [placeSuggestion({ memberCount: -1 })] });
    expect(ipcContract[SUGGESTIONS_LIST].response.safeParse(bad).success).toBe(false);
  });

  it('rejects a merge target with an out-of-scope origin (dismissed tombstone is not a target)', () => {
    const bad = view({
      collections: [{ collectionId: COLLECTION_ID, name: 'x', origin: 'dismissed' as never }],
    });
    expect(ipcContract[SUGGESTIONS_LIST].response.safeParse(bad).success).toBe(false);
  });
});
