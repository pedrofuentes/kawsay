// RED-phase tests for the Collections browser view (#437): a sidebar entry that
// lists a person's collections and, on opening one, shows the memories inside.
// Written BEFORE `src/views/Collections.tsx`, `src/lib/use-collections.ts`, the
// `collections`/`collection` View cases, and the Sidebar nav entry exist — every
// `it` here is expected to FAIL until the GREEN commit adds them. Mirrors the
// existing Timeline/Search suites: heading focus (WCAG 2.4.3), an axe-clean
// render, and navigation to ItemView carrying `siblings` for ←/→ arrow-nav.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MainApp } from '@renderer/app/MainApp';
import { Collections, CollectionDetail } from '@renderer/views/Collections';
import type { CollectionItemsPageDTO, CollectionsListDTO } from '@shared/kawsay-api';
import {
  makeCollectionItemsPage,
  makeCollectionsListView,
  makeCollectionSummary,
  makeFakeApi,
  makeItemCard,
} from './support/fake-api';
import type { FakeApi } from './support/fake-api';
import { SiblingsProbe, ViewProbe, wrapInProviders } from './support/render';
import { expectNoAxeViolations } from './support/axe';

function collectionsView(over: Partial<CollectionsListDTO> = {}): CollectionsListDTO {
  return makeCollectionsListView(over);
}

function collectionPage(over: Partial<CollectionItemsPageDTO> = {}): CollectionItemsPageDTO {
  return makeCollectionItemsPage(over);
}

