export function ffmpegLicenseFailures(
  label: string,
  path: string,
  readLicenseText?: (path: string) => string,
  readNoticesText?: () => string,
): string[];
export function verifyMediaBinaries(options?: {
  projectRoot?: string;
  targets?: readonly string[];
  log?: (message: string) => void;
}): string[];
