#!/usr/bin/env bash
# gh-issue-fetch.sh — fetch a GitHub issue for the implement-issue workflow.
#
# Called by the implement-issue skill at session start. Fetches the issue via
# `gh`, extracts image URLs from the body and comments, downloads screenshots
# to a temp dir, writes the issue body + comments to an issue.md file, and
# writes the issue number to .implement-issue-number in the cwd (the marker the
# stop hook reads).
#
# Usage: gh-issue-fetch.sh <issue_number>
#
# Environment:
#   TMPDIR  Used for the temp download dir (defaults to /tmp).
#
# Outputs (printed to stdout for the agent to read):
#   - The path to issue.md
#   - The paths to downloaded screenshots (read with file_read)
#
# Exit codes: 0=success, 1=error (auth failure, bad issue number, gh error)
set -euo pipefail

REPOSITORY="TimoFreiberg/pantoken"

if [ $# -ne 1 ]; then
  echo "usage: gh-issue-fetch.sh <issue_number>" >&2
  exit 1
fi

ISSUE_NUMBER="$1"
if ! [[ "$ISSUE_NUMBER" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: issue_number must be a positive integer" >&2
  exit 1
fi

# ─── Auth check ───────────────────────────────────────────────────────────────
if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: not authenticated with gh. Run 'gh auth login' (or set GH_TOKEN)." >&2
  exit 1
fi

# ─── Fetch issue ─────────────────────────────────────────────────────────────
ISSUE_JSON="$(gh issue view "$ISSUE_NUMBER" --repo "$REPOSITORY" --json title,body,comments)" || {
  echo "ERROR: gh issue view failed for #$ISSUE_NUMBER" >&2
  exit 1
}

# Validate the issue has a string title and body before proceeding.
if ! echo "$ISSUE_JSON" | jq -e '(.title | type == "string") and (.body | type == "string")' >/dev/null 2>&1; then
  echo "ERROR: gh returned malformed issue JSON (title/body not strings)" >&2
  exit 1
fi

TITLE="$(echo "$ISSUE_JSON" | jq -r '.title')"
BODY="$(echo "$ISSUE_JSON" | jq -r '.body')"

# ─── Build issue.md ──────────────────────────────────────────────────────────
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pantoken-issue-${ISSUE_NUMBER}-XXXXXX")"
ISSUE_MD="$WORK_DIR/issue.md"
IMAGES_DIR="$WORK_DIR/images"
mkdir -p "$IMAGES_DIR"

# Extract image URLs from body + all comment bodies.
# Sources (ported from extractImageUrls in implement-issue.ts):
#   - markdown image syntax: ![alt](url) or ![alt](<url with spaces>)
#   - <img src="..."> tags
# jq concatenates body + each comment body, then grep extracts URLs.
COMBINED="$(echo "$ISSUE_JSON" | jq -r '[.body] + (.comments | map(.body)) | join("\n")')"

extract_urls() {
  # Markdown image syntax: ![alt](url) — capture the url (handle <url> form).
  # Use grep -oE to pull the candidate URL token.
  echo "$COMBINED" | grep -oE '!\[[^]]*\]\(<[^>]+>|!\[[^]]*\]\([^)[:space:]]+' \
    | sed -E 's/^!\[[^]]*\]\(//' | sed -E 's/^<//' | sed -E 's/>$//' || true
  # <img src="..."> tags (single or double quotes).
  echo "$COMBINED" | grep -oiE '<img[^>]*src=["'"'"'][^"'"'"']+["'"'"']' \
    | sed -E 's/.*src=["'"'"']([^"'"'"']+)["'"'"'].*/\1/I' || true
}

# Dedupe, filter to http/https URLs, and validate.
URLS_FILE="$WORK_DIR/urls.txt"
extract_urls | sed -E 's/^[[:space:]]+|[[:space:]]+$//' \
  | grep -E '^https?://' \
  | awk '!seen[$0]++' > "$URLS_FILE" || true

# ─── Download screenshots ────────────────────────────────────────────────────
image_extension() {
  # $1 = url, $2 = content-type (optional). Returns an extension (png/jpg/etc).
  local url="$1" content_type="${2:-}"
  local type
  type="$(echo "$content_type" | cut -d';' -f1 | tr '[:upper:]' '[:lower:]' | sed -E 's/^[[:space:]]+|[[:space:]]+$//')"
  case "$type" in
    image/png) echo "png"; return ;;
    image/jpeg) echo "jpg"; return ;;
    image/gif) echo "gif"; return ;;
    image/webp) echo "webp"; return ;;
    image/svg+xml) echo "svg"; return ;;
  esac
  # Fall back to the URL's path extension.
  local ext
  ext="$(echo "$url" | sed -E 's|.*/||; s|\?.*||; s|#.*||' | grep -oE '\.[a-zA-Z0-9]{2,5}$' | sed -E 's/^\.//' | tr '[:upper:]' '[:lower:]' || true)"
  case "$ext" in
    png) echo "png" ;;
    jpg) echo "jpg" ;;
    jpeg) echo "jpg" ;;
    gif) echo "gif" ;;
    webp) echo "webp" ;;
    svg) echo "svg" ;;
    *) echo "bin" ;;
  esac
}

