import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { CategoryChips } from '@renderer/components/CategoryChips';
import type { ItemCategoryDTO } from '@shared/kawsay-api';
import { makeFakeApi, makeItemCard, makeItemCategory } from './support/fake-api';
import type { FakeApi } from './support/fake-api';
import { wrapInProviders } from './support/render';
import { expectNoAxeViolations } from './support/axe';

const ITEM_ID = '00000000-0000-4000-8000-0000000000c1';
const PLACE_ID = '10000000-0000-4000-8000-0000000000a1';
const THEME_ID = '10000000-0000-4000-8000-0000000000b2';

/** A fake whose categorization surface is opted-in (chips are allowed to show). */
function optedInApi(categories: ItemCategoryDTO[], opts: Partial<Parameters<typeof makeFakeApi>[0]> = {}): FakeApi {
  return makeFakeApi({
    getCategorizationStatus: vi.fn(() => Promise.resolve({ optedIn: true, offered: true })),
    listItemCategories: vi.fn(() => Promise.resolve(categories)),
    ...opts,
  });
}

function setup(api: FakeApi): { api: FakeApi; user: UserEvent; container: HTMLElement } {
  const user = userEvent.setup();
  const item = makeItemCard({ id: ITEM_ID, mediaType: 'photo' });
  const { container } = render(wrapInProviders(<CategoryChips item={item} />, api));
  return { api, user, container };
}

