import exifr from 'exifr';
import type { ExifData, ExifReader } from '../types';

/**
 * Re-pin a timezone-less wall-clock Date to the SAME calendar components in UTC.
 *
 * exifr returns EXIF DateTimeOriginal as a Date built from LOCAL components, but
 * EXIF carries no timezone, so Kawsay reads the wall-clock AS UTC (a documented
 * approximation, §3.2) to keep the timeline stable regardless of the importing
 * machine's locale.
 */
export function asUtcInstant(local: Date): Date {
  return new Date(
    Date.UTC(
      local.getFullYear(),
      local.getMonth(),
      local.getDate(),
      local.getHours(),
      local.getMinutes(),
      local.getSeconds(),
      local.getMilliseconds(),
    ),
  );
}

/** The loose exifr record we read from — every field is validated before use. */
interface RawExif {
  DateTimeOriginal?: unknown;
  CreateDate?: unknown;
  DateTimeDigitized?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  GPSAltitude?: unknown;
  Make?: unknown;
  Model?: unknown;
  ImageWidth?: unknown;
  ExifImageWidth?: unknown;
  ImageHeight?: unknown;
  ExifImageHeight?: unknown;
  Orientation?: unknown;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
function asDate(value: unknown): Date | undefined {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : undefined;
}

/**
 * Pure: map a raw exifr record onto the normalized {@link ExifData}, or null
 * when nothing usable was found. GPS is only emitted when BOTH coordinates are
 * present; the date is re-pinned to UTC ({@link asUtcInstant}).
 */
export function normalizeExif(raw: RawExif | null | undefined): ExifData | null {
  if (raw === null || raw === undefined) return null;

  const taken =
    asDate(raw.DateTimeOriginal) ?? asDate(raw.CreateDate) ?? asDate(raw.DateTimeDigitized);
  const lat = num(raw.latitude);
  const lon = num(raw.longitude);
  const alt = num(raw.GPSAltitude);
  const cameraMake = str(raw.Make);
  const cameraModel = str(raw.Model);
  const width = num(raw.ImageWidth) ?? num(raw.ExifImageWidth);
  const height = num(raw.ImageHeight) ?? num(raw.ExifImageHeight);
  const orientation = num(raw.Orientation);

  const data: ExifData = {};
  if (taken !== undefined) data.takenAt = asUtcInstant(taken);
  if (lat !== undefined && lon !== undefined) {
    data.gps = alt !== undefined ? { lat, lon, alt } : { lat, lon };
  }
  if (cameraMake !== undefined) data.cameraMake = cameraMake;
  if (cameraModel !== undefined) data.cameraModel = cameraModel;
  if (width !== undefined) data.width = width;
  if (height !== undefined) data.height = height;
  if (orientation !== undefined) data.orientation = orientation;

  return Object.keys(data).length === 0 ? null : data;
}

/**
 * The exifr-backed {@link ExifReader}. A malformed or absent header is a skip
 * (null), never a throw (AC-15; §7.2). Only the metadata IFDs are parsed — the
 * pixel data is never decoded, bounding the work per file.
 */
export const readExif: ExifReader = async (path: string): Promise<ExifData | null> => {
  try {
    const raw: unknown = await exifr.parse(path, {
      tiff: true,
      exif: true,
      gps: true,
    });
    return normalizeExif(raw as RawExif | null | undefined);
  } catch {
    return null;
  }
};