describe('Collections — the list view (#437)', () => {
  it('renders every collection from the fake data source, with its name and member count', async () => {
    const beach = makeCollectionSummary({ id: '10000000-0000-4000-8000-000000000001', name: 'A day at the beach', itemCount: 12 });
    const grandma = makeCollectionSummary({ id: '10000000-0000-4000-8000-000000000002', name: "Grandma's kitchen", itemCount: 1 });
    const api = makeFakeApi({
      listCollections: vi.fn(() => Promise.resolve(collectionsView({ collections: [beach, grandma] }))),
    });
    render(wrapInProviders(<Collections />, api, { name: 'collections' }));

    expect(await screen.findByText('A day at the beach')).toBeInTheDocument();
    expect(screen.getByText("Grandma's kitchen")).toBeInTheDocument();
    expect(screen.getByText(/12 memories/i)).toBeInTheDocument();
    expect(screen.getByText(/1 memory\b/i)).toBeInTheDocument();
  });

  it('moves keyboard focus to the heading on mount (WCAG 2.4.3)', async () => {
    const api = makeFakeApi({ listCollections: vi.fn(() => Promise.resolve(collectionsView())) });
    render(wrapInProviders(<Collections />, api, { name: 'collections' }));

    const heading = await screen.findByRole('heading', { level: 1, name: 'Collections' });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it('shows a reverent empty state when there are no collections yet, with no banned phrases', async () => {
    const api = makeFakeApi({ listCollections: vi.fn(() => Promise.resolve(collectionsView({ collections: [] }))) });
    const { container } = render(wrapInProviders(<Collections />, api, { name: 'collections' }));

    await screen.findByRole('heading', { level: 2 });
    const main = container;
    expect(main).not.toHaveTextContent(/your loved one/i);
    expect(main).not.toHaveTextContent(/the deceased/i);
    expect(main).not.toHaveTextContent(/the contact/i);
    expect(main).not.toHaveTextContent(/undefined/i);
    await expectNoAxeViolations(container);
  });

  it('is axe-clean once populated', async () => {
    const api = makeFakeApi({
      listCollections: vi.fn(() =>
        Promise.resolve(collectionsView({ collections: [makeCollectionSummary()] })),
      ),
    });
    const { container } = render(wrapInProviders(<Collections />, api, { name: 'collections' }));
    await screen.findByText('A summer by the lake');
    await expectNoAxeViolations(container);
  });

  it('opening a collection navigates to its detail view', async () => {
    const collection = makeCollectionSummary({
      id: '10000000-0000-4000-8000-000000000003',
      name: 'Sunday drives',
      itemCount: 4,
    });
    const api = makeFakeApi({
      listCollections: vi.fn(() => Promise.resolve(collectionsView({ collections: [collection] }))),
    });
    const user = userEvent.setup();
    render(
      wrapInProviders(
        <>
          <Collections />
          <ViewProbe />
        </>,
        api,
        { name: 'collections' },
      ),
    );

    await user.click(await screen.findByRole('button', { name: /open sunday drives/i }));

    expect(screen.getByTestId('active-view')).toHaveTextContent('collection');
  });
});

describe('CollectionDetail — opening one shows the memories inside (#437)', () => {
  function renderDetail(api: FakeApi) {
    return render(
      wrapInProviders(
        <>
          <CollectionDetail />
          <SiblingsProbe />
        </>,
        api,
        { name: 'collection', collectionId: 'col-1', collectionName: 'Sunday drives' },
      ),
    );
  }

  it('fetches and renders the collection’s members', async () => {
    const item = makeItemCard({ id: 'mem-1', title: 'A picnic by the river' });
    const getCollection = vi.fn(() =>
      Promise.resolve(
        collectionPage({
          collection: makeCollectionSummary({ id: 'col-1', name: 'Sunday drives', itemCount: 1 }),
          items: [item],
          total: 1,
        }),
      ),
    );
    const api = makeFakeApi({ getCollection });
    renderDetail(api);

    expect(await screen.findByText('A picnic by the river')).toBeInTheDocument();
    expect(getCollection).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'col-1', offset: 0 }),
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Sunday drives' })).toBeInTheDocument();
  });

  it('moves keyboard focus to the heading on mount (WCAG 2.4.3)', async () => {
    const api = makeFakeApi({
      getCollection: vi.fn(() =>
        Promise.resolve(collectionPage({ collection: makeCollectionSummary({ id: 'col-1' }) })),
      ),
    });
    renderDetail(api);

    const heading = await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it('shows a reverent empty state when this collection holds no memories', async () => {
    const api = makeFakeApi({
      getCollection: vi.fn(() =>
        Promise.resolve(
          collectionPage({ collection: makeCollectionSummary({ id: 'col-1', itemCount: 0 }), items: [] }),
        ),
      ),
    });
    const { container } = renderDetail(api);

    await screen.findByRole('heading', { level: 2 });
    expect(container).not.toHaveTextContent(/undefined/i);
    await expectNoAxeViolations(container);
  });

  it('is axe-clean once populated', async () => {
    const api = makeFakeApi({
      getCollection: vi.fn(() =>
        Promise.resolve(
          collectionPage({
            collection: makeCollectionSummary({ id: 'col-1' }),
            items: [makeItemCard({ id: 'mem-1', title: 'A picnic by the river' })],
            total: 1,
          }),
        ),
      ),
    });
    const { container } = renderDetail(api);
    await screen.findByText('A picnic by the river');
    await expectNoAxeViolations(container);
  });

  it('offers "Load more" when more members remain, and appends the next page on click', async () => {
    const page1Item = makeItemCard({ id: 'mem-1', title: 'First memory' });
    const page2Item = makeItemCard({ id: 'mem-2', title: 'Second memory' });
    const getCollection = vi
      .fn()
      .mockResolvedValueOnce(
        collectionPage({
          collection: makeCollectionSummary({ id: 'col-1', itemCount: 2 }),
          items: [page1Item],
          total: 2,
        }),
      )
      .mockResolvedValueOnce(
        collectionPage({
          collection: makeCollectionSummary({ id: 'col-1', itemCount: 2 }),
          items: [page2Item],
          total: 2,
        }),
      );
    const api = makeFakeApi({ getCollection });
    const user = userEvent.setup();
    renderDetail(api);

    await screen.findByText('First memory');
    expect(screen.queryByText('Second memory')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /load more/i }));

    expect(await screen.findByText('Second memory')).toBeInTheDocument();
    expect(screen.getByText('First memory')).toBeInTheDocument();
    expect(getCollection).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'col-1', offset: 1 }));
  });

  it('opening a memory navigates to ItemView carrying the loaded members as siblings (#434 arrow-nav)', async () => {
    const item = makeItemCard({ id: 'mem-1', title: 'A picnic by the river' });
    const api = makeFakeApi({
      getCollection: vi.fn(() =>
        Promise.resolve(
          collectionPage({ collection: makeCollectionSummary({ id: 'col-1' }), items: [item], total: 1 }),
        ),
      ),
    });
    const user = userEvent.setup();
    renderDetail(api);

    await user.click(await screen.findByRole('button', { name: /open a picnic by the river/i }));

    expect(screen.getByTestId('siblings')).toHaveTextContent('mem-1');
  });
});

describe('Sidebar — Collections nav entry routes into the browser view (#437)', () => {
  it('clicking "Collections" in the sidebar opens the collections list', async () => {
    const api = makeFakeApi({
      listCollections: vi.fn(() =>
        Promise.resolve(collectionsView({ collections: [makeCollectionSummary({ name: 'Sunday drives' })] })),
      ),
    });
    const user = userEvent.setup();
    const { container } = render(wrapInProviders(<MainApp />, api, { name: 'timeline' }));

    await user.click(screen.getByRole('button', { name: 'Collections' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Collections' })).toBeInTheDocument();
    expect(within(screen.getByRole('heading', { level: 1 })).getByText('Collections')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});
