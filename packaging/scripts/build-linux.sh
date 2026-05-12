#!/usr/bin/env bash
# Build the Linux AppImage.
#
# Pipeline:
#   1. pnpm build → dist/
#   2. Download pinned Node binary (linux-x64).
#   3. Assemble an AppDir.
#   4. Download appimagetool, run it.
#
# Output: dist/installer/AgentMark-<version>-linux-x86_64.AppImage
#
# Note: no a11y bridge bundled (Linux AT-SPI bridge isn't in this
# codebase yet). The agentmark MCP server runs fine — every plugin
# except `desktop` works. Add the Linux bridge later, ship it via
# the same AppDir layout when it lands.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

VERSION="$(read_pkg_version "$REPO_ROOT/package.json")"
BUILD_DIR="$REPO_ROOT/dist/installer-build/linux"
OUT_DIR="$REPO_ROOT/dist/installer"
APPDIR="$BUILD_DIR/AgentMark.AppDir"
APPIMAGE_OUT="$OUT_DIR/AgentMark-${VERSION}-linux-x86_64.AppImage"

mkdir -p "$BUILD_DIR" "$OUT_DIR"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/lib/agentmark" "$APPDIR/usr/share/applications" "$APPDIR/usr/share/icons/hicolor/256x256/apps"

# ──────────────────────────────────────────────────────────────────────
# 1. Build the npm package
# ──────────────────────────────────────────────────────────────────────
section "Build npm package"
cd "$REPO_ROOT"
pnpm install --frozen-lockfile
pnpm build

# ──────────────────────────────────────────────────────────────────────
# 2. Download pinned Node
# ──────────────────────────────────────────────────────────────────────
section "Download Node v${NODE_VERSION} (linux-x64)"
NODE_ARCHIVE="$(download_node "linux-x64" "$BUILD_DIR/node-download")"
NODE_EXTRACT_DIR="$BUILD_DIR/node-extract"
mkdir -p "$NODE_EXTRACT_DIR"
tar -xJf "$NODE_ARCHIVE" -C "$NODE_EXTRACT_DIR"
NODE_BIN="$NODE_EXTRACT_DIR/node-v${NODE_VERSION}-linux-x64/bin/node"
[[ -x "$NODE_BIN" ]] || die "Extracted Node binary not found at $NODE_BIN"

# ──────────────────────────────────────────────────────────────────────
# 3. Assemble AppDir
# ──────────────────────────────────────────────────────────────────────
section "Assemble AppDir"

# Node runtime + npm package
cp "$NODE_BIN" "$APPDIR/usr/bin/node"
chmod +x "$APPDIR/usr/bin/node"

cp -R "$REPO_ROOT/dist" "$APPDIR/usr/lib/agentmark/dist"
cp -R "$REPO_ROOT/schema" "$APPDIR/usr/lib/agentmark/schema"
cp "$REPO_ROOT/package.json" "$APPDIR/usr/lib/agentmark/package.json"

( cd "$APPDIR/usr/lib/agentmark" && \
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  pnpm install --prod --ignore-scripts )

# Launcher + AppRun
cp "$SCRIPT_DIR/../templates/launcher.sh" "$APPDIR/usr/bin/agentmark-mcp"
chmod +x "$APPDIR/usr/bin/agentmark-mcp"

# AppRun is the AppImage entrypoint — it runs when the user
# double-clicks (or executes) the .AppImage. Delegates to our
# launcher, which already knows how to find Node + the agentmark dist
# relative to its own location.
cp "$SCRIPT_DIR/../templates/AppRun" "$APPDIR/AppRun"
chmod +x "$APPDIR/AppRun"

# Required by the AppImage spec: a .desktop file + an icon. We don't
# ship a GUI, but appimagetool refuses to build without these so we
# satisfy the spec with minimal valid content.
sed "s/__VERSION__/$VERSION/g" "$SCRIPT_DIR/../templates/agentmark.desktop" > "$APPDIR/agentmark.desktop"
cp "$APPDIR/agentmark.desktop" "$APPDIR/usr/share/applications/agentmark.desktop"

# Placeholder icon. AppImage needs *something* at the AppDir root and
# under usr/share/icons. A 1x1 transparent PNG is enough.
PLACEHOLDER_PNG="$BUILD_DIR/agentmark.png"
if [[ ! -f "$PLACEHOLDER_PNG" ]]; then
    # 1x1 transparent PNG, base64-encoded.
    base64 --decode > "$PLACEHOLDER_PNG" <<EOF
iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAA
SUVORK5CYII=
EOF
fi
cp "$PLACEHOLDER_PNG" "$APPDIR/agentmark.png"
cp "$PLACEHOLDER_PNG" "$APPDIR/usr/share/icons/hicolor/256x256/apps/agentmark.png"

# ──────────────────────────────────────────────────────────────────────
# 4. Build the AppImage
# ──────────────────────────────────────────────────────────────────────
section "Build .AppImage"
APPIMAGETOOL="$BUILD_DIR/appimagetool"
if [[ ! -x "$APPIMAGETOOL" ]]; then
    echo "Downloading appimagetool…"
    curl --fail --location --silent --show-error \
        --output "$APPIMAGETOOL" \
        "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"
    chmod +x "$APPIMAGETOOL"
fi

# `--no-appstream` skips the appstreamcli check (we're a CLI, no
# AppStream metadata). `ARCH=x86_64` ensures the output is named
# consistently regardless of the host arch.
ARCH=x86_64 "$APPIMAGETOOL" --no-appstream "$APPDIR" "$APPIMAGE_OUT"

section "Done"
echo "Installer: $APPIMAGE_OUT"
ls -lh "$APPIMAGE_OUT"
