#!/bin/sh
# Rasterises the PNG icon sizes from moodify-mark.svg.
#
# Optional: every current browser accepts favicon.svg directly, so the SVGs alone
# are a complete icon set. This only fills in apple-touch-icon.png, which iOS
# still wants as a raster.
set -eu

BRAND="$(cd "$(dirname "$0")/.." && pwd)/apps/frontend/public/brand"
SRC="$BRAND/moodify-mark.svg"
[ -f "$SRC" ] || { echo "missing $SRC" >&2; exit 1; }

render() { # size outfile
  if command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert -w "$1" -h "$1" "$SRC" -o "$2"
  elif command -v inkscape >/dev/null 2>&1; then
    inkscape "$SRC" -w "$1" -h "$1" -o "$2" >/dev/null 2>&1
  elif command -v magick >/dev/null 2>&1; then
    magick -background none -density 384 "$SRC" -resize "${1}x${1}" "$2"
  elif command -v convert >/dev/null 2>&1; then
    convert -background none -density 384 "$SRC" -resize "${1}x${1}" "$2"
  else
    return 1
  fi
}

if ! render 16 "$BRAND/favicon-16.png" 2>/dev/null; then
  echo "No SVG rasteriser found — skipping PNG generation."
  echo "The SVG icons work on their own; for apple-touch-icon.png install one with:"
  echo "  sudo apt-get install -y librsvg2-bin"
  exit 0
fi

render 32 "$BRAND/favicon-32.png"
render 180 "$BRAND/apple-touch-icon.png"
render 512 "$BRAND/icon-512.png"
echo "Wrote favicon-16/32.png, apple-touch-icon.png, icon-512.png to $BRAND"
