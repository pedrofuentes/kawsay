import { contextBridge, ipcRenderer } from 'electron';
import { APP_GET_VERSION } from '@shared/ipc/contract';
import type { KawsayAPI } from '@shared/kawsay-api';
import { createValidatedInvoke } from './invoke';

// The ONLY bridge between renderer and main. Every call routes through the
// zod-validated invoke helper, so the renderer can never reach an unvalidated
// channel and no catch-all `send` is exposed (ARCHITECTURE §1.3, §2.3).
const invoke = createValidatedInvoke((channel, payload) => ipcRenderer.invoke(channel, payload));

const kawsayAPI: KawsayAPI = {
  async getAppVersion() {
    const { version } = await invoke(APP_GET_VERSION, {});
    return version;
  },
};

contextBridge.exposeInMainWorld('kawsayAPI', kawsayAPI);
