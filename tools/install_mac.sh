#!/usr/bin/env bash
# Build ~/Applications/Nocturne.app on the Mac (the app was called Tempo before Nov 20; code stays in ~/Tempo). The app runs ~/Tempo's code with ~/Tempo/.venv.
# The bundle carries its own python symlink + pyvenv.cfg so macOS treats the process as "Nocturne"
# (Dock name/icon, Now Playing) instead of "Python".
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"   # the folder this copy lives in (Grant's Mac: ~/Tempo)
APP="${NOCTURNE_APP:-$HOME/Applications/Nocturne.app}"   # override only for test builds
rm -rf "$HOME/Applications/Tempo.app" "$ROOT/Tempo.app"   # the app before it was renamed
VENV="$ROOT/.venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo "no venv at $VENV - create it first:"
  echo "  ~/.local/bin/uv venv --python 3.13 $VENV && ~/.local/bin/uv pip install --python $VENV/bin/python -r $ROOT/requirements.txt"
  exit 1
fi
REAL_PY="$(readlink -f "$VENV/bin/python")"
PYVER="$("$VENV/bin/python" -c 'import sys; print(f"python{sys.version_info[0]}.{sys.version_info[1]}")')"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ROOT/assets/nocturne.icns" "$APP/Contents/Resources/nocturne.icns"
# a real copy (not a symlink): macOS resolves symlinks, and the process must live inside the bundle
# for the Dock / Activity Monitor / Now Playing to call it "Nocturne". uv's python is one static 17 MB file.
cp "$REAL_PY" "$APP/Contents/MacOS/python3"
ln -s "$VENV/lib" "$APP/Contents/lib"
sed "s#^home = .*#home = $(dirname "$REAL_PY")#" "$VENV/pyvenv.cfg" > "$APP/Contents/pyvenv.cfg"

cat > "$APP/Contents/MacOS/Nocturne" <<EOF
#!/bin/bash
export PATH="$VENV/bin:\$PATH"
# macOS malloc otherwise keeps freed large blocks dirty (shows as memory use)
export MallocLargeCache=0
exec "\$(dirname "\$0")/python3" "$ROOT/run.py" "\$@"
EOF
chmod +x "$APP/Contents/MacOS/Nocturne"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Nocturne</string>
  <key>CFBundleDisplayName</key><string>Nocturne</string>
  <key>CFBundleIdentifier</key><string>com.grant.nocturne</string>
  <key>CFBundleExecutable</key><string>Nocturne</string>
  <key>CFBundleIconFile</key><string>nocturne</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.music</string>
</dict></plist>
EOF
# the menu-bar helper: icon at the top of the screen with the now-playing panel + the desktop player (mac/menu).
# Needs Apple's Command Line Tools to compile; without it Nocturne keeps its plain menu-bar icon.
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
HELPER=""
if bash "$ROOT/mac/build.sh" "$ROOT/mac/build"; then
  mkdir -p "$APP/Contents/Helpers"
  cp -R "$ROOT/mac/build/NocturneMenu.app" "$APP/Contents/Helpers/"
  HELPER="$APP/Contents/Helpers/NocturneMenu.app"
else
  echo "(menu-bar panel not built: Nocturne uses its plain menu-bar icon)"
fi
# a link from the code folder too, so the engine can reopen the window via `open`
ln -sfn "$APP" "$ROOT/Nocturne.app"
touch "$APP"
"$LSR" -f "$APP" >/dev/null 2>&1 || true
if [ -n "$HELPER" ]; then
  "$LSR" -f "$HELPER" >/dev/null 2>&1 || true     # its nocturne-menu:// links (widget buttons)
  if [ -d "$HELPER/Contents/PlugIns/NowPlaying.appex" ]; then
    pluginkit -a "$HELPER/Contents/PlugIns/NowPlaying.appex" 2>/dev/null || true
    echo "widget registered (Notification Center / desktop: Edit Widgets -> Nocturne)"
  fi
fi
echo "built $APP ($PYVER)"
