#!/usr/bin/env python3
"""Out-of-band generator for the AC-32 e2e photo fixtures (#510).

Creates small, deterministic JPEGs carrying EXIF GPS tags clustered near the
Shanghai entry in resources/gazetteer/cities1000.sample.ndjson (id 1796236,
31.22222,121.45806). Three photos within ~1.5 km of each other satisfy the
place clusterer's default minPts=3 / eps=1500m, so a fully offline categorization
run yields one deterministic "Shanghai" place suggestion — no model, no network.

This tool is NOT a repo dependency: run it in a throwaway venv (pip install
piexif Pillow) and commit only the resulting .jpg bytes. exifr (the app's reader)
parses what piexif writes; a round-trip unit test pins that.

Usage: python scripts/generate-gps-fixtures.py <output-dir>
See tests/e2e/fixtures/photos-shanghai/README.md for the full workflow.
"""
import sys
import os
from fractions import Fraction
from PIL import Image
import piexif


def _to_dms_rationals(deg: float):
    """Decimal degrees -> ((d,1),(m,1),(sec,100)) piexif rational triple."""
    deg = abs(deg)
    d = int(deg)
    m_float = (deg - d) * 60
    m = int(m_float)
    s = round((m_float - m) * 60, 2)
    return ((d, 1), (m, 1), (int(s * 100), 100))


def _gps_ifd(lat: float, lon: float):
    return {
        piexif.GPSIFD.GPSVersionID: (2, 3, 0, 0),
        piexif.GPSIFD.GPSLatitudeRef: "N" if lat >= 0 else "S",
        piexif.GPSIFD.GPSLatitude: _to_dms_rationals(lat),
        piexif.GPSIFD.GPSLongitudeRef: "E" if lon >= 0 else "W",
        piexif.GPSIFD.GPSLongitude: _to_dms_rationals(lon),
    }


# Three points within a few hundred metres of the Shanghai gazetteer centroid.
PHOTOS = [
    ("shanghai-bund-1.jpg", 31.22222, 121.45806, (198, 132, 96)),   # terracotta
    ("shanghai-bund-2.jpg", 31.22350, 121.45950, (46, 94, 74)),     # sage
    ("shanghai-bund-3.jpg", 31.22100, 121.45700, (240, 235, 228)),  # parchment
]


def main(out_dir: str) -> None:
    os.makedirs(out_dir, exist_ok=True)
    for name, lat, lon, colour in PHOTOS:
        # A tiny solid-colour JPEG keeps the committed bytes small; the pixels are
        # irrelevant to the place path — only the EXIF GPS matters.
        img = Image.new("RGB", (48, 48), colour)
        exif_bytes = piexif.dump({"GPS": _gps_ifd(lat, lon)})
        path = os.path.join(out_dir, name)
        img.save(path, "jpeg", quality=80, exif=exif_bytes)
        print(f"wrote {path}  ({lat},{lon})  {os.path.getsize(path)} bytes")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python gen-gps-fixtures.py <output-dir>")
    main(sys.argv[1])
