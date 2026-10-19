#!/bin/sh
# OpenScene — sync-assets.sh
#
# Copies the single shared web app into the iOS app's www/ resource folder so
# the phone runs exactly the same editor as the Windows build. Run this before
# building in Xcode:
#
#   sh mobile/ios/sync-assets.sh
#
# Then open mobile/ios/OpenScene.xcodeproj, pick a signing team, and run.

set -e
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
dest="$here/www"

rm -rf "$dest"
mkdir -p "$dest"

for e in index.html manifest.webmanifest sw.js LICENSE css js resources icons; do
  if [ -e "$root/$e" ]; then
    cp -R "$root/$e" "$dest/"
    echo "  + $e"
  else
    echo "  ! missing $e"
  fi
done

cp "$here/../host-bridge-mobile.js" "$dest/"
echo "  + host-bridge-mobile.js"

echo ""
echo "iOS assets synced: $(find "$dest" -type f | wc -l | tr -d ' ') files -> $dest"
