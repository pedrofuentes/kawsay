// Renderer tests for the SUGGESTED-COLLECTIONS review tray (T-M4-3c / #273). The
// tray is a SEPARATE surface from the main collections list: it shows pending
// suggestions and lets the user curate them (accept / rename-then-accept / merge /
// dismiss). It honours the same DEFAULT-OFF gate as the chips — hidden until the
// feature is offered AND opted in — and, per AC-32, merely displaying a suggestion
// never materialises a collection (no mutation fires on mount). axe-core guards
// WCAG 2.1 AA on the tray and its action controls.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { SuggestionsTray } from '@renderer/components/SuggestionsTray';
import { makeFakeApi, makeSuggestion, makeSuggestionsView } from './support/fake-api';
import type { FakeApi } from './support/fake-api';
import type { SuggestionsViewDTO } from '@shared/kawsay-api';
import { wrapInProviders } from './support/render';
import { expectNoAxeViolations } from './support/axe';

const CATEGORY = '20000000-0000-4000-8000-000000000001';
const THEME_CATEGORY = '20000000-0000-4000-8000-000000000002';
const COLLECTION = 'dddd0001-0000-4000-8000-000000000001';

/** A fake whose categorization surface is offered AND opted in, serving `view`. */
function enabledApi(
  view: SuggestionsViewDTO,
  over: Partial<Parameters<typeof makeFakeApi>[0]> = {},
): FakeApi {
  return makeFakeApi({
    getCategorizationStatus: vi.fn(() => Promise.resolve({ optedIn: true, offered: true })),
    listSuggestions: vi.fn(() => Promise.resolve(view)),
    ...over,
  });
}

function placeView(): SuggestionsViewDTO {
  return makeSuggestionsView({
    suggestions: [
      makeSuggestion({
        categoryId: CATEGORY,
        kind: 'place',
        name: 'Cusco, Perú',
        memberCount: 12,
        examples: [
          {
            id: '21000000-0000-4000-8000-000000000001',
            mediaType: 'photo',
            title: 'A quiet afternoon',
            hasThumbnail: true,
          },
          {
            id: '21000000-0000-4000-8000-000000000002',
            mediaType: 'photo',
            title: 'The blue door',
            hasThumbnail: true,
          },
        ],
      }),
    ],
    collections: [{ collectionId: COLLECTION, name: 'Our trips', origin: 'user' }],
  });
}

function setup(api: FakeApi): { api: FakeApi; user: UserEvent; container: HTMLElement } {
  const user = userEvent.setup();
  const { container } = render(wrapInProviders(<SuggestionsTray />, api));
  return { api, user, container };
}

