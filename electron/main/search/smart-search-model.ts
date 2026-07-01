// The opt-in, consent-gated provisioning of the M4 embedder model for smart search
// (ADR-0029 / milestone M4-1b). The cofounder chose CONSENT-DOWNLOAD over bundling
// for the ~124 MB embedder GGUF, so this module wires the download into the SAME,
// already-approved M2 whisper-model machinery rather than reinventing it:
//   • transcription/model-download.ts  — the streamed, resumable, single-flight,
//     integrity-verified, atomically-installed download manager (REUSED, not forked);
//   • transcription/model-integrity.ts — the SHA-256 + size verifier (reused via the
//     downloader);
//   • transcription/consent-store.ts   — the durable opt-in record (reused with a
//     SEPARATE key, so smart search is its own explicit opt-in, independent of
//     transcription).
//
// The load-bearing invariant: the download target is EXACTLY the path
// resolveEmbedModelPath (search/embed-cli.ts, seam-1) already checks. So once the
// verified GGUF lands there, resolveEmbedModelPath resolves it, createEmbedder
// reports AVAILABLE, and the already-merged live search (seam-3) lights up with no
// further wiring.
//
// This slice is main-process-only and PURELY ADDITIVE: it exposes a consent-gated
// enable/status port (mirroring the M2 transcription model controller) for a LATER
// renderer opt-in UI + IPC to drive — it does NOT register IPC channels, touch the
// renderer, the network-guard allowlist, CI, or electron-builder (all deferred to
// the human-required model-publish slice). Every collaborator is injected, so the
// whole flow unit-tests with fakes — no real network, no real file.
//
// NOTE(pkg-model-publish): in a packaged build resolveEmbedModelPath resolves under
// process.resourcesPath; making that location writable for the downloaded GGUF is
// part of the deferred packaging slice (it owns electron-builder). This module only
// wires the flow to the resolved path.

import type { ConsentStore, ConsentStoreFs } from '../transcription/consent-store';
import { createConsentStore } from '../transcription/consent-store';
import {
  createModelDownloader,
  type ModelDownloader,
  type ModelDownloaderOptions,
  type ModelDownloadProgress,
  type ModelFetcher,
} from '../transcription/model-download';
import { resolveEmbedModelPath, type ResolveEmbedFileOptions } from './embed-cli';
import {
  EMBED_MODEL_DOWNLOAD_URL,
  EMBED_MODEL_SHA256,
  EMBED_MODEL_SIZE_BYTES,
} from './embed-model-source';

/**
 * The durable consent key for smart search — its OWN opt-in, independent of the
 * transcription key so enabling one never implies the other.
 */
export const SMART_SEARCH_CONSENT_KEY = 'smartSearchOptedIn';

/** The human label used in the consent store's fail-closed diagnostics. */
export const SMART_SEARCH_CONSENT_LABEL = 'smart search';

/**
 * Build the durable smart-search opt-in store (its own file + its own key), REUSING
 * the M2 consent store. The default — for an absent OR corrupt file — is the calm,
 * privacy-preserving OPTED-OUT, so nothing downloads or embeds until an explicit,
 * well-formed opt-in.
 */
export function createSmartSearchConsentStore(options: {
  filePath: string;
  fs?: ConsentStoreFs;
}): ConsentStore {
  return createConsentStore({
    filePath: options.filePath,
    key: SMART_SEARCH_CONSENT_KEY,
    label: SMART_SEARCH_CONSENT_LABEL,
    ...(options.fs ? { fs: options.fs } : {}),
  });
}

/**
 * The on-disk path the embedder GGUF WOULD occupy for these resolution inputs — i.e.
 * EXACTLY where {@link resolveEmbedModelPath} looks — computed WITHOUT requiring the
 * file to be present yet (it is the download destination). Reuses seam-1's own
 * resolver via its injectable existence probe forced true, so the download target
 * can never drift from where the embedder looks. Null for an unshipped platform/arch
 * (nowhere to install → smart search stays exact FTS).
 */
export function resolveEmbedModelDestination(resolve: ResolveEmbedFileOptions): string | null {
  return resolveEmbedModelPath({ ...resolve, exists: () => true });
}

