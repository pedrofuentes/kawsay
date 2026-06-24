/**
 * Intended `@electron/fuses` states for the packaged application (ARCHITECTURE
 * §2.5). The fuses are physically flipped at package time in card P1; this
 * constant pins and documents the target posture now so the security stance is
 * declared, reviewable, and regression-protected before packaging exists. No
 * `@electron/fuses` dependency is added here.
 *
 * Lives under `electron/fuses/` (not `electron/build/`) because `.gitignore`'s
 * `build/` rule would shadow the module and keep it out of every clean clone.
 */
export const FUSE_CONFIG = {
  /** No `electron --run-as-node` Node escape hatch. */
  runAsNode: false,
  /** Ignore the NODE_OPTIONS environment variable. */
  enableNodeOptionsEnvironmentVariable: false,
  /** Reject `--inspect`-family CLI arguments. */
  enableNodeCliInspectArguments: false,
  /** Load application code only from the signed ASAR archive. */
  onlyLoadAppFromAsar: true,
  /** Validate the embedded ASAR integrity hash on load. */
  enableEmbeddedAsarIntegrityValidation: true,
  /** Do not grant the `file://` protocol extra privileges. */
  grantFileProtocolExtraPrivileges: false,
  /** Encrypt cookies/session data at rest. */
  enableCookieEncryption: true,
} as const;

export type FuseConfig = typeof FUSE_CONFIG;
