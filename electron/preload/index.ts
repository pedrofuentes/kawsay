import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { KawsayAPI } from '@shared/kawsay-api';
import { createValidatedInvoke } from './invoke';
import { createValidatedSubscribe } from './subscribe';
import { createKawsayApi } from './api';

// The ONLY bridge between renderer and main. Every request routes through the
// zod-validated invoke helper and every event through the validated subscribe
// helper, so the renderer can never reach an unvalidated channel and no
// catch-all `send`/`on` is exposed (ARCHITECTURE §1.3, §2.3).
const invoke = createValidatedInvoke((channel, payload) => ipcRenderer.invoke(channel, payload));
const subscribe = createValidatedSubscribe((channel, listener) => {
  const handler = (_event: IpcRendererEvent, payload: unknown): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
});

const kawsayAPI: KawsayAPI = createKawsayApi(invoke, subscribe);

contextBridge.exposeInMainWorld('kawsayAPI', kawsayAPI);
