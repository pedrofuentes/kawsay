import { describe, expect, it } from 'vitest';
import {
  IPC_ERROR_CODES,
  IPC_ERROR_TAG,
  IpcError,
  decodeIpcErrorMessage,
  encodeIpcErrorMessage,
  ipcErrorCodeOf,
  ipcErrorFrom,
  ipcErrorPayloadSchema,
  isIpcError,
  makeIpcError,
  projectError,
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

describe('ipcErrorPayload encode/decode (redacted wire shape, #440)', () => {
  it('round-trips a well-formed payload through the tagged message', () => {
    const message = encodeIpcErrorMessage({ code: 'ERR_IPC_HANDLER_FAULT', name: 'CatalogSessionError' });
    expect(message.startsWith(IPC_ERROR_TAG)).toBe(true);
    expect(decodeIpcErrorMessage(message)).toEqual({
      code: 'ERR_IPC_HANDLER_FAULT',
      name: 'CatalogSessionError',
    });
  });

  it('decodes to null for an untagged / malformed message (no raw text mistaken for a payload)', () => {
    expect(decodeIpcErrorMessage('no such item: 7f3c-secret')).toBeNull();
    expect(decodeIpcErrorMessage(`${IPC_ERROR_TAG}{not json`)).toBeNull();
    expect(decodeIpcErrorMessage(undefined)).toBeNull();
  });

  it('rejects a payload that smuggles a message/stack field (strict schema)', () => {
    const smuggled = `${IPC_ERROR_TAG}${JSON.stringify({
      code: 'ERR_IPC_HANDLER_FAULT',
      name: 'Error',
      message: 'no such item: 7f3c-secret',
      stack: 'at /Users/alice/app.js',
    })}`;
    expect(decodeIpcErrorMessage(smuggled)).toBeNull();
    expect(ipcErrorPayloadSchema.safeParse({ code: 'x', name: 'y', message: 'z' }).success).toBe(false);
  });

  it('accepts every stable code (ERR_SCREAMING_SNAKE) and a Node errno-style code (#481)', () => {
    for (const code of Object.values(IPC_ERROR_CODES)) {
      expect(ipcErrorPayloadSchema.safeParse({ code, name: 'Error' }).success).toBe(true);
    }
    // Node errno-style codes the redaction gate also carries verbatim (#440) — plain
    // uppercase + digits + underscore, same charset as the static codes above.
    expect(ipcErrorPayloadSchema.safeParse({ code: 'EACCES', name: 'Error' }).success).toBe(true);
    expect(ipcErrorPayloadSchema.safeParse({ code: 'ERR_NATIVE_MODULE', name: 'Error' }).success).toBe(
      true,
    );
  });

  it('rejects a code outside the ERR_SCREAMING_SNAKE charset (#481 defense-in-depth)', () => {
    // Only `code` is charset-guarded — `name` legitimately varies (PascalCase error
    // class names like `CatalogSessionError`/`ZodError`), so it stays length-only.
    expect(
      ipcErrorPayloadSchema.safeParse({ code: 'ERR_IPC_BAD-REQUEST', name: 'Error' }).success,
    ).toBe(false);
    expect(ipcErrorPayloadSchema.safeParse({ code: 'err_ipc_handler_fault', name: 'Error' }).success).toBe(
      false,
    );
    expect(
      ipcErrorPayloadSchema.safeParse({ code: 'ERR_IPC_HANDLER_FAULT\n/Users/alice', name: 'Error' })
        .success,
    ).toBe(false);
  });
});

describe('makeIpcError (main-side redaction gate, #440)', () => {
  it('encodes ONLY {code, name}; message + scrubbed stack carry no raw text', () => {
    const wire = makeIpcError(
      new Error('no such item: 7f3c-secret at /Users/alice/lib'),
      IPC_ERROR_CODES.HANDLER_FAULT,
    );
    expect(decodeIpcErrorMessage(wire.message)).toEqual({
      code: IPC_ERROR_CODES.HANDLER_FAULT,
      name: 'Error',
    });
    const serialized = `${wire.message}\n${wire.stack ?? ''}`;
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('Users/alice');
    expect(serialized).not.toContain('no such item');
    // The stack is scrubbed to the tagged message — no incidental frame path crosses.
    expect(wire.stack).toBe(wire.message);
  });

  it('surfaces the error own string code over the fallback', () => {
    const err = Object.assign(new Error('boom /Users/alice'), { code: 'EACCES' });
    expect(decodeIpcErrorMessage(makeIpcError(err, IPC_ERROR_CODES.HANDLER_FAULT).message)?.code).toBe(
      'EACCES',
    );
  });
});

describe('IpcError + ipcErrorFrom / ipcErrorCodeOf (renderer side, #440)', () => {
  it('IpcError carries code + origin name, and its message is the tagged payload', () => {
    const err = new IpcError(IPC_ERROR_CODES.HANDLER_FAULT, 'CatalogSessionError');
    expect(isIpcError(err)).toBe(true);
    expect(err.code).toBe(IPC_ERROR_CODES.HANDLER_FAULT);
    expect(err.originName).toBe('CatalogSessionError');
    expect(err.name).toBe('IpcError');
    expect(decodeIpcErrorMessage(err.message)).toEqual({
      code: IPC_ERROR_CODES.HANDLER_FAULT,
      name: 'CatalogSessionError',
    });
  });

  it('ipcErrorFrom recovers {code, name} from a tagged rejection (main→preload hop)', () => {
    const wire = makeIpcError(
      Object.assign(new Error('boom'), { code: 'ERR_NATIVE_MODULE' }),
      IPC_ERROR_CODES.HANDLER_FAULT,
    );
    const recovered = ipcErrorFrom(wire, IPC_ERROR_CODES.HANDLER_FAULT);
    expect(recovered).toBeInstanceOf(IpcError);
    expect(recovered.code).toBe('ERR_NATIVE_MODULE');
  });

  it('ipcErrorFrom falls back to the code + class name for an untagged rejection', () => {
    const recovered = ipcErrorFrom(new TypeError('kaboom'), IPC_ERROR_CODES.BAD_RESPONSE);
    expect(recovered.code).toBe(IPC_ERROR_CODES.BAD_RESPONSE);
    expect(recovered.originName).toBe('TypeError');
  });

  it('ipcErrorCodeOf reads a tagged PLAIN Error too (post-contextBridge shape)', () => {
    // The page receives a plain Error (custom fields stripped) whose message is the
    // tagged payload — the code must still be recoverable.
    const asPlainError = new Error(
      encodeIpcErrorMessage({ code: IPC_ERROR_CODES.UNTRUSTED_SENDER, name: 'Error' }),
    );
    expect(ipcErrorCodeOf(asPlainError)).toBe(IPC_ERROR_CODES.UNTRUSTED_SENDER);
    expect(ipcErrorCodeOf(new Error('just a normal error'))).toBe('');
  });
});
