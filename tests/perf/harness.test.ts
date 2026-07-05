import { describe, expect, it } from 'vitest';
import {
  buildMeasurement,
  computeRtf,
  formatMarkdownResults,
  parseFixtureManifest,
  summarizeMeasurements,
  wavDurationSeconds,
  type ClipMeasurement,
} from './harness';

// A minimal 16 kHz mono PCM s16le WAV of `seconds` (silent) — whisper's input
// shape and the exact format `createFfmpegAudioExtractor` produces, so the
// duration parser is exercised on a realistic header (mirrors transcribe.test.ts).
function makeMonoWav(rate: number, seconds: number): Buffer {
  const channels = 1;
  const bytesPerSample = 2;
  const frames = Math.floor(rate * seconds);
  const dataLen = frames * channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(8 * bytesPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

const VALID_MANIFEST = JSON.stringify({
  source: 'Tatoeba (https://tatoeba.org)',
  license: 'Sentence text CC BY 2.0 FR; audio per-clip CC BY 4.0 / CC0 1.0 (see NOTICES.md)',
  normalization: 'NFC, lowercase, strip non-letter/number, collapse whitespace',
  clips: [
    {
      id: 'es-941424',
      language: 'es',
      file: 'es_941424.mp3',
      url: 'https://audio.tatoeba.org/sentences/spa/941424.mp3',
      sha256: '73943b909f4c2fe9ef61d9f7476915e3d50f1125617b75a75dda645e51698899',
      transcript: 'Ella va a la escuela caminando.',
      license: 'CC BY 4.0',
      attribution: 'hayastan (Tatoeba)',
    },
  ],
});

describe('parseFixtureManifest', () => {
  it('parses a valid manifest into typed clips', () => {
    const manifest = parseFixtureManifest(VALID_MANIFEST);
    expect(manifest.clips).toHaveLength(1);
    expect(manifest.clips[0]).toMatchObject({
      id: 'es-941424',
      language: 'es',
      file: 'es_941424.mp3',
      transcript: 'Ella va a la escuela caminando.',
    });
  });

  it('throws on a manifest with no clips', () => {
    expect(() => parseFixtureManifest(JSON.stringify({ clips: [] }))).toThrow();
  });

  it('throws on a clip with a malformed sha256 (not 64 lowercase hex)', () => {
    const bad = JSON.parse(VALID_MANIFEST) as { clips: { sha256: string }[] };
    bad.clips[0].sha256 = 'NOTAHASH';
    expect(() => parseFixtureManifest(JSON.stringify(bad))).toThrow();
  });

  it('throws on a clip whose url is not https (egress/provenance hygiene)', () => {
    const bad = JSON.parse(VALID_MANIFEST) as { clips: { url: string }[] };
    bad.clips[0].url = 'http://audio.tatoeba.org/sentences/spa/941424.mp3';
    expect(() => parseFixtureManifest(JSON.stringify(bad))).toThrow();
  });

  it('throws on a clip whose file is not a safe basename (path-traversal guard)', () => {
    const bad = JSON.parse(VALID_MANIFEST) as { clips: { file: string }[] };
    bad.clips[0].file = '../../etc/passwd';
    expect(() => parseFixtureManifest(JSON.stringify(bad))).toThrow();
  });

  it('throws on a clip with an empty ground-truth transcript', () => {
    const bad = JSON.parse(VALID_MANIFEST) as { clips: { transcript: string }[] };
    bad.clips[0].transcript = '';
    expect(() => parseFixtureManifest(JSON.stringify(bad))).toThrow();
  });

  it('throws on invalid JSON', () => {
    expect(() => parseFixtureManifest('{ not json')).toThrow();
  });
});

describe('wavDurationSeconds (parse RIFF/WAVE header → seconds)', () => {
  it('computes the duration of a 16 kHz mono s16le WAV from its data chunk', () => {
    expect(wavDurationSeconds(makeMonoWav(16_000, 1))).toBeCloseTo(1, 6);
    expect(wavDurationSeconds(makeMonoWav(16_000, 0.5))).toBeCloseTo(0.5, 6);
    expect(wavDurationSeconds(makeMonoWav(16_000, 2.5))).toBeCloseTo(2.5, 6);
  });

  it('throws on a buffer that is not a RIFF/WAVE file', () => {
    expect(() => wavDurationSeconds(Buffer.from('not a wav at all'))).toThrow();
  });
});

describe('computeRtf (processing time ÷ audio duration)', () => {
  it('is < 1 when faster than real time', () => {
    expect(computeRtf(500, 1)).toBeCloseTo(0.5, 10);
  });

  it('is > 1 when slower than real time', () => {
    expect(computeRtf(2000, 1)).toBeCloseTo(2, 10);
  });

  it('scales with the audio duration', () => {
    expect(computeRtf(1000, 2)).toBeCloseTo(0.5, 10);
  });

  it('throws when the audio duration is non-positive or non-finite', () => {
    expect(() => computeRtf(1000, 0)).toThrow();
    expect(() => computeRtf(1000, -1)).toThrow();
    expect(() => computeRtf(1000, Number.NaN)).toThrow();
  });
});

describe('buildMeasurement (combine a timed transcription with the ground truth)', () => {
  it('produces an ok measurement with WER + RTF for a successful transcription', () => {
    const measurement = buildMeasurement(
      { id: 'es-1', language: 'es', transcript: 'el gato negro' },
      {
        result: {
          ok: true,
          id: 'es-1',
          transcript: { text: 'el perro negro', language: 'es', segments: [] },
        },
        inferenceMs: 500,
        audioDurationSec: 2,
      },
    );
    expect(measurement.ok).toBe(true);
    if (!measurement.ok) return;
    expect(measurement.language).toBe('es');
    expect(measurement.detectedLanguage).toBe('es');
    expect(measurement.hypothesis).toBe('el perro negro');
    expect(measurement.referenceWordCount).toBe(3);
    expect(measurement.errorCount).toBe(1);
    expect(measurement.wer).toBeCloseTo(1 / 3, 10);
    expect(measurement.audioDurationSec).toBe(2);
    expect(measurement.inferenceMs).toBe(500);
    expect(measurement.rtf).toBeCloseTo(0.25, 10);
  });

  it('produces a skip measurement (carrying the reason) for a skipped transcription', () => {
    const measurement = buildMeasurement(
      { id: 'es-2', language: 'es', transcript: 'hola' },
      {
        result: { ok: false, id: 'es-2', reason: 'no-speech', message: 'whisper produced no speech' },
        inferenceMs: 0,
        audioDurationSec: 1,
      },
    );
    expect(measurement.ok).toBe(false);
    if (measurement.ok) return;
    expect(measurement.reason).toBe('no-speech');
    expect(measurement.language).toBe('es');
  });

  it('records a skip (not a thrown RangeError) for a zero-duration decode', () => {
    const measurement = buildMeasurement(
      { id: 'es-3', language: 'es', transcript: 'hola mundo' },
      {
        result: {
          ok: true,
          id: 'es-3',
          transcript: { text: 'hola mundo', language: 'es', segments: [] },
        },
        inferenceMs: 500,
        audioDurationSec: 0,
      },
    );
    expect(measurement.ok).toBe(false);
    if (measurement.ok) return;
    expect(measurement.reason).toBe('zero-duration-audio');
    expect(measurement.id).toBe('es-3');
    expect(measurement.language).toBe('es');
  });
});

describe('summarizeMeasurements', () => {
  const measurements: ClipMeasurement[] = [
    {
      ok: true,
      id: 'es-1',
      language: 'es',
      detectedLanguage: 'es',
      hypothesis: '',
      referenceWordCount: 4,
      errorCount: 1,
      wer: 0.25,
      audioDurationSec: 2,
      inferenceMs: 1000,
      rtf: 0.5,
    },
    {
      ok: true,
      id: 'es-2',
      language: 'es',
      detectedLanguage: 'es',
      hypothesis: '',
      referenceWordCount: 6,
      errorCount: 2,
      wer: 1 / 3,
      audioDurationSec: 4,
      inferenceMs: 1000,
      rtf: 0.25,
    },
    {
      ok: true,
      id: 'de-1',
      language: 'de',
      detectedLanguage: 'de',
      hypothesis: '',
      referenceWordCount: 5,
      errorCount: 0,
      wer: 0,
      audioDurationSec: 2,
      inferenceMs: 2000,
      rtf: 1,
    },
    { ok: false, id: 'de-2', language: 'de', reason: 'no-speech', message: 'no speech' },
  ];

  it('computes per-language aggregate (micro) WER and mean RTF over ok clips', () => {
    const summary = summarizeMeasurements(measurements);
    const es = summary.perLanguage.find((l) => l.language === 'es');
    const de = summary.perLanguage.find((l) => l.language === 'de');
    expect(es).toBeDefined();
    expect(de).toBeDefined();
    if (!es || !de) return;

    // es: (1 + 2) errors / (4 + 6) ref words = 0.3 aggregate WER.
    expect(es.aggregateWer).toBeCloseTo(0.3, 10);
    expect(es.totalErrors).toBe(3);
    expect(es.totalReferenceWords).toBe(10);
    expect(es.okCount).toBe(2);
    expect(es.meanRtf).toBeCloseTo((0.5 + 0.25) / 2, 10);

    // de: 1 ok clip (0 errors / 5 words) + 1 skip (not counted in WER).
    expect(de.aggregateWer).toBe(0);
    expect(de.okCount).toBe(1);
    expect(de.clipCount).toBe(2);
    expect(de.meanRtf).toBeCloseTo(1, 10);
  });

  it('computes an overall aggregate WER and mean RTF across all ok clips', () => {
    const summary = summarizeMeasurements(measurements);
    // overall: 3 errors / 15 ref words = 0.2.
    expect(summary.overall.aggregateWer).toBeCloseTo(0.2, 10);
    expect(summary.overall.okCount).toBe(3);
    expect(summary.overall.clipCount).toBe(4);
    expect(summary.overall.meanRtf).toBeCloseTo((0.5 + 0.25 + 1) / 3, 10);
  });

  it('reports language auto-detection accuracy (detected === labelled, over ok clips)', () => {
    // In the shared fixture every ok clip's detectedLanguage matches its label.
    const summary = summarizeMeasurements(measurements);
    const es = summary.perLanguage.find((l) => l.language === 'es');
    expect(es?.detectedCount).toBe(2);
    expect(es?.detectionAccuracy).toBe(1);
    expect(summary.overall.detectedCount).toBe(3);
    expect(summary.overall.detectionAccuracy).toBe(1);
  });

  it('counts a mismatched detected language (e.g. short es clip detected as it) as a miss', () => {
    // Mirrors the real measurement: one short Spanish clip auto-detects as Italian.
    const withMissedLid: ClipMeasurement[] = [
      {
        ok: true,
        id: 'es-good',
        language: 'es',
        detectedLanguage: 'es',
        hypothesis: '',
        referenceWordCount: 8,
        errorCount: 0,
        wer: 0,
        audioDurationSec: 3,
        inferenceMs: 600,
        rtf: 0.2,
      },
      {
        ok: true,
        id: 'es-short',
        language: 'es',
        detectedLanguage: 'it',
        hypothesis: '',
        referenceWordCount: 6,
        errorCount: 5,
        wer: 5 / 6,
        audioDurationSec: 3,
        inferenceMs: 600,
        rtf: 0.2,
      },
    ];
    const summary = summarizeMeasurements(withMissedLid);
    const es = summary.perLanguage.find((l) => l.language === 'es');
    expect(es?.okCount).toBe(2);
    expect(es?.detectedCount).toBe(1);
    expect(es?.detectionAccuracy).toBeCloseTo(0.5, 10);
    expect(summary.overall.detectionAccuracy).toBeCloseTo(0.5, 10);
  });

  it('reports a detection accuracy of 0 when there are no ok clips (no divide-by-zero)', () => {
    const summary = summarizeMeasurements([
      { ok: false, id: 'x', language: 'es', reason: 'no-speech', message: 'no speech' },
    ]);
    expect(summary.overall.detectedCount).toBe(0);
    expect(summary.overall.detectionAccuracy).toBe(0);
  });
});

describe('formatMarkdownResults', () => {
  it('renders a markdown table with a per-language row, an overall row, and WER/RTF columns', () => {
    const summary = summarizeMeasurements([
      {
        ok: true,
        id: 'es-1',
        language: 'es',
        detectedLanguage: 'es',
        hypothesis: '',
        referenceWordCount: 4,
        errorCount: 1,
        wer: 0.25,
        audioDurationSec: 2,
        inferenceMs: 1000,
        rtf: 0.5,
      },
    ]);
    const md = formatMarkdownResults(summary, []);
    expect(md).toContain('WER');
    expect(md).toContain('RTF');
    expect(md).toContain('Detected');
    expect(md).toMatch(/\bes\b/);
    expect(md.toLowerCase()).toContain('overall');
  });

  it('escapes backslashes as well as pipes in detail cells so the table stays unambiguous', () => {
    const measurements: ClipMeasurement[] = [
      {
        ok: true,
        id: 'es-1',
        language: 'es',
        detectedLanguage: 'es',
        hypothesis: 'a\\|b',
        referenceWordCount: 4,
        errorCount: 1,
        wer: 0.25,
        audioDurationSec: 2,
        inferenceMs: 1000,
        rtf: 0.5,
      },
      {
        ok: false,
        id: 'es-2',
        language: 'es',
        reason: 'no-speech',
        message: 'x\\|y',
      },
    ];
    const summary = summarizeMeasurements(measurements);
    const md = formatMarkdownResults(summary, measurements);
    // A literal backslash must be escaped to `\\` before the pipe is escaped to
    // `\|`, so `a\|b` renders as `a\\\|b` — never the ambiguous `a\\|b`, which a
    // markdown reader would parse as an escaped backslash plus a cell delimiter.
    expect(md).toContain('a\\\\\\|b');
    expect(md).toContain('x\\\\\\|y');
  });
});
