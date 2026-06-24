/**
 * The entire renderer-facing capability surface exposed on `window.kawsayAPI`
 * by the preload bridge — one method per IPC channel, with no catch-all `send`
 * (ARCHITECTURE §1.3, §2.3). The renderer depends only on this type and never
 * touches Node, Electron, the filesystem, the database, or the network.
 */
export interface KawsayAPI {
  /** The running application version, validated end-to-end (channel `app:getVersion`). */
  getAppVersion(): Promise<string>;
}
