#!/usr/bin/env bash
# Nocturne setup for macOS: uv + Python 3.13 venv + packages, the mpv player, ~/Applications/Nocturne.app.
# Run it from this folder in Terminal:  bash setup_mac.sh      (safe to run again)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
echo "Setting up Nocturne in $ROOT"

# 1. uv (a small Python manager; no Homebrew or admin needed)
UV="$(command -v uv || true)"
if [ -z "$UV" ]; then
  [ -x "$HOME/.local/bin/uv" ] || curl -LsSf https://astral.sh/uv/install.sh | sh
  UV="$HOME/.local/bin/uv"
fi

# 2. venv + packages
[ -x "$ROOT/.venv/bin/python" ] || "$UV" venv --python 3.13 "$ROOT/.venv"
"$UV" pip install --python "$ROOT/.venv/bin/python" -r "$ROOT/requirements.txt"

# 3. mpv (the audio engine): the official build from github.com/mpv-player/mpv for this Mac
if [ ! -x "$ROOT/bin/mpv.app/Contents/MacOS/mpv" ]; then
  MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
  if [ "$(uname -m)" = "arm64" ]; then KIND=arm; else KIND=intel; fi
  URLS="$(curl -fsSL https://api.github.com/repos/mpv-player/mpv/releases/latest | grep -o '"browser_download_url": *"[^"]*macos-[0-9]*-'"$KIND"'\.zip"' | sed 's/.*"\(https[^"]*\)"/\1/')"
  # the newest build made for this macOS version or older
  URL="$(echo "$URLS" | awk -v m="$MAJOR" '{ v = $0; sub(/.*macos-/, "", v); sub(/-.*/, "", v); if (v + 0 <= m + 0 && v + 0 > best) { best = v + 0; u = $0 } } END { print u }')"
  [ -n "$URL" ] || URL="$(echo "$URLS" | head -1)"
  [ -n "$URL" ] || { echo "couldn't find an mpv download for macOS $MAJOR ($KIND)"; exit 1; }
  echo "Downloading $(basename "$URL")..."
  TMP="$(mktemp -d)"
  curl -fsSL "$URL" -o "$TMP/mpv.zip"
  unzip -q "$TMP/mpv.zip" -d "$TMP"
  APPSRC="$(find "$TMP" -maxdepth 3 -name 'mpv.app' -type d | head -1)"
  mkdir -p "$ROOT/bin"
  rm -rf "$ROOT/bin/mpv.app"
  cp -R "$APPSRC" "$ROOT/bin/mpv.app"
  xattr -dr com.apple.quarantine "$ROOT/bin/mpv.app" 2>/dev/null || true
  rm -rf "$TMP"
fi

# 4. ~/Applications/Nocturne.app
bash "$ROOT/tools/install_mac.sh"
echo
echo "Done. Open Nocturne from ~/Applications (or Spotlight: Nocturne)."
