import { describe, expect, it, vi } from 'vitest';
import { installEgressSpies } from '../ac4/egress-spies';
import {
  runTranscriptionBatch,
  type TranscriptionProgress,
} from '../../electron/main/transcription/transcribe-batch';
import type {
  Transcriber,
  TranscribeContext,
  TranscribeItem,
  TranscribeResult,
  TranscribeSkipReason,
  Transcript,
} from '../../electron/main/transcription/transcribe';

function transcript(text: string): Transcript {
  return { text, language: 'es', segments: [{ startMs: 0, endMs: 10, text }] };
}
function ok(id: string): TranscribeResult {
  return { ok: true, id, transcript: transcript(`text-${id}`) };
}
function skip(id: string, reason: TranscribeSkipReason): TranscribeResult {
  return { ok: false, id, reason, message: `skip:${reason}` };
}

/** A {@link Transcriber} that runs `impl`, recording each item id + forwarded signal. */
function recordingTranscribe(
  impl: (item: TranscribeItem, ctx?: TranscribeContext) => TranscribeResult | Promise<TranscribeResult>,
): Transcriber & { calls: { id: string; signal?: AbortSignal }[] } {
  const calls: { id: string; signal?: AbortSignal }[] = [];
  const fn = (async (item: TranscribeItem, ctx?: TranscribeContext) => {
    calls.push({ id: item.id, signal: ctx?.signal });
    return impl(item, ctx);
  }) as Transcriber & { calls: { id: string; signal?: AbortSignal }[] };
  fn.calls = calls;
  return fn;
}

const items = (...ids: string[]): TranscribeItem[] =>
  ids.map((id) => ({ id, sourcePath: `/src/${id}.opus` }));

// ── happy path + summary ────────────────────────────────────────────────────

describe('runTranscriptionBatch (serial, streamed, resilient — ADR-0027 §2 / AC-20)', () => {
  it('transcribes every item serially and returns transcripts + a counted summary', async () => {
    const order: string[] = [];
    const transcribe = recordingTranscribe((item) => {
      order.push(item.id);
      return ok(item.id);
    });

    const summary = await runTranscriptionBatch({ transcribe, items: items('a', 'b', 'c') });

    expect(order).toEqual(['a', 'b', 'c']); // strictly serial (Metal/CPU — ADR-0027)
    expect(summary.total).toBe(3);
    expect(summary.transcribed).toBe(3);
    expect(summary.skipped).toBe(0);
    expect(summary.cancelled).toBe(0);
    expect(summary.outcomes.map((o) => o.status)).toEqual(['transcribed', 'transcribed', 'transcribed']);
    expect(summary.outcomes[0].transcript?.text).toBe('text-a');
  });

  it('keeps the summary invariant total === transcribed + skipped + cancelled', async () => {
    const transcribe = recordingTranscribe((item) =>
      item.id === 'a' ? ok('a') : item.id === 'b' ? skip('b', 'no-speech') : skip('c', 'whisper-failed'),
    );
    const summary = await runTranscriptionBatch({ transcribe, items: items('a', 'b', 'c') });
    expect(summary.transcribed + summary.skipped + summary.cancelled).toBe(summary.total);
    expect(summary.transcribed).toBe(1);
    expect(summary.skipped).toBe(2);
  });

  it('returns an all-zero summary and only a batch-done event for an empty batch', async () => {
    const events: TranscriptionProgress[] = [];
    const transcribe = recordingTranscribe(() => ok('never'));
    const summary = await runTranscriptionBatch({
      transcribe,
      items: [],
      onProgress: (p) => events.push(p),
    });
    expect(summary).toMatchObject({ total: 0, transcribed: 0, skipped: 0, cancelled: 0 });
    expect(transcribe.calls).toHaveLength(0);
    expect(events.map((e) => e.phase)).toEqual(['batch-done']);
  });
});

// ── streamed progress ───────────────────────────────────────────────────────

describe('runTranscriptionBatch progress (streamed per-item lifecycle — AC-18 surface)', () => {
  it('emits item-start then item-done per item, then a final batch-done with counts', async () => {
    const events: TranscriptionProgress[] = [];
    const transcribe = recordingTranscribe((item) => (item.id === 'b' ? skip('b', 'no-speech') : ok(item.id)));

    await runTranscriptionBatch({
      transcribe,
      items: items('a', 'b'),
      onProgress: (p) => events.push(p),
    });

    expect(events.map((e) => e.phase)).toEqual([
      'item-start',
      'item-done',
      'item-start',
      'item-done',
      'batch-done',
    ]);
    const first = events[0];
    expect(first).toMatchObject({ phase: 'item-start', index: 0, total: 2, id: 'a' });
    const firstDone = events[1];
    if (firstDone.phase !== 'item-done') throw new Error('expected item-done');
    expect(firstDone.outcome).toMatchObject({ id: 'a', status: 'transcribed' });
    const secondDone = events[3];
    if (secondDone.phase !== 'item-done') throw new Error('expected item-done');
    expect(secondDone.outcome).toMatchObject({ id: 'b', status: 'no-speech' });
    const done = events[4];
    if (done.phase !== 'batch-done') throw new Error('expected batch-done');
    expect(done).toMatchObject({ total: 2, transcribed: 1, skipped: 1, cancelled: 0 });
  });
});