/** Inputs for {@link createEmbedModelDownloader}. */
export interface CreateEmbedModelDownloaderOptions {
  /** The guarded-session fetcher (Electron `net.request` in prod); MOCKED in tests. */
  fetcher: ModelFetcher;
  /** Embed model path-resolution inputs (isPackaged / resourcesPath / projectRoot / …). */
  resolve: ResolveEmbedFileOptions;
  /** Progress/terminal sink (the IPC layer forwards these to the renderer). */
  onProgress?: (progress: ModelDownloadProgress) => void;
  /** Downloader factory (defaults to the reused {@link createModelDownloader}) — injected in tests. */
  createDownloader?: (options: ModelDownloaderOptions) => ModelDownloader;
}

/**
 * Build the embedder-model download manager by REUSING the M2 downloader, pinned to
 * the embed descriptor (URL + SHA-256 + size) and targeting the
 * {@link resolveEmbedModelDestination} location so a successful, verified download
 * makes the embedder AVAILABLE. Returns null for an unshipped platform/arch (no
 * install target).
 */
export function createEmbedModelDownloader(
  options: CreateEmbedModelDownloaderOptions,
): ModelDownloader | null {
  const modelPath = resolveEmbedModelDestination(options.resolve);
  if (modelPath === null) return null;
  const create = options.createDownloader ?? createModelDownloader;
  return create({
    fetcher: options.fetcher,
    modelPath,
    sourceUrl: EMBED_MODEL_DOWNLOAD_URL,
    expectedSha256: EMBED_MODEL_SHA256,
    expectedSize: EMBED_MODEL_SIZE_BYTES,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
}

/** The capability snapshot the (deferred) renderer opt-in UI reads. */
export interface SmartSearchStatus {
  /** True iff the user has explicitly opted into smart search. */
  readonly optedIn: boolean;
  /** True iff the embedder model is present AND integrity-verified (→ AVAILABLE). */
  readonly modelReady: boolean;
}

/** The terminal outcome of an {@link SmartSearchController.enable} call. */
export type SmartSearchEnableOutcome =
  | 'download-started'
  | 'already-present'
  | 'unsupported-platform';

export interface SmartSearchEnableResult {
  readonly outcome: SmartSearchEnableOutcome;
}

/** Collaborators for {@link createSmartSearchController} (all injected for testability). */
export interface SmartSearchControllerOptions {
  /** The durable smart-search opt-in (see {@link createSmartSearchConsentStore}). */
  consent: ConsentStore;
  /**
   * The embed-model downloader, or null on an unshipped platform (see
   * {@link createEmbedModelDownloader}).
   */
  downloader: ModelDownloader | null;
}

/**
 * The main-process smart-search enable/status port (mirrors the M2 transcription
 * model controller). Gated on an EXPLICIT opt-in: nothing downloads until enable()
 * is called. Progress + terminal state reach the renderer over the downloader's
 * onProgress sink (wired at construction), NOT these return values.
 */
export interface SmartSearchController {
  /** The current { optedIn, modelReady } snapshot the UI reads. */
  status(): Promise<SmartSearchStatus>;
  /** Explicit opt-in: persist consent, then (if needed + supported) fetch+verify the model. */
  enable(): Promise<SmartSearchEnableResult>;
  /** Explicit opt-out: persist the choice (does NOT delete an installed model). */
  disable(): void;
  /** True iff the embedder model is present AND integrity-verified. */
  isModelReady(): Promise<boolean>;
  /** Whether a download is currently in flight. */
  isDownloading(): boolean;
}

export function createSmartSearchController(
  options: SmartSearchControllerOptions,
): SmartSearchController {
  const { consent, downloader } = options;

  async function isModelReady(): Promise<boolean> {
    return downloader === null ? false : downloader.isModelReady();
  }

  return {
    async status() {
      return { optedIn: consent.isOptedIn(), modelReady: await isModelReady() };
    },
    async enable() {
      // Record the explicit opt-in FIRST — it is the user's durable choice, kept
      // even where the model cannot be installed (an unshipped platform).
      consent.setOptedIn(true);
      if (downloader === null) {
        return { outcome: 'unsupported-platform' };
      }
      if (await downloader.isModelReady()) {
        return { outcome: 'already-present' };
      }
      // Fire-and-forget (mirrors the M2 downloadModel handler): progress + terminal
      // state stream over the download's onProgress sink, not this result. A rejected
      // download (network / disk / integrity) must NEVER surface as an unhandled
      // rejection — swallow it here; a bad file is never installed, so the model
      // simply stays UNAVAILABLE and the user can retry.
      void downloader.downloadModel().catch(() => undefined);
      return { outcome: 'download-started' };
    },
    disable() {
      consent.setOptedIn(false);
    },
    isModelReady,
    isDownloading() {
      return downloader === null ? false : downloader.isDownloading();
    },
  };
}
