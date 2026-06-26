// Reads ONE item's transcript for the item view (#136). Audio and video carry
// spoken words; everything else has none, so the hook only ever fetches for those
// two media types (a photo never reaches over the bridge). It also tracks whether
// a transcription run is active — so a not-yet-done item can honestly say it is
// "transcribing now" rather than "not transcribed yet" — and quietly refetches the
// moment the run reports THIS item has settled, so the words appear on their own.
import { useEffect, useState } from 'react';
import type {
  ItemCardDTO,
  TranscriptSegmentDTO,
  TranscriptStatusDTO,
  TranscriptViewDTO,
} from '@shared/kawsay-api';
import { useKawsayApi } from './kawsay-api';

export interface UseTranscriptResult {
  /** The item's transcript status, or null while the first read is in flight. */
  status: TranscriptStatusDTO | null;
  /** The whisper-detected language tag (e.g. `es`), or null when none/undetected. */
  language: string | null;
  /** The spoken words, or null until a `done` transcript has loaded. */
  text: string | null;
  /** Millisecond-timed segments (empty unless done). */
  segments: TranscriptSegmentDTO[];
  /** True while the first transcript read is in flight. */
  loading: boolean;
  /** True while a transcription run is in progress (so pending reads "transcribing"). */
  runActive: boolean;
}

function isTranscribable(item: ItemCardDTO): boolean {
  return item.mediaType === 'audio' || item.mediaType === 'video';
}

export function useTranscript(item: ItemCardDTO): UseTranscriptResult {
  const api = useKawsayApi();
  const itemId = item.id;
  const transcribable = isTranscribable(item);

  const [view, setView] = useState<TranscriptViewDTO | null>(null);
  const [loading, setLoading] = useState(transcribable);
  const [runActive, setRunActive] = useState(false);
  // Bumped when the run reports this item settled, to re-pull its now-ready words.
  const [refreshKey, setRefreshKey] = useState(0);

  // Track run activity (mount read + live stream) so a pending item can tell
  // "transcribing now" from "not transcribed yet", and refetch when it settles.
  useEffect(() => {
    if (api === undefined || !transcribable) {
      return undefined;
    }
    let active = true;
    void api
      .getTranscriptionStatus()
      .then((snap) => {
        if (active) {
          setRunActive(snap.state === 'running');
        }
      })
      .catch(() => {
        // A failed read just means we can't confirm a run; default to not-running.
      });
    const unsubscribe = api.onTranscriptionProgress((event) => {
      setRunActive(event.state === 'running');
      if (event.lastItem?.id === itemId) {
        setRefreshKey((key) => key + 1);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, transcribable, itemId]);

  // Fetch this item's transcript by opaque id — audio/video only.
  useEffect(() => {
    if (api === undefined || !transcribable) {
      setLoading(false);
      return undefined;
    }
    let active = true;
    setLoading(true);
    void api
      .getTranscript({ id: itemId })
      .then((next) => {
        if (active) {
          setView(next);
          setLoading(false);
        }
      })
      .catch(() => {
        // A rejected read leaves the calm "looking…" placeholder rather than an
        // alarming error; the next run or reopen will try again.
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [api, transcribable, itemId, refreshKey]);

  return {
    status: transcribable ? (view?.status ?? null) : null,
    language: view?.language ?? null,
    text: view?.text ?? null,
    segments: view?.segments ?? [],
    loading,
    runActive,
  };
}
