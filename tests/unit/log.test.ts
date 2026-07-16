import { describe, expect, it, vi } from 'vitest';
import { createLogger, type LogLevel } from '../../electron/main/log';

function fakeSink() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('createLogger (single main-process logger, #440)', () => {
  it('forwards a message to the matching sink level', () => {
    const sink = fakeSink();
    const log = createLogger({ level: 'debug', sink });
    log.warn('[kawsay] something happened');
    expect(sink.warn).toHaveBeenCalledTimes(1);
    expect(sink.warn.mock.calls[0]?.[0]).toBe('[kawsay] something happened');
  });

  it('REDACTS an Error argument to {name,code} — never message/stack (the invariant)', () => {
    const sink = fakeSink();
    const log = createLogger({ level: 'debug', sink });
    const err = Object.assign(new Error('no such item: 7f3c at /Users/alice/lib'), {
      code: 'ENOENT',
    });
    log.error('[kawsay] handler failed', err);

    expect(sink.error).toHaveBeenCalledTimes(1);
    const [message, projected] = sink.error.mock.calls[0] ?? [];
    expect(message).toBe('[kawsay] handler failed');
    expect(projected).toEqual({ name: 'Error', code: 'ENOENT' });
    // The raw message/stack must NEVER appear in what the logger emits.
    const serialized = JSON.stringify(sink.error.mock.calls);
    expect(serialized).not.toContain('7f3c');
    expect(serialized).not.toContain('Users/alice');
    expect(serialized).not.toContain('no such item');
  });

  it('passes through non-Error args unchanged (already-safe diagnostics)', () => {
    const sink = fakeSink();
    const log = createLogger({ level: 'debug', sink });
    log.warn('[kawsay] media serve rejected', { name: 'ConfinementError', code: 'ESCAPE' });
    expect(sink.warn.mock.calls[0]?.[1]).toEqual({ name: 'ConfinementError', code: 'ESCAPE' });
  });

  it('suppresses debug/info below the configured level (prod posture)', () => {
    const sink = fakeSink();
    const log = createLogger({ level: 'warn', sink });
    log.debug('noise');
    log.info('more noise');
    log.warn('kept');
    log.error('kept');
    expect(sink.debug).not.toHaveBeenCalled();
    expect(sink.info).not.toHaveBeenCalled();
    expect(sink.warn).toHaveBeenCalledTimes(1);
    expect(sink.error).toHaveBeenCalledTimes(1);
  });

  it('emits all levels in dev posture', () => {
    const sink = fakeSink();
    const log = createLogger({ level: 'debug', sink });
    (['debug', 'info', 'warn', 'error'] as LogLevel[]).forEach((lvl) => log[lvl](`m-${lvl}`));
    expect(sink.debug).toHaveBeenCalledTimes(1);
    expect(sink.info).toHaveBeenCalledTimes(1);
    expect(sink.warn).toHaveBeenCalledTimes(1);
    expect(sink.error).toHaveBeenCalledTimes(1);
  });

  it('redacts an Error even in dev — the projected form never leaks message/stack', () => {
    const sink = fakeSink();
    const log = createLogger({ level: 'debug', sink });
    log.debug('[kawsay] trace', new Error('secret /Users/alice payload'));
    const serialized = JSON.stringify(sink.debug.mock.calls);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('Users/alice');
  });
});