MAX_BYTES=$((10 * 1024 * 1024))  # 10 MiB
SCREENSHOT_LOG="$WORK_DIR/screenshots.txt"
: > "$SCREENSHOT_LOG"

index=0
while IFS= read -r url; do
  [ -z "$url" ] && continue
  # Download to a temp file, enforce content-type and size limits.
  tmp_file="$IMAGES_DIR/.tmp-$index"
  content_type=""
  http_code=""
  # -L follow redirects; --max-time 20; write headers to capture content-type.
  header_file="$IMAGES_DIR/.headers-$index"
  http_code="$(curl -sSL --max-time 20 -D "$header_file" -o "$tmp_file" -w '%{http_code}' "$url" 2>/dev/null || echo "000")"
  if [ "$http_code" != "200" ]; then
    echo "WARN: failed to download $url (HTTP $http_code), skipping" >> "$SCREENSHOT_LOG"
    rm -f "$tmp_file" "$header_file"
    index=$((index + 1))
    continue
  fi
  content_type="$(grep -i '^content-type:' "$header_file" | head -1 | sed -E 's/^[Cc]ontent-[Tt]ype:[[:space:]]*//' | sed -E 's/[[:space:]]*$//' || echo "")"
  rm -f "$header_file"
  # Content-type must start with image/.
  if ! echo "$content_type" | grep -qiE '^image/'; then
    echo "WARN: $url has content-type '${content_type:-unknown}' (not an image), skipping" >> "$SCREENSHOT_LOG"
    rm -f "$tmp_file"
    index=$((index + 1))
    continue
  fi
  # Size check (content-length header then actual byte count).
  size="$(wc -c < "$tmp_file" | tr -d ' ')"
  if [ "$size" -gt "$MAX_BYTES" ]; then
    echo "WARN: $url exceeds 10 MiB ($size bytes), skipping" >> "$SCREENSHOT_LOG"
    rm -f "$tmp_file"
    index=$((index + 1))
    continue
  fi
  ext="$(image_extension "$url" "$content_type")"
  final_path="$IMAGES_DIR/screenshot-$index.$ext"
  mv -f "$tmp_file" "$final_path"
  echo "$final_path|$url|$content_type" >> "$SCREENSHOT_LOG"
  index=$((index + 1))
done < "$URLS_FILE"

# ─── Write issue.md ──────────────────────────────────────────────────────────
{
  echo "# Implement GitHub Issue #${ISSUE_NUMBER}"
  echo ""
  echo "**Issue:** ${TITLE}"
  echo "**URL:** https://github.com/${REPOSITORY}/issues/${ISSUE_NUMBER}"
  echo ""
  echo "## Issue body"
  echo ""
  echo "$BODY"
  echo ""
  echo "## Issue comments"
  echo ""
  # Format comments like formatComments in implement-issue.ts.
  comments_count="$(echo "$ISSUE_JSON" | jq '.comments | length')"
  if [ "$comments_count" -eq 0 ]; then
    echo "(no comments on this issue)"
  else
    # Format like formatComments in implement-issue.ts:
    #   "### Comment N — @author (date)\n\nbody" joined by "\n\n---\n\n"
    # jq emits each comment as a NUL-delimited record so multi-line bodies survive.
    first=true
    while IFS= read -r -d '' comment_block; do
      if [ "$first" = true ]; then first=false; else printf '\n\n---\n\n'; fi
      printf '%s\n' "$comment_block"
    done < <(echo "$ISSUE_JSON" | jq -jr '.comments | to_entries[] | "### Comment \(.key + 1) — @\(.value.author.login // "unknown") (\(.value.createdAt))\n\n\(.value.body)\u0000"')
  fi
  echo ""
  echo "## Screenshots"
  echo ""
  if [ -s "$SCREENSHOT_LOG" ]; then
    while IFS='|' read -r path _ _; do
      echo "- ${path} (read with file_read to view this screenshot)"
    done < "$SCREENSHOT_LOG"
  else
    echo "(no screenshots in this issue)"
  fi
} > "$ISSUE_MD"

# ─── Write marker file ───────────────────────────────────────────────────────
echo "$ISSUE_NUMBER" > .implement-issue-number

# ─── Print summary for the agent ─────────────────────────────────────────────
echo "Fetched issue #${ISSUE_NUMBER}: ${TITLE}"
echo "Issue body + comments: ${ISSUE_MD}"
echo "Screenshots:"
if [ -s "$SCREENSHOT_LOG" ]; then
  while IFS='|' read -r path _ _; do
    echo "  - ${path}"
  done < "$SCREENSHOT_LOG"
else
  echo "  (none)"
fi
echo "Marker written: .implement-issue-number"
