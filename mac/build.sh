#!/usr/bin/env bash
# Build Nocturne's macOS menu-bar helper (NocturneMenu.app): the icon at the top of the screen with the
# now-playing panel, and the desktop player. Needs only Apple's Command Line Tools (xcrun swiftc).
#   bash mac/build.sh [OUT_DIR]        (default: mac/build)
# The WidgetKit widget is built and embedded too, but ONLY when an Apple-issued code-signing identity
# is in the keychain (Apple Development / Developer ID, or NOCTURNE_SIGN_ID=<name or hash>): macOS
# refuses widgets from ad-hoc / self-signed apps. Without one the helper is ad-hoc signed and works.
# Rebuilds only when a source changed (Contents/Resources/stamp).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT="${1:-$HERE/build}"
APP="$OUT/NocturneMenu.app"

if ! xcode-select -p >/dev/null 2>&1 || ! xcrun --find swiftc >/dev/null 2>&1; then
  echo "menu-bar helper skipped: no Swift compiler (install Apple's Command Line Tools: xcode-select --install)"
  exit 2
fi
SDK="$(xcrun --show-sdk-path)"
ARCH="$(uname -m)"

ID="${NOCTURNE_SIGN_ID:-}"
if [ -z "$ID" ]; then
  ID="$(security find-identity -v -p codesigning 2>/dev/null | awk '/"(Apple Development|Developer ID Application|Mac Developer)/{print $2; exit}')" || true
fi

STAMP="$( (cat "$HERE"/menu/*.swift "$HERE"/widget/*.swift "$HERE/build.sh" "$ROOT/assets/nocturne-tray-mac.png"; echo "$ID $ARCH") | shasum | cut -c1-16)"
if [ -f "$APP/Contents/Resources/stamp" ] && [ "$(cat "$APP/Contents/Resources/stamp")" = "$STAMP" ]; then
  echo "menu-bar helper up to date ($APP)"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
B="$TMP/NocturneMenu.app"
mkdir -p "$B/Contents/MacOS" "$B/Contents/Resources"
echo "compiling the menu-bar helper..."
xcrun swiftc -O -swift-version 5 -target "$ARCH-apple-macos13.0" -sdk "$SDK" -module-name NocturneMenu \
  "$HERE"/menu/*.swift -o "$B/Contents/MacOS/NocturneMenu"
cp "$ROOT/assets/nocturne-tray-mac.png" "$B/Contents/Resources/menubar.png"
cp "$ROOT/assets/nocturne.icns" "$B/Contents/Resources/nocturne.icns"
echo "$STAMP" > "$B/Contents/Resources/stamp"

cat > "$B/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Nocturne Menu</string>
  <key>CFBundleDisplayName</key><string>Nocturne</string>
  <key>CFBundleIdentifier</key><string>com.grant.nocturne.menu</string>
  <key>CFBundleExecutable</key><string>NocturneMenu</string>
  <key>CFBundleIconFile</key><string>nocturne</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleSupportedPlatforms</key><array><string>MacOSX</string></array>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>com.grant.nocturne.menu</string>
    <key>CFBundleURLSchemes</key><array><string>nocturne-menu</string></array>
  </dict></array>
</dict></plist>
EOF

# the widget is a bonus: if it fails to build or sign (e.g. a locked keychain over ssh), the helper is still made,
# ad-hoc signed and without it (set -e used to abort the whole build = no menu-bar panel at all)
build_widget() {
  X="$B/Contents/PlugIns/NowPlaying.appex"
  mkdir -p "$X/Contents/MacOS"
  xcrun swiftc -O -swift-version 5 -target "$ARCH-apple-macos14.0" -sdk "$SDK" -module-name NocturneWidget \
    -parse-as-library -application-extension "$HERE/widget/NowPlayingWidget.swift" -o "$X/Contents/MacOS/NowPlaying"
  cat > "$X/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>NowPlaying</string>
  <key>CFBundleDisplayName</key><string>Nocturne</string>
  <key>CFBundleIdentifier</key><string>com.grant.nocturne.menu.nowplaying</string>
  <key>CFBundleExecutable</key><string>NowPlaying</string>
  <key>CFBundlePackageType</key><string>XPC!</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleSupportedPlatforms</key><array><string>MacOSX</string></array>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>NSExtension</key><dict><key>NSExtensionPointIdentifier</key><string>com.apple.widgetkit-extension</string></dict>
</dict></plist>
EOF
  cat > "$TMP/widget.entitlements" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.app-sandbox</key><true/>
  <key>com.apple.security.network.client</key><true/>
</dict></plist>
EOF
  codesign -f -s "$ID" --options runtime --entitlements "$TMP/widget.entitlements" "$X"
  codesign -f -s "$ID" --options runtime "$B"
}
if [ -n "$ID" ]; then
  echo "signing identity found ($ID): building the widget too..."
  if ! (set -e; build_widget); then
    echo "widget build/signing failed: making the helper without it"
    rm -rf "$B/Contents/PlugIns"
    ID=""
    codesign -f -s - "$B"
  fi
else
  codesign -f -s - "$B"
fi
mkdir -p "$OUT"
rm -rf "$APP"
mv "$B" "$APP"
echo "built $APP$( [ -n "$ID" ] && echo " (+ widget, signed by $ID)" || echo " (no widget: no Apple-issued signing identity)")"
