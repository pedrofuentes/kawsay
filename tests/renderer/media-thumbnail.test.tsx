import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { KawsayApiProvider } from '@renderer/lib/kawsay-api';
import { MediaThumbnail } from '@renderer/components/MediaThumbnail';
import type { ItemCardDTO } from '@shared/kawsay-api';
import { makeFakeApi, makeItemCard } from './support/fake-api';
import type { FakeApi } from './support/fake-api';

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function renderThumb(item: ItemCardDTO, api: FakeApi) {
  return render(
    <KawsayApiProvider api={api}>
      <MediaThumbnail item={item} icon="photos" />
    </KawsayApiProvider>,
  );
}

/** Install a matchMedia stub answering the reduced-motion query deterministically. */
function stubReducedMotion(reduced: boolean): void {
  const mql = {
    matches: reduced,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
  (window as unknown as { matchMedia: unknown }).matchMedia = vi.fn().mockReturnValue(mql);
}

afterEach(() => {
  // jsdom ships no matchMedia; deleting any stub restores the default absence.
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

describe('MediaThumbnail (real photo/video thumbnails with icon fallback — U4)', () => {
  it('shows ONLY the media-type icon and never fetches for a non-renderable item', () => {
    const getThumbnail = vi.fn(() => Promise.resolve(null));
    const api = makeFakeApi({ getThumbnail });
    const { container } = renderThumb(makeItemCard({ hasThumbnail: false }), api);

    expect(getThumbnail).not.toHaveBeenCalled();
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('lazily fetches by opaque id and renders the real thumbnail as an <img>', async () => {
    const dataUrl = 'data:image/jpeg;base64,AAAA';
    const getThumbnail = vi.fn(() => Promise.resolve<string | null>(dataUrl));
    const api = makeFakeApi({ getThumbnail });
    renderThumb(makeItemCard({ id: UUID, hasThumbnail: true, title: 'Beach day' }), api);

    const img = await screen.findByRole('img');
    expect(img).toHaveAttribute('src', dataUrl);
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');
    // The renderer passes ONLY the opaque id — never a path.
    expect(getThumbnail).toHaveBeenCalledWith({ id: UUID });
  });

  it('falls back to the media-type icon when the thumbnail resolves to null', async () => {
    const getThumbnail = vi.fn(() => Promise.resolve(null));
    const api = makeFakeApi({ getThumbnail });
    const { container } = renderThumb(makeItemCard({ hasThumbnail: true }), api);

    await waitFor(() => expect(getThumbnail).toHaveBeenCalled());
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('falls back to the icon when the fetch rejects (never throws to the user)', async () => {
    const getThumbnail = vi.fn(() => Promise.reject(new Error('SQLITE_BUSY')));
    const api = makeFakeApi({ getThumbnail });
    const { container } = renderThumb(makeItemCard({ hasThumbnail: true }), api);

    await waitFor(() => expect(getThumbnail).toHaveBeenCalled());
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('uses the item caption as escaped alt text (untrusted titles are DATA, not markup)', async () => {
    const malicious = '<img src=x onerror="window.__pwned = true">';
    const getThumbnail = vi.fn(() => Promise.resolve<string | null>('data:image/png;base64,AAAA'));
    const api = makeFakeApi({ getThumbnail });
    const { container } = renderThumb(makeItemCard({ hasThumbnail: true, title: malicious }), api);

    const img = await screen.findByRole('img');
    // The payload is the alt VALUE (a string), not parsed into nodes…
    expect(img).toHaveAttribute('alt', malicious);
    // …so no second <img> was smuggled in and no inline handler ran.
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it('omits the fade transition under reduced motion (the default posture)', async () => {
    // No matchMedia stub → the hook treats reduced motion as the default.
    const getThumbnail = vi.fn(() => Promise.resolve<string | null>('data:image/jpeg;base64,AAAA'));
    const api = makeFakeApi({ getThumbnail });
    renderThumb(makeItemCard({ hasThumbnail: true }), api);

    const img = await screen.findByRole('img');
    expect(img.className).not.toContain('thumb-fade-in');
  });

  it('applies the gentle fade-in when motion is allowed', async () => {
    stubReducedMotion(false);
    const getThumbnail = vi.fn(() => Promise.resolve<string | null>('data:image/jpeg;base64,AAAA'));
    const api = makeFakeApi({ getThumbnail });
    renderThumb(makeItemCard({ hasThumbnail: true }), api);

    const img = await screen.findByRole('img');
    expect(img.className).toContain('thumb-fade-in');
  });

  it('bounds the renderer thumbnail memo so long scrolling cannot grow it forever', async () => {
    const getThumbnail = vi.fn(({ id }: { id: string }) =>
      Promise.resolve<string | null>(`data:image/jpeg;base64,${btoa(id)}`),
    );
    const api = makeFakeApi({ getThumbnail });
    const oldest = makeItemCard({ id: 'cache-bound-000', hasThumbnail: true });
    const items = [
      oldest,
      ...Array.from({ length: 256 }, (_unused, i) =>
        makeItemCard({ id: `cache-bound-${String(i + 1).padStart(3, '0')}`, hasThumbnail: true }),
      ),
    ];

    const mounted = render(
      <KawsayApiProvider api={api}>
        {items.map((item) => (
          <MediaThumbnail key={item.id} item={item} icon="photos" />
        ))}
      </KawsayApiProvider>,
    );
    await waitFor(() => expect(getThumbnail).toHaveBeenCalledTimes(257));

    mounted.unmount();
    renderThumb(oldest, api);

    await waitFor(() => expect(getThumbnail).toHaveBeenCalledTimes(258));
    expect(getThumbnail).toHaveBeenLastCalledWith({ id: oldest.id });
  });
});
