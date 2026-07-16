// The Collections browser view (#437) — the sidebar-reachable home for
// browsing a person's collections (hand-made ones, and any accepted from the
// suggestions tray, M4-3 / ADR-0030), which previously had nowhere to be
// browsed from. `Collections` lists every collection with its name and member
// count; opening one moves to `CollectionDetail`, which reuses the same
// MediaThumbnail tile and `navigate({ name: 'item', ... siblings })` pattern
// Timeline/Search already use, so ←/→ arrow-nav in ItemView works identically
// (#434) and no new IPC channel was needed for the item-opening half. Both
// screens move keyboard focus to their <h1> on mount (WCAG 2.4.3 / AC-13), like
// every other primary view.
import { useCallback } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@renderer/components/Button';
import { EmptyState } from '@renderer/components/EmptyState';
import { ErrorBanner } from '@renderer/components/ErrorBanner';
import { Icon } from '@renderer/components/Icon';
import type { IconName } from '@renderer/components/Icon';
import { MediaThumbnail } from '@renderer/components/MediaThumbnail';
import { useAutoFocusHeading } from '@renderer/lib/use-auto-focus';
import { useCollectionItems, useCollections } from '@renderer/lib/use-collections';
import { useNavigation } from '@renderer/lib/navigation';
import type { View } from '@renderer/lib/navigation';
import type { CollectionSummaryDTO, ItemCardDTO, MediaType } from '@shared/kawsay-api';

const MEDIA_LABEL: Record<MediaType, string> = {
  photo: 'Photo',
  video: 'Video',
  audio: 'Voice note',
  document: 'Document',
  message: 'Message',
};

const MEDIA_ICON: Record<MediaType, IconName> = {
  photo: 'photos',
  video: 'video',
  audio: 'audio',
  document: 'document',
  message: 'messages',
};

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

function formatDate(iso: string | null): string | null {
  if (iso === null) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return DATE_FORMAT.format(new Date(time));
}

function memoryCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'memory' : 'memories'}`;
}

// ── The list: every browsable collection ───────────────────────────────────

export function Collections(): ReactElement {
  const headingRef = useAutoFocusHeading<HTMLHeadingElement>();
  const { collections, status, reload } = useCollections();

  return (
    <section className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="font-display text-3xl font-semibold text-text-primary outline-none"
        >
          Collections
        </h1>
        <p className="font-body text-base text-text-secondary">
          Memories gathered together by a place or a moment.
        </p>
      </header>
      {renderBody()}
    </section>
  );

  function renderBody(): ReactElement {
    if (status === 'unavailable') {
      return (
        <EmptyState
          icon={<Icon name="lock" className="h-8 w-8" />}
          title="We can't reach the library right now"
          description="Kawsay is not connected on this device, so there's nothing to show here yet."
        />
      );
    }

    if (status === 'loading') {
      return (
        <p role="status" aria-live="polite" aria-busy className="font-body text-base text-text-secondary">
          Gathering the collections…
        </p>
      );
    }

    if (status === 'error') {
      return (
        <ErrorBanner
          title="We couldn't open the collections just now"
          message="Nothing is lost — every memory is still safe on this computer. Let's try once more."
          onRetry={reload}
        />
      );
    }

    if (collections.length === 0) {
      return (
        <EmptyState
          icon={<Icon name="collection" className="h-8 w-8" />}
          title="Collections will gather here"
          description="As memories are grouped by a place or a moment, they'll appear here to browse together."
        />
      );
    }

    return (
      <>
        <p role="status" aria-live="polite" className="font-body text-sm text-text-secondary">
          {collections.length} {collections.length === 1 ? 'collection' : 'collections'}
        </p>
        <ul className="flex flex-col gap-3">
          {collections.map((collection) => (
            <li key={collection.id}>
              <CollectionTile collection={collection} />
            </li>
          ))}
        </ul>
      </>
    );
  }
}

function CollectionTile({ collection }: { collection: CollectionSummaryDTO }): ReactElement {
  const { navigate } = useNavigation();
  return (
    <button
      type="button"
      onClick={() =>
        navigate({ name: 'collection', collectionId: collection.id, collectionName: collection.name })
      }
      aria-label={`Open ${collection.name}, ${memoryCountLabel(collection.itemCount)}`}
      className="flex min-h-16 w-full items-center gap-4 rounded-lg border border-border-subtle bg-surface-raised px-5 text-left transition-colors duration-150 hover:bg-surface-tinted"
    >
      <Icon name="collection" className="h-8 w-8 shrink-0 text-sage-600" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-body text-md text-text-primary">{collection.name}</span>
        <span className="font-body text-sm text-text-secondary">
          {memoryCountLabel(collection.itemCount)}
        </span>
      </span>
      <Icon name="arrow-right" className="h-5 w-5 shrink-0 text-text-secondary" />
    </button>
  );
}

// ── The detail: one collection's memories ───────────────────────────────────

export function CollectionDetail(): ReactElement | null {
  const { view, navigate } = useNavigation();
  const headingRef = useAutoFocusHeading<HTMLHeadingElement>();

  const isCollectionView = view.name === 'collection';
  const collectionId = isCollectionView ? view.collectionId : '';
  const seededName = isCollectionView ? view.collectionName : '';

  const { collection, items, status, hasMore, loadMore, reload } = useCollectionItems(collectionId);

  const goBack = useCallback((): void => {
    navigate({ name: 'collections' });
  }, [navigate]);

  // Routed only for the 'collection' view; the guard keeps this safe if it is
  // ever mounted without one, mirroring ItemView.
  if (!isCollectionView) {
    return null;
  }

  const heading = collection?.name ?? seededName;
  const subtitle = collection !== null ? memoryCountLabel(collection.itemCount) : null;

  return (
    <section className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" onClick={goBack}>
          <Icon name="arrow-right" className="h-5 w-5 rotate-180" />
          Back to Collections
        </Button>
      </div>
      <header className="flex flex-col gap-1">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="font-display text-3xl font-semibold text-text-primary outline-none"
        >
          {heading}
        </h1>
        {subtitle !== null ? (
          <p className="font-body text-base text-text-secondary">{subtitle}</p>
        ) : null}
      </header>
      {renderBody()}
    </section>
  );

  function renderBody(): ReactElement {
    if (status === 'unavailable') {
      return (
        <EmptyState
          icon={<Icon name="lock" className="h-8 w-8" />}
          title="We can't reach the library right now"
          description="Kawsay is not connected on this device, so there's nothing to show here yet."
        />
      );
    }

    if (status === 'loading') {
      return (
        <p role="status" aria-live="polite" aria-busy className="font-body text-base text-text-secondary">
          Gathering these memories…
        </p>
      );
    }

    if (status === 'error' && items.length === 0) {
      return (
        <ErrorBanner
          title="We couldn't open this collection just now"
          message="Nothing is lost — every memory here is safe on this computer. Let's try once more."
          onRetry={reload}
        />
      );
    }

    if (items.length === 0) {
      return (
        <EmptyState
          icon={<Icon name="collection" className="h-8 w-8" />}
          title="Nothing here yet"
          description="This collection doesn't hold any memories right now."
        />
      );
    }

    return (
      <>
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
          {items.map((item) => (
            <CollectionMemoryCard key={item.id} item={item} siblings={items} from={view} />
          ))}
        </ul>
        {status === 'error' ? (
          // A later page failed to load — keep every memory already gathered on
          // screen and offer a calm, non-blocking way to try for more again,
          // mirroring Timeline's later-page error handling.
          <ErrorBanner
            title="We couldn't load more memories just now"
            message="Nothing is lost — everything already here is safe on this computer. Let's try for more again."
            onRetry={loadMore}
          />
        ) : null}
        {hasMore && status !== 'error' ? (
          <div>
            <Button variant="secondary" onClick={loadMore} disabled={status === 'loadingMore'}>
              {status === 'loadingMore' ? 'Gathering more…' : 'Load more'}
            </Button>
          </div>
        ) : null}
      </>
    );
  }
}

/** `siblings` is the whole loaded page — passed straight through to ItemView so
 *  ←/→ there can step to the previous/next memory in this collection without any
 *  re-fetch or new IPC channel (#434), mirroring Timeline's MemoryCard and
 *  Search's ResultCard. `from` returns "Back" to this collection detail. */
function CollectionMemoryCard({
  item,
  siblings,
  from,
}: {
  item: ItemCardDTO;
  siblings: ItemCardDTO[];
  from: View;
}): ReactElement {
  const { navigate } = useNavigation();
  const typeLabel = MEDIA_LABEL[item.mediaType];
  const caption = (item.title ?? item.description ?? '').trim();
  const dateText = formatDate(item.captureDate);

  return (
    <li>
      <article className="flex h-full flex-col gap-3 rounded-lg border border-border-subtle bg-surface-raised p-4">
        <button
          type="button"
          onClick={() => navigate({ name: 'item', item, from, siblings })}
          aria-label={`Open ${caption.length > 0 ? caption : typeLabel}`}
          className="flex flex-col gap-3 rounded-md text-left"
        >
          <MediaThumbnail
            item={item}
            icon={MEDIA_ICON[item.mediaType]}
            className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-md bg-surface-sunken text-sage-600"
            iconClassName="h-9 w-9"
          />
          <p className="font-body text-base text-text-primary">
            {caption.length > 0 ? caption : typeLabel}
          </p>
          <p className="flex items-center gap-2 font-body text-sm text-text-secondary">
            <span>{typeLabel}</span>
            {dateText !== null ? (
              <>
                <span aria-hidden>·</span>
                <span>{dateText}</span>
              </>
            ) : null}
          </p>
        </button>
      </article>
    </li>
  );
}