describe('CategoryChips — DEFAULT-OFF (no chips until the user opts in, #270 AC)', () => {
  it('renders nothing at all and never lists categories while categorization is opted-out', async () => {
    const api = makeFakeApi({
      getCategorizationStatus: vi.fn(() => Promise.resolve({ optedIn: false, offered: true })),
      listItemCategories: vi.fn(() => Promise.resolve([makeItemCategory()])),
    });
    const { container } = setup(api);

    await waitFor(() => expect(api.getCategorizationStatus).toHaveBeenCalled());
    // Opted-out ⇒ the whole surface stays hidden AND we never even ask for chips.
    expect(container).toBeEmptyDOMElement();
    expect(api.listItemCategories).not.toHaveBeenCalled();
  });

  it('renders nothing when opted-in but the item has no assignments (calm empty state)', async () => {
    const api = optedInApi([]);
    const { container } = setup(api);

    await waitFor(() => expect(api.listItemCategories).toHaveBeenCalledWith({ itemId: ITEM_ID }));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('CategoryChips — explainable chips (name + reason/confidence tooltip)', () => {
  it("lists the item's categories as chips once opted in", async () => {
    const api = optedInApi([
      makeItemCategory({ categoryId: PLACE_ID, kind: 'place', name: 'Cusco, Perú' }),
      makeItemCategory({
        categoryId: THEME_ID,
        kind: 'theme',
        name: 'Beach days',
        signal: 'theme-cluster',
        explanation: 'Grouped with 4 similar items',
        confidence: 0.81,
      }),
    ]);
    setup(api);

    expect(await screen.findByText('Cusco, Perú')).toBeInTheDocument();
    expect(screen.getByText('Beach days')).toBeInTheDocument();
    expect(api.listItemCategories).toHaveBeenCalledWith({ itemId: ITEM_ID });
  });

  it('explains WHY (the reason) and HOW SURE (the confidence) for an auto assignment', async () => {
    const api = optedInApi([
      makeItemCategory({
        categoryId: PLACE_ID,
        kind: 'place',
        name: 'Cusco, Perú',
        source: 'auto',
        explanation: 'Near Cusco, Perú (from photo GPS)',
        confidence: 0.92,
      }),
    ]);
    setup(api);

    // The chip carries an accessible description (the tooltip) naming the source,
    // the human reason, and the rounded confidence — e.g. "Auto · Near Cusco, Perú
    // (from photo GPS) · 0.92".
    const reason = await screen.findByText(/Near Cusco, Perú \(from photo GPS\)/);
    expect(reason).toHaveTextContent(/auto/i);
    expect(reason).toHaveTextContent(/0\.92/);
  });

  it('shows a user-confirmed chip WITHOUT a confidence score (a user decision is certain)', async () => {
    const api = optedInApi([
      makeItemCategory({
        categoryId: PLACE_ID,
        kind: 'place',
        name: 'Cusco, Perú',
        source: 'user',
        signal: 'user',
        explanation: 'Confirmed by you',
        confidence: null,
      }),
    ]);
    setup(api);

    const reason = await screen.findByText(/Confirmed by you/);
    // No numeric score is invented for a certain, human decision.
    expect(reason).not.toHaveTextContent(/0\.\d/);
  });
});

describe('CategoryChips — corrections (confirm / remove / rename / reassign)', () => {
  it('confirm sends a confirm correction for that (item, category)', async () => {
    const api = optedInApi([makeItemCategory({ categoryId: PLACE_ID, name: 'Cusco, Perú' })]);
    const { user } = setup(api);

    await user.click(await screen.findByRole('button', { name: /confirm .*Cusco/i }));

    expect(api.applyCategoryCorrection).toHaveBeenCalledWith({
      kind: 'confirm',
      itemId: ITEM_ID,
      categoryId: PLACE_ID,
    });
  });

  it('remove sends a remove correction (a tombstone the re-cluster can never resurrect)', async () => {
    const api = optedInApi([makeItemCategory({ categoryId: PLACE_ID, name: 'Cusco, Perú' })]);
    const { user } = setup(api);

    await user.click(await screen.findByRole('button', { name: /remove .*Cusco/i }));

    expect(api.applyCategoryCorrection).toHaveBeenCalledWith({
      kind: 'remove',
      itemId: ITEM_ID,
      categoryId: PLACE_ID,
    });
  });

  it('rename sends a rename correction with the new label', async () => {
    const api = optedInApi([makeItemCategory({ categoryId: PLACE_ID, name: 'Cusco, Perú' })]);
    const { user } = setup(api);

    await user.click(await screen.findByRole('button', { name: /rename .*Cusco/i }));
    const input = await screen.findByRole('textbox', { name: /category name/i });
    await user.clear(input);
    await user.type(input, 'Cusco holidays');
    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(api.applyCategoryCorrection).toHaveBeenCalledWith({
      kind: 'rename',
      itemId: ITEM_ID,
      categoryId: PLACE_ID,
      name: 'Cusco holidays',
    });
  });

  it('reassign moves the item from one of its categories to another', async () => {
    const api = optedInApi([
      makeItemCategory({ categoryId: PLACE_ID, kind: 'place', name: 'Cusco, Perú' }),
      makeItemCategory({ categoryId: THEME_ID, kind: 'theme', name: 'Beach days' }),
    ]);
    const { user } = setup(api);

    await user.click(await screen.findByRole('button', { name: /reassign .*Cusco/i }));
    // The picker offers the item's OTHER categories as move targets.
    await user.click(await screen.findByRole('button', { name: /move to .*Beach days/i }));

    expect(api.applyCategoryCorrection).toHaveBeenCalledWith({
      kind: 'reassign',
      itemId: ITEM_ID,
      fromCategoryId: PLACE_ID,
      toCategoryId: THEME_ID,
    });
  });

  it('refreshes the visible chips from the correction result (no manual re-fetch)', async () => {
    const api = optedInApi([
      makeItemCategory({ categoryId: PLACE_ID, name: 'Cusco, Perú' }),
      makeItemCategory({ categoryId: THEME_ID, name: 'Beach days' }),
    ]);
    // After removing "Cusco, Perú", the service returns the refreshed remainder.
    (api.applyCategoryCorrection as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeItemCategory({ categoryId: THEME_ID, name: 'Beach days' }),
    ]);
    const { user } = setup(api);

    await user.click(await screen.findByRole('button', { name: /remove .*Cusco/i }));

    await waitFor(() => expect(screen.queryByText('Cusco, Perú')).not.toBeInTheDocument());
    expect(screen.getByText('Beach days')).toBeInTheDocument();
  });
});

describe('CategoryChips — accessibility (WCAG 2.1 AA)', () => {
  it('has no axe violations with chips + correction affordances rendered', async () => {
    const api = optedInApi([
      makeItemCategory({ categoryId: PLACE_ID, kind: 'place', name: 'Cusco, Perú' }),
      makeItemCategory({ categoryId: THEME_ID, kind: 'theme', name: 'Beach days' }),
    ]);
    const { container } = setup(api);

    await screen.findByText('Cusco, Perú');
    await expectNoAxeViolations(container);
  });

  it('has no axe violations while the rename editor is open', async () => {
    const api = optedInApi([makeItemCategory({ categoryId: PLACE_ID, name: 'Cusco, Perú' })]);
    const { user, container } = setup(api);

    await user.click(await screen.findByRole('button', { name: /rename .*Cusco/i }));
    await screen.findByRole('textbox', { name: /category name/i });
    await expectNoAxeViolations(container);
  });
});
