import { describe, expect, it } from 'vitest';
import {
  IPC_ERROR_CODES,
  IPC_ERROR_ENVELOPE_MARKER,
  IpcError,
  ipcErrorEnvelopeSchema,
  isIpcError,
  isIpcErrorEnvelope,
  projectError,
  toIpcErrorEnvelope,
} from '@shared/ipc/error-envelope';

describe('projectError (the single redaction projection, #440)', () => {
  it('keeps ONLY name for a plain Error — never message/stack', () => {
    const projected = projectError(new Error('/Users/alice/secret path leaks here'));
    expect(projected).toEqual({ name: 'Error' });
    expect(JSON.stringify(projected)).not.toContain('secret');
    expect(JSON.stringify(projected)).not.toContain('Users/alice');
  });

  it('carries an errno-style string code when present, still no message', () => {
    const err = Object.assign(new Error('EPERM: operation not permitted, unlink /Users/x'), {
      code: 'EPERM',
    });
    expect(projectError(err)).toEqual({ name: 'Error', code: 'EPERM' });
  });

  it('preserves a custom error class name', () => {
    class CatalogSessionError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'CatalogSessionError';
      }
    }
    expect(projectError(new CatalogSessionError('no such item: 7f3c-secret'))).toEqual({
      name: 'CatalogSessionError',
    });
  });

  it('projects a non-Error throw to its typeof, carrying no content', () => {
    expect(projectError('a raw string with /Users/alice')).toEqual({ name: 'string' });
    expect(projectError({ secret: 'x' })).toEqual({ name: 'object' });
  });
});

describe('ipcErrorEnvelope (redacted shape that crosses IPC, #440)', () => {
  it('accepts a well-formed envelope', () => {
    const env = {
      [IPC_ERROR_ENVELOPE_MARKER]: true,
      code: 'ERR_IPC_HANDLER_FAULT',
      name: 'CatalogSessionError',
    };
    expect(ipcErrorEnvelopeSchema.safeParse(env).success).toBe(true);
    expect(isIpcErrorEnvelope(env)).toBe(true);
  });

  it('rejects an envelope carrying a smuggled message/stack (strict shape)', () => {
    const smuggled = {
      [IPC_ERROR_ENVELOPE_MARKER]: true,
      code: 'ERR_IPC_HANDLER_FAULT',
      name: 'Error',
      message: 'no such item: 7f3c-secret',
      stack: 'Error: no such item\n    at /Users/alice/app.js',
    };
    // The strict schema refuses the extra keys — a bad main can never smuggle raw
    // text across under the envelope banner.
    expect(ipcErrorEnvelopeSchema.safeParse(smuggled).success).toBe(false);
    expect(isIpcErrorEnvelope(smuggled)).toBe(false);
  });

  it('is not a plain Error / arbitrary object', () => {
    expect(isIpcErrorEnvelope(new Error('boom'))).toBe(false);
    expect(isIpcErrorEnvelope({ code: 'x', name: 'y' })).toBe(false);
    expect(isIpcErrorEnvelope(null)).toBe(false);
  });
});

describe('toIpcErrorEnvelope (main-side redaction gate, #440)', () => {
  it('drops message/stack, keeping ONLY marker/code/name', () => {
    const env = toIpcErrorEnvelope(
      new Error('no such item: 7f3c-secret at /Users/alice/lib'),
      IPC_ERROR_CODES.HANDLER_FAULT,
    );
    expect(Object.keys(env).sort()).toEqual([IPC_ERROR_ENVELOPE_MARKER, 'code', 'name'].sort());
    expect(env).toEqual({
      [IPC_ERROR_ENVELOPE_MARKER]: true,
      code: IPC_ERROR_CODES.HANDLER_FAULT,
      name: 'Error',
    });
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('Users/alice');
  });

  it('surfaces the error own string code over the fallback', () => {
    const err = Object.assign(new Error('boom /Users/alice'), { code: 'EACCES' });
    expect(toIpcErrorEnvelope(err, IPC_ERROR_CODES.HANDLER_FAULT).code).toBe('EACCES');
  });
});

describe('IpcError (renderer-side typed error, #440)', () => {
  it('carries the code + origin name, and its message is the code — never raw text', () => {
    const err = new IpcError(IPC_ERROR_CODES.HANDLER_FAULT, 'CatalogSessionError');
    expect(isIpcError(err)).toBe(true);
    expect(err.code).toBe(IPC_ERROR_CODES.HANDLER_FAULT);
    expect(err.originName).toBe('CatalogSessionError');
    expect(err.name).toBe('IpcError');
    // message is the stable code (safe); it never carries a raw main-side message.
    expect(err.message).toBe(IPC_ERROR_CODES.HANDLER_FAULT);
  });
});
