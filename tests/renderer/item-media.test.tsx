// The explicit-intent media player shown inside a memory (Journey F / #428). A
// loved one's voice or a home video is PLAYABLE here with keyboard-accessible
// controls, and a photo opens full-size — but nothing ever plays on its own (P6:
// "a loved one's voice never ambushes a grieving user"). The bytes arrive over the
// hardened, local-only `kawsay-media:` protocol; the renderer only ever names the
// opaque id, never a path.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ItemMedia } from '@renderer/components/ItemMedia';
import { mediaUrl } from '@shared/media';
import { makeItemCard } from './support/fake-api';
import { expectNoAxeViolations } from './support/axe';

describe('ItemMedia — explicit-intent playback (never autoplay) (#428)', () => {
  it('renders a keyboard-accessible audio player for a voice note — and does NOT autoplay', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    try {
      const item = makeItemCard({
        id: '00000000-0000-4000-8000-0000000000c1',
        mediaType: 'audio',
        title: "Grandpa's voice",
      });
      const { container } = render(<ItemMedia item={item} />);

      const audio = container.querySelector('audio');
      expect(audio).not.toBeNull();
      // Native controls = a visible, keyboard-operable play affordance.
      expect(audio).toHaveAttribute('controls');
      // NEVER autoplay: neither the attribute nor the property, and .play() is not
      // called on mount — the voice waits for the user's explicit intent.
      expect(audio).not.toHaveAttribute('autoplay');
      expect((audio as HTMLMediaElement).autoplay).toBe(false);
      expect(play).not.toHaveBeenCalled();
      // The bytes are named by opaque id over the local protocol — never a path.
      expect(audio).toHaveAttribute('src', mediaUrl(item.id));
    } finally {
      play.mockRestore();
    }
  });

  it('renders a keyboard-accessible video player — with controls, never autoplay', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    try {
      const item = makeItemCard({
        id: '00000000-0000-4000-8000-0000000000c2',
        mediaType: 'video',
        title: 'Home movie',
      });
      const { container } = render(<ItemMedia item={item} />);

      const video = container.querySelector('video');
      expect(video).not.toBeNull();
      expect(video).toHaveAttribute('controls');
      expect(video).not.toHaveAttribute('autoplay');
      expect((video as HTMLMediaElement).autoplay).toBe(false);
      expect(play).not.toHaveBeenCalled();
      expect(video).toHaveAttribute('src', mediaUrl(item.id));
    } finally {
      play.mockRestore();
    }
  });

  it('opens a photo full-size over the local protocol, with alt text from its caption', () => {
    const item = makeItemCard({
      id: '00000000-0000-4000-8000-0000000000c3',
      mediaType: 'photo',
      title: 'Sunset over the bay',
    });
    const { container } = render(<ItemMedia item={item} />);

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', mediaUrl(item.id));
    expect(img).toHaveAttribute('alt', 'Sunset over the bay');
    // No player chrome for a still image.
    expect(container.querySelector('audio, video')).toBeNull();
  });

  it('gives the player an accessible name so a screen-reader user knows what it plays', () => {
    const item = makeItemCard({ mediaType: 'audio', title: 'A lullaby' });
    render(<ItemMedia item={item} />);
    // The player is reachable by an accessible name (aria-label / labelled region).
    expect(screen.getByLabelText(/lullaby|voice|play/i)).toBeInTheDocument();
  });

  it('renders no media element for a non-playable memory (document/message)', () => {
    for (const mediaType of ['document', 'message'] as const) {
      const item = makeItemCard({ mediaType });
      const { container, unmount } = render(<ItemMedia item={item} />);
      expect(container.querySelector('audio, video, img')).toBeNull();
      unmount();
    }
  });

  it('falls back to a calm message when a voice note fails to load (never a broken element)', () => {
    const item = makeItemCard({ mediaType: 'audio', title: 'A voice note' });
    const { container } = render(<ItemMedia item={item} />);

    const audio = container.querySelector('audio');
    expect(audio).not.toBeNull();
    fireEvent.error(audio as HTMLElement);

    // The broken player is replaced by a gentle, non-technical fallback.
    expect(container.querySelector('audio')).toBeNull();
    expect(screen.getByText(/couldn't play|couldn’t play|couldn't be played|couldn’t be played/i)).toBeInTheDocument();
  });

  it('falls back gracefully when a photo fails to load', () => {
    const item = makeItemCard({ mediaType: 'photo', title: 'A view' });
    const { container } = render(<ItemMedia item={item} />);

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    fireEvent.error(img as HTMLElement);

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/couldn't show|couldn’t show|couldn't be shown|couldn’t be shown|couldn't play|couldn’t play/i)).toBeInTheDocument();
  });

  it('has no axe violations for audio, video, or a full-size photo', async () => {
    const audio = render(<ItemMedia item={makeItemCard({ mediaType: 'audio', title: 'A calm note' })} />);
    await expectNoAxeViolations(audio.container);
    audio.unmount();

    const video = render(<ItemMedia item={makeItemCard({ mediaType: 'video', title: 'A calm clip' })} />);
    await expectNoAxeViolations(video.container);
    video.unmount();

    const photo = render(<ItemMedia item={makeItemCard({ mediaType: 'photo', title: 'A calm view' })} />);
    await expectNoAxeViolations(photo.container);
    photo.unmount();
  });
});