// ── resilience: a failed item never aborts the batch (AC-20) ─────────────────

describe('runTranscriptionBatch resilience (a bad item is skipped, never aborts — AC-20)', () => {
  it('processes every item even when some fail, carrying the typed status through', async () => {
    const transcribe = recordingTranscribe((item) => {
      switch (item.id) {
        case 'b':
          return skip('b', 'decode-failed');
        case 'd':
          return skip('d', 'whisper-timed-out');
        default:
          return ok(item.id);
      }
    });

    const summary = await runTranscriptionBatch({ transcribe, items: items('a', 'b', 'c', 'd', 'e') });

    expect(transcribe.calls.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(summary.outcomes.map((o) => o.status)).toEqual([
      'transcribed',
      'decode-failed',
      'transcribed',
      'whisper-timed-out',
      'transcribed',
    ]);
    expect(summary.transcribed).toBe(3);
    expect(summary.skipped).toBe(2);
  });

  it('contains an UNEXPECTED throw from the transcriber and keeps going (defensive AC-20)', async () => {
    const transcribe = recordingTranscribe((item) => {
      if (item.id === 'b') throw new Error('kaboom');
      return ok(item.id);
    });

    const summary = await runTranscriptionBatch({ transcribe, items: items('a', 'b', 'c') });

    expect(transcribe.calls.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(summary.outcomes[1]).toMatchObject({ id: 'b', status: 'whisper-failed', transcript: null });
    expect(summary.transcribed).toBe(2);
    expect(summary.skipped).toBe(1);
  });
});

// ── cooperative cancel (AC-20: kills in-flight, marks the rest cancelled) ─────

describe('runTranscriptionBatch cancel (forwards the kill signal, stops the queue — AC-20)', () => {
  it('forwards the batch AbortSignal to the executor so a cancel kills the in-flight child', async () => {
    const controller = new AbortController();
    const transcribe = recordingTranscribe((item) => ok(item.id));

    await runTranscriptionBatch({ transcribe, items: items('a', 'b'), signal: controller.signal });

    expect(transcribe.calls[0].signal).toBe(controller.signal);
    expect(transcribe.calls[1].signal).toBe(controller.signal);
  });

  it('stops dispatching and marks the remaining items cancelled once the signal fires mid-batch', async () => {
    const controller = new AbortController();
    const transcribe = recordingTranscribe((item) => {
      if (item.id === 'b') {
        controller.abort(); // the in-flight child is killed → executor returns a cancelled skip
        return skip('b', 'cancelled');
      }
      return ok(item.id);
    });

    const summary = await runTranscriptionBatch({
      transcribe,
      items: items('a', 'b', 'c', 'd'),
      signal: controller.signal,
    });

    // c and d are NEVER dispatched (no work after a cancel — AC-20).
    expect(transcribe.calls.map((c) => c.id)).toEqual(['a', 'b']);
    expect(summary.outcomes.map((o) => o.status)).toEqual([
      'transcribed',
      'cancelled',
      'cancelled',
      'cancelled',
    ]);
    expect(summary.cancelled).toBe(3);
    expect(summary.transcribed).toBe(1);
  });

  it('dispatches nothing and marks every item cancelled when already aborted before start', async () => {
    const transcribe = recordingTranscribe((item) => ok(item.id));

    const summary = await runTranscriptionBatch({
      transcribe,
      items: items('a', 'b'),
      signal: AbortSignal.abort(),
    });

    expect(transcribe.calls).toHaveLength(0);
    expect(summary.cancelled).toBe(2);
    expect(summary.outcomes.every((o) => o.status === 'cancelled' && o.transcript === null)).toBe(true);
  });
});

// ── idempotence: re-running is safe, no duplicate work (AC-20) ───────────────

describe('runTranscriptionBatch idempotence (re-run safe, no duplicate work — AC-20)', () => {
  it('skips a duplicate id within the same run rather than transcribing it twice', async () => {
    const transcribe = recordingTranscribe((item) => ok(item.id));

    const summary = await runTranscriptionBatch({ transcribe, items: items('a', 'a', 'b') });

    expect(transcribe.calls.map((c) => c.id)).toEqual(['a', 'b']); // 'a' transcribed once
    expect(summary.outcomes.map((o) => o.status)).toEqual([
      'transcribed',
      'skipped-existing',
      'transcribed',
    ]);
  });

  it('honours a skipWhen predicate (the #135 transcript_status hook) without transcribing', async () => {
    const transcribe = recordingTranscribe((item) => ok(item.id));
    const done = new Set(['b']);

    const summary = await runTranscriptionBatch({
      transcribe,
      items: items('a', 'b', 'c'),
      skipWhen: (item) => done.has(item.id),
    });

    expect(transcribe.calls.map((c) => c.id)).toEqual(['a', 'c']); // 'b' already done → not re-run
    expect(summary.outcomes[1]).toMatchObject({ id: 'b', status: 'skipped-existing', transcript: null });
  });

  it('supports an async skipWhen predicate (DB lookups are async in #135)', async () => {
    const transcribe = recordingTranscribe((item) => ok(item.id));

    const summary = await runTranscriptionBatch({
      transcribe,
      items: items('a', 'b'),
      skipWhen: async (item) => Promise.resolve(item.id === 'a'),
    });

    expect(transcribe.calls.map((c) => c.id)).toEqual(['b']);
    expect(summary.outcomes[0]).toMatchObject({ id: 'a', status: 'skipped-existing' });
  });

  // ── #150: a throwing/rejecting skipWhen must NOT abort the whole batch ───────

  it('contains a THROWING skipWhen and still processes the rest of the batch (#150)', async () => {
    const transcribe = recordingTranscribe((item) => ok(item.id));

    const summary = await runTranscriptionBatch({
      transcribe,
      items: items('a', 'b', 'c'),
      skipWhen: (item) => {
        if (item.id === 'b') throw new Error('transcript_status lookup exploded');
        return false;
      },
    });

    // The throw on 'b' is contained: treated as "not done" → 'b' is transcribed,
    // and the batch carries on to 'c' instead of aborting (the 'batch never aborts'
    // contract — the predicate is the #135 transcript_status seam).
    expect(transcribe.calls.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(summary.outcomes.map((o) => o.status)).toEqual([
      'transcribed',
      'transcribed',
      'transcribed',
    ]);
    expect(summary.transcribed).toBe(3);
    expect(summary.cancelled).toBe(0);
  });

  it('contains a REJECTING async skipWhen and still processes the rest (#150)', async () => {
    const transcribe = recordingTranscribe((item) => ok(item.id));

    const summary = await runTranscriptionBatch({
      transcribe,
      items: items('a', 'b', 'c'),
      skipWhen: async (item) => {
        if (item.id === 'a') throw new Error('async db error');
        return item.id === 'c'; // 'c' legitimately already done
      },
    });

    // 'a' rejects → treated as not done → transcribed; 'b' transcribed; 'c' skipped.
    expect(transcribe.calls.map((c) => c.id)).toEqual(['a', 'b']);
    expect(summary.outcomes.map((o) => o.status)).toEqual([
      'transcribed',
      'transcribed',
      'skipped-existing',
    ]);
    expect(summary.transcribed).toBe(2);
    expect(summary.skipped).toBe(1);
  });

  it('warns with a diagnostic when a skipWhen predicate throws so a persistent fault is observable (#155)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const transcribe = recordingTranscribe((item) => ok(item.id));

      const summary = await runTranscriptionBatch({
        transcribe,
        items: items('a', 'b'),
        skipWhen: (item) => {
          if (item.id === 'b') throw new Error('transcript_status lookup exploded');
          return false;
        },
      });

      // Fail-closed behavior is unchanged — the throw is still contained and the
      // item is treated as not-done — but the swallowed error must now leave a
      // trace so a persistently-throwing predicate is diagnosable, not silent.
      expect(summary.transcribed).toBe(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.join(' ')).toMatch(/skipWhen|transcript_status lookup exploded/i);
    } finally {
      warn.mockRestore();
    }
  });
});

// ── no egress (AC-4) ────────────────────────────────────────────────────────

describe('runTranscriptionBatch (no egress — AC-4)', () => {
  it('makes no network call while orchestrating a batch', async () => {
    const spies = installEgressSpies();
    try {
      const transcribe = recordingTranscribe((item) => ok(item.id));
      await runTranscriptionBatch({ transcribe, items: items('a', 'b') });
      spies.assertNoEgress();
    } finally {
      spies.restore();
    }
  });
});
