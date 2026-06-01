#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
default_source="/Users/la-forge.fox/Library/CloudStorage/ProtonDrive-smokevulcanops@protonmail.com-folder/Business/Reed Tech Group/Artifacts/letterhead.png"
source_file="${1:-$default_source}"
assets_dir="$repo_root/assets"
email_dest="$assets_dir/email-logo.png"

if [[ ! -f "$source_file" ]]; then
  echo "Source logo not found: $source_file" >&2
  exit 1
fi

mkdir -p "$assets_dir"

if command -v magick >/dev/null 2>&1; then
  magick "$source_file" -resize 320x320 -strip "$email_dest"
elif command -v convert >/dev/null 2>&1; then
  convert "$source_file" -resize 320x320 -strip "$email_dest"
else
  cp "$source_file" "$email_dest"
  echo "ImageMagick not found. Copied original image without resizing." >&2
fi

echo "Stored email logo:  $email_dest"
echo "Public URL after deploy: https://reedcloudsec.com/assets/email-logo.png"
