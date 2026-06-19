#!/usr/bin/env bash
# build-app.sh — compile the Swift shell with swiftc and assemble Pilot.app.
#
# Uses swiftc directly (no SwiftPM/Xcode): the app has no third-party deps — just
# AppKit/WebKit from the system SDK — so a plain compile is all it needs, and it works
# with only the Command Line Tools installed. We assemble the .app bundle by hand
# (Info.plist + binary under Contents/), so there's no Xcode project to maintain.
#
# Ad-hoc signed (personal/local use): not notarized, so the first launch needs a
# right-click → Open to get past Gatekeeper.
set -euo pipefail
cd "$(dirname "$0")"

APP="Pilot.app"
ARCH="$(uname -m)"                       # arm64 (Apple Silicon) or x86_64
TARGET="${ARCH}-apple-macos13.0"         # pin min OS so we don't inherit the SDK's

echo "→ compiling (swiftc, $TARGET)"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -swift-version 5 -target "$TARGET" \
    -framework AppKit -framework WebKit \
    Sources/Pilot/*.swift \
    -o "$APP/Contents/MacOS/Pilot"

cp Info.plist "$APP/Contents/Info.plist"

# Ad-hoc signature ("-" identity). Enough for a local app; swap for a Developer ID +
# notarization if you ever want frictionless double-click installs across machines.
if codesign --force --sign - "$APP" 2>/dev/null; then
    echo "→ ad-hoc signed"
else
    echo "→ codesign unavailable; skipped (right-click → Open will still work)"
fi

echo
echo "Built $PWD/$APP"
echo "Run:  open \"$PWD/$APP\"     (or move it to /Applications)"
