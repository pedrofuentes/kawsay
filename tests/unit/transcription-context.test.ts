import { describe, expect, it } from 'vitest';
import { openTranscriptionContext } from '../../electron/main/transcription/workers/transcription-context';
import type { TranscriptionJobSpec } from '../../electron/main/transcription/queue/protocol';

function spec(overrides: Partial<TranscriptionJobSpec> = {}): TranscriptionJobSpec {
  return {
    jobId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    items: [{ id: 'a', sourcePath: '/src/a.opus' }],
    modelPath: '/models/ggml-small.bin',
    whisperCliPath: '/bin/whisper-cli',
    ffmpegPath: '/bin/ffmpeg',
    scratchDir: '/scratch',
    ...overrides,
  };
}

describe('openTranscriptionContext (worker-side composition of the real executor)', () => {
  it('assembles a transcriber + a close hook from the job spec (no spawn at construction)', () => {
    const context = openTranscriptionContext(spec());
    expect(typeof context.transcribe).toBe('function');
    expect(typeof context.close).toBe('function');
    // close is a no-op (no db handle) and must be safe to call.
    expect(() => context.close()).not.toThrow();
  });
});