describe('SuggestionsTray — DEFAULT-OFF gate (no fetch, nothing shown when disabled)', () => {
  it('renders nothing and never fetches suggestions while the feature is not offered', async () => {
    const api = makeFakeApi({
      getCategorizationStatus: vi.fn(() => Promise.resolve({ optedIn: false, offered: false })),
    });
    const { container } = setup(api);

    await waitFor(() => expect(api.getCategorizationStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(api.listSuggestions).not.toHaveBeenCalled();
  });

  it('renders nothing and never fetches suggestions while offered but opted OUT', async () => {
    const api = makeFakeApi({
      getCategorizationStatus: vi.fn(() => Promise.resolve({ optedIn: false, offered: true })),
    });
    const { container } = setup(api);

    await waitFor(() => expect(api.getCategorizationStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(api.listSuggestions).not.toHaveBeenCalled();
  });

  it('renders nothing when enabled but there are no suggestions to review (list stays byte-identical)', async () => {
    const api = enabledApi(makeSuggestionsView());
    const { container } = setup(api);

    await waitFor(() => expect(api.listSuggestions).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

describe('SuggestionsTray — a card per pending suggestion (a separate review surface)', () => {
  it('shows the suggested name, member count, source kind, and a few example items', async () => {
    setup(enabledApi(placeView()));

    const tray = await screen.findByRole('region', { name: /suggested collections/i });
    const card = within(tray).getByRole('listitem');
    // The suggested name is an editable field (rename-before-accept), seeded with the name.
    expect(within(card).getByRole('textbox', { name: /name/i })).toHaveValue('Cusco, Perú');
    expect(within(card).getByText(/12 memories/i)).toBeInTheDocument();
    expect(within(card).getByText(/^place$/i)).toBeInTheDocument();
    expect(within(card).getByText('A quiet afternoon')).toBeInTheDocument();
    expect(within(card).getByText('The blue door')).toBeInTheDocument();
  });

  it('does NOT materialise anything on mount — display alone creates no collection (AC-32)', async () => {
    const api = enabledApi(placeView());
    setup(api);

    await screen.findByRole('region', { name: /suggested collections/i });
    expect(api.acceptSuggestion).not.toHaveBeenCalled();
    expect(api.mergeSuggestion).not.toHaveBeenCalled();
    expect(api.dismissSuggestion).not.toHaveBeenCalled();
  });

  it('renders one card per suggestion', async () => {
    const api = enabledApi(
      makeSuggestionsView({
        suggestions: [
          makeSuggestion({ categoryId: CATEGORY, name: 'Cusco, Perú' }),
          makeSuggestion({ categoryId: THEME_CATEGORY, kind: 'theme', name: 'Family birthdays' }),
        ],
      }),
    );
    setup(api);

    const tray = await screen.findByRole('region', { name: /suggested collections/i });
    expect(within(tray).getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('SuggestionsTray — curation actions call the API with the right ids', () => {
  it('accept sends the categoryId and the current (unedited) name', async () => {
    const api = enabledApi(placeView());
    const { user } = setup(api);

    const card = within(
      await screen.findByRole('region', { name: /suggested collections/i }),
    ).getByRole('listitem');
    await user.click(within(card).getByRole('button', { name: /accept|add to collections/i }));

    expect(api.acceptSuggestion).toHaveBeenCalledWith({
      categoryId: CATEGORY,
      name: 'Cusco, Perú',
    });
  });

  it('rename-then-accept sends the edited name (edit the name field before accepting)', async () => {
    const api = enabledApi(placeView());
    const { user } = setup(api);

    const card = within(
      await screen.findByRole('region', { name: /suggested collections/i }),
    ).getByRole('listitem');
    const nameField = within(card).getByRole('textbox', { name: /name/i });
    await user.clear(nameField);
    await user.type(nameField, 'Our Cusco trip');
    await user.click(within(card).getByRole('button', { name: /accept|add to collections/i }));

    expect(api.acceptSuggestion).toHaveBeenCalledWith({
      categoryId: CATEGORY,
      name: 'Our Cusco trip',
    });
  });

  it('merge sends the categoryId and the chosen target collection', async () => {
    const api = enabledApi(placeView());
    const { user } = setup(api);

    const card = within(
      await screen.findByRole('region', { name: /suggested collections/i }),
    ).getByRole('listitem');
    await user.selectOptions(
      within(card).getByRole('combobox', { name: /merge into/i }),
      COLLECTION,
    );
    await user.click(within(card).getByRole('button', { name: /^merge$/i }));

    expect(api.mergeSuggestion).toHaveBeenCalledWith({
      categoryId: CATEGORY,
      intoCollectionId: COLLECTION,
    });
  });

  it('dismiss sends the categoryId (durable — not re-proposed)', async () => {
    const api = enabledApi(placeView());
    const { user } = setup(api);

    const card = within(
      await screen.findByRole('region', { name: /suggested collections/i }),
    ).getByRole('listitem');
    await user.click(within(card).getByRole('button', { name: /dismiss|not now/i }));

    expect(api.dismissSuggestion).toHaveBeenCalledWith({ categoryId: CATEGORY });
  });
});

describe('SuggestionsTray — a failed curation action surfaces a calm, non-blocking notice (#351 #5, #408)', () => {
  // Pin the error-surfacing guarantee for ALL THREE verbs — not just accept — so
  // a regression that re-swallows merge's or dismiss's errors can't pass CI green
  // (#408).
  it.each([
    { verb: 'accept', method: 'acceptSuggestion' },
    { verb: 'merge', method: 'mergeSuggestion' },
    { verb: 'dismiss', method: 'dismissSuggestion' },
  ] as const)(
    'shows a gentle status message and keeps the card when $verb rejects',
    async ({ verb, method }) => {
      const api = enabledApi(placeView(), {
        [method]: vi.fn(() => Promise.reject(new Error('curation failed'))),
      });
      const { user } = setup(api);

      const region = await screen.findByRole('region', { name: /suggested collections/i });
      const card = within(region).getByRole('listitem');
      if (verb === 'accept') {
        await user.click(within(card).getByRole('button', { name: /accept|add to collections/i }));
      } else if (verb === 'merge') {
        await user.selectOptions(
          within(card).getByRole('combobox', { name: /merge into/i }),
          COLLECTION,
        );
        await user.click(within(card).getByRole('button', { name: /^merge$/i }));
      } else {
        await user.click(within(card).getByRole('button', { name: /dismiss|not now/i }));
      }

      // A calm, local-only-framed notice appears for the user to retry — neutral
      // wording that never over-promises "nothing changed" (#409).
      const notice = await screen.findByRole('status');
      expect(notice).toHaveTextContent(/couldn.t confirm that change/i);
      expect(notice).toHaveTextContent(/refresh or try again/i);
      // …and it is NON-BLOCKING: the tray and the card stay put.
      expect(screen.getByRole('region', { name: /suggested collections/i })).toBeInTheDocument();
      expect(screen.getByRole('listitem')).toBeInTheDocument();
      expect(within(card).getByRole('textbox', { name: /name/i })).toHaveValue('Cusco, Perú');
    },
  );

  it('clears the notice once a later action succeeds', async () => {
    const remaining = makeSuggestionsView({
      suggestions: [
        makeSuggestion({ categoryId: THEME_CATEGORY, kind: 'theme', name: 'Family birthdays' }),
      ],
    });
    const api = enabledApi(
      makeSuggestionsView({
        suggestions: [
          makeSuggestion({ categoryId: CATEGORY, name: 'Cusco, Perú' }),
          makeSuggestion({ categoryId: THEME_CATEGORY, kind: 'theme', name: 'Family birthdays' }),
        ],
      }),
      {
        acceptSuggestion: vi.fn(() => Promise.reject(new Error('boom'))),
        dismissSuggestion: vi.fn(() => Promise.resolve(remaining)),
      },
    );
    const { user } = setup(api);

    const region = await screen.findByRole('region', { name: /suggested collections/i });
    const firstCard = () =>
      within(screen.getByRole('region', { name: /suggested collections/i })).getAllByRole(
        'listitem',
      )[0];
    // Accept fails on the first (place) card → the notice appears.
    await user.click(
      within(firstCard()).getByRole('button', { name: /accept|add to collections/i }),
    );
    expect(await screen.findByRole('status')).toBeInTheDocument();

    // Dismiss then succeeds (refreshes the tray) → the notice clears.
    await user.click(within(firstCard()).getByRole('button', { name: /dismiss|not now/i }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(within(region).getAllByRole('listitem')).toHaveLength(1);
  });
});

describe('SuggestionsTray — an action repaints the tray from the returned view (#351 #8)', () => {
  it('drops the acted-on card from the refreshed view the action resolves (no manual re-fetch)', async () => {
    const refreshed = makeSuggestionsView({
      suggestions: [
        makeSuggestion({ categoryId: THEME_CATEGORY, kind: 'theme', name: 'Family birthdays' }),
      ],
    });
    const api = enabledApi(
      makeSuggestionsView({
        suggestions: [
          makeSuggestion({ categoryId: CATEGORY, name: 'Cusco, Perú' }),
          makeSuggestion({ categoryId: THEME_CATEGORY, kind: 'theme', name: 'Family birthdays' }),
        ],
      }),
      { acceptSuggestion: vi.fn(() => Promise.resolve(refreshed)) },
    );
    const { user } = setup(api);

    const region = await screen.findByRole('region', { name: /suggested collections/i });
    expect(within(region).getAllByRole('listitem')).toHaveLength(2);

    // Accept the first (place) card → the action resolves a view WITHOUT it.
    await user.click(
      within(within(region).getAllByRole('listitem')[0]).getByRole('button', {
        name: /accept|add to collections/i,
      }),
    );

    // The tray repaints straight from that returned view (setView): the accepted
    // card drops out, the other remains, and listSuggestions is NOT called again.
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: /suggested collections/i })).getAllByRole(
          'listitem',
        ),
      ).toHaveLength(1),
    );
    expect(screen.getByRole('textbox', { name: /name/i })).toHaveValue('Family birthdays');
    expect(api.listSuggestions).toHaveBeenCalledTimes(1);
  });
});

describe('SuggestionsTray — accessibility (WCAG 2.1 AA)', () => {
  it('the tray and its action controls have no axe violations', async () => {
    const { container } = setup(enabledApi(placeView()));
    await screen.findByRole('region', { name: /suggested collections/i });
    await expectNoAxeViolations(container);
  });
});
