// `ffprobe-static` ships no type declarations. It is a CommonJS module that
// exports the absolute path of a bundled, platform-specific `ffprobe` binary
// (and its version). This ambient declaration is a type-only shim — NOT a
// dependency — so the `MediaProber` wrapper can import the binary path under
// `tsc --strict`.
declare module 'ffprobe-static' {
  export const path: string;
  export const version: string;
}
