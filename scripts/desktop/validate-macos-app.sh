#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 --app PATH" >&2
  exit 2
}

[[ ${1:-} == "--app" && -n ${2:-} ]] || usage
app=$2
plist="$app/Contents/Info.plist"
[[ -d "$app" ]] || { echo "missing macOS app: $app" >&2; exit 1; }
[[ -f "$plist" ]] || { echo "missing packaged Info.plist: $plist" >&2; exit 1; }

if command -v /usr/libexec/PlistBuddy >/dev/null 2>&1; then
  identifier=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")
  minimum=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$plist")
elif command -v plutil >/dev/null 2>&1; then
  identifier=$(plutil -extract CFBundleIdentifier raw -o - "$plist")
  minimum=$(plutil -extract LSMinimumSystemVersion raw -o - "$plist")
else
  echo "neither PlistBuddy nor plutil is available" >&2
  exit 1
fi

[[ $identifier == "dev.pantoken.app" ]] || { echo "unexpected CFBundleIdentifier: $identifier" >&2; exit 1; }
[[ $minimum == "13.0" ]] || { echo "unexpected LSMinimumSystemVersion: $minimum" >&2; exit 1; }
echo "Validated macOS app: $app (CFBundleIdentifier=$identifier, LSMinimumSystemVersion=$minimum)"
