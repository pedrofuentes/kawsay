import { describe, expect, it } from 'vitest';
import {
  WhisperOutputError,
  evaluateWhisperRun,
  extractTranscriptText,
  normalizeTranscript,
  transcriptContainsPhrase,
} from './whisper-egress';

// A faithful slice of a whisper.cpp v1.9.1 `-oj` document (the exact shape the
// real `whisper-cli` emits for `samples/jfk.wav`, captured locally). The harness
// runner reads this structure after running the binary under the OS-deny sandbox.
const JFK_OJ_JSON = JSON.stringify({
  systeminfo: 'WHISPER : COREML = 0 | MTL : EMBED_LIBRARY = 1 | CPU : NEON = 1',
  model: { type: 'tiny', multilingual: true },
  params: { language: 'auto', translate: false },
  result: { language: 'en' },
  transcription: [
    {
      timestamps: { from: '00:00:00,000', to: '00:00:11,000' },
      offsets: { from: 0, to: 11000 },
      text: ' And so my fellow Americans ask not what your country can do for you,',
    },
    {
      timestamps: { from: '00:00:11,000', to: '00:00:00,000' },
      offsets: { from: 11000, to: 11000 },
      text: ' ask what you can do for your country.',
    },
  ],
});

const NO_SPEECH_OJ_JSON = JSON.stringify({
  result: { language: 'en' },
  transcription: [],
});

describe('extractTranscriptText — parse whisper.cpp `-oj` output (AC-17b harness)', () => {
  it('joins the trimmed segment texts of a real transcript', () => {
    expect(extractTranscriptText(JFK_OJ_JSON)).toBe(
      'And so my fellow Americans ask not what your country can do for you, ask what you can do for your country.',
    );
  });

  it('returns an empty string for a valid no-speech document', () => {
    expect(extractTranscriptText(NO_SPEECH_OJ_JSON)).toBe('');
  });

  it('drops empty / whitespace-only padding segments', () => {
    const json = JSON.stringify({
      transcription: [{ text: '   ' }, { text: ' hello ' }, { text: '' }, { text: 'world' }],
    });
    expect(extractTranscriptText(json)).toBe('hello world');
  });

  it('throws WhisperOutputError on unparseable JSON (a broken run must fail loudly)', () => {
    expect(() => extractTranscriptText('not json {')).toThrow(WhisperOutputError);
  });

  it('throws WhisperOutputError when the `transcription` array is absent (malformed)', () => {
    expect(() => extractTranscriptText(JSON.stringify({ result: { language: 'en' } }))).toThrow(
      WhisperOutputError,
    );
  });
});

describe('normalizeTranscript — case/punctuation/whitespace-insensitive matching', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalizeTranscript('  And so,  my FELLOW Americans! ')).toBe(
      'and so my fellow americans',
    );
  });

  it('returns an empty string for punctuation-only input', () => {
    expect(normalizeTranscript('  ...,  ')).toBe('');
  });
});

describe('transcriptContainsPhrase — robust substring match', () => {
  it('matches ignoring case and punctuation', () => {
    const text = 'And so my fellow Americans ask not what your country can do for you.';
    expect(transcriptContainsPhrase(text, 'your COUNTRY')).toBe(true);
    expect(transcriptContainsPhrase(text, 'ask not, what')).toBe(true);
  });

  it('does not match an absent phrase', () => {
    expect(transcriptContainsPhrase('hello world', 'goodbye')).toBe(false);
  });
});

describe('evaluateWhisperRun — verdict for a real binary under OS-deny', () => {
  const transcript =
    'And so my fellow Americans ask not what your country can do for you, ask what you can do for your country.';

  it('passes when the binary exits 0 and produced the expected speech', () => {
    const verdict = evaluateWhisperRun({
      exitCode: 0,
      transcriptText: transcript,
      expectedPhrase: 'ask not what your country',
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.transcribed).toBe(true);
  });

  it('passes with no expected phrase as long as some speech was produced', () => {
    expect(evaluateWhisperRun({ exitCode: 0, transcriptText: transcript }).ok).toBe(true);
  });

  it('fails on a non-zero exit code even if some text exists', () => {
    const verdict = evaluateWhisperRun({ exitCode: 1, transcriptText: transcript });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/exit/i);
  });

  it('fails on a null exit code (timed out / killed)', () => {
    expect(evaluateWhisperRun({ exitCode: null, transcriptText: transcript }).ok).toBe(false);
  });

  it('fails when the binary produced no transcript (cannot confirm real work under deny)', () => {
    const verdict = evaluateWhisperRun({ exitCode: 0, transcriptText: '   ' });
    expect(verdict.ok).toBe(false);
    expect(verdict.transcribed).toBe(false);
  });

  it('fails when the expected phrase is missing from the transcript', () => {
    const verdict = evaluateWhisperRun({
      exitCode: 0,
      transcriptText: transcript,
      expectedPhrase: 'a phrase that was never spoken',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/phrase/i);
  });
});
