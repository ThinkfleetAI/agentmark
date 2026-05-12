#!/usr/bin/env bash
# Build the macOS .pkg installer.
#
# Pipeline:
#   1. Build the npm package (pnpm build).
#   2. Build the Swift AXAPI bridge in release mode (universal arm64+x64).
#   3. Download the pinned Node binary (arm64 + x64 if needed).
#   4. Assemble the install staging directory.
#   5. Run pkgbuild + productbuild to produce the .pkg.
#   6. (Optional) Sign + notarise if Apple secrets are present.
#
# Output: dist/installer/AgentMark-<version>-macos.pkg
#
# Designed to run BOTH on a developer's Mac and in GitHub Actions
# macos-latest. Signing is conditional on env vars; missing certs are
# logged but don't fail the build.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

VERSION="$(read_pkg_version "$REPO_ROOT/package.json")"
BUILD_DIR="$REPO_ROOT/dist/installer-build/macos"
OUT_DIR="$REPO_ROOT/dist/installer"
STAGE_DIR="$BUILD_DIR/stage/opt/thinkfleet/agentmark"
PKG_OUT="$OUT_DIR/AgentMark-${VERSION}-macos.pkg"

mkdir -p "$BUILD_DIR" "$OUT_DIR"
rm -rf "$BUILD_DIR/stage"
mkdir -p "$STAGE_DIR"

# ──────────────────────────────────────────────────────────────────────
# 1. Build the npm package
# ──────────────────────────────────────────────────────────────────────
section "Build npm package"
cd "$REPO_ROOT"
pnpm install --frozen-lockfile
pnpm build

# ──────────────────────────────────────────────────────────────────────
# 2. Build the Swift bridge (release, universal)
# ──────────────────────────────────────────────────────────────────────
section "Build macOS AXAPI bridge"
cd "$REPO_ROOT/apps/agent-runner/bridges/macos"
swift build -c release --arch arm64 --arch x86_64
BRIDGE_BIN="$REPO_ROOT/apps/agent-runner/bridges/macos/.build/apple/Products/Release/agentmark-bridge-macos"
[[ -f "$BRIDGE_BIN" ]] || die "Swift build did not produce expected binary at $BRIDGE_BIN"

# ──────────────────────────────────────────────────────────────────────
# 3. Download pinned Node
# ──────────────────────────────────────────────────────────────────────
section "Download Node v${NODE_VERSION}"
HOST_ARCH="$(uname -m)"
NODE_TARGET="darwin-arm64"
if [[ "$HOST_ARCH" != "arm64" ]]; then
    NODE_TARGET="darwin-x64"
fi
NODE_ARCHIVE="$(download_node "$NODE_TARGET" "$BUILD_DIR/node-download")"
NODE_EXTRACT_DIR="$BUILD_DIR/node-extract"
mkdir -p "$NODE_EXTRACT_DIR"
tar -xJf "$NODE_ARCHIVE" -C "$NODE_EXTRACT_DIR"
NODE_BIN="$NODE_EXTRACT_DIR/node-v${NODE_VERSION}-${NODE_TARGET}/bin/node"
[[ -x "$NODE_BIN" ]] || die "Extracted Node binary not found at $NODE_BIN"

# ──────────────────────────────────────────────────────────────────────
# 4. Assemble staging tree
# ──────────────────────────────────────────────────────────────────────
section "Assemble installer staging"
mkdir -p "$STAGE_DIR/bin" "$STAGE_DIR/bridges"

# Node runtime
cp "$NODE_BIN" "$STAGE_DIR/node"
chmod +x "$STAGE_DIR/node"

# npm package: copy dist/ + schema/ + package.json + production deps
mkdir -p "$STAGE_DIR/agentmark"
cp -R "$REPO_ROOT/dist" "$STAGE_DIR/agentmark/dist"
cp -R "$REPO_ROOT/schema" "$STAGE_DIR/agentmark/schema"
cp "$REPO_ROOT/package.json" "$STAGE_DIR/agentmark/package.json"

# Install production deps into the staging dir. --prod skips devDeps
# (vitest, eslint, etc.). Playwright Chromium is *not* downloaded here;
# the agent-side `agentmark-mcp install-browsers` step handles that
# when the web plugin is used.
( cd "$STAGE_DIR/agentmark" && \
  PNPM_DEPLOY_NO_FROZEN_LOCKFILE=true \
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  pnpm install --prod --ignore-scripts )

# Bridge
cp "$BRIDGE_BIN" "$STAGE_DIR/bridges/agentmark-bridge-macos"
chmod +x "$STAGE_DIR/bridges/agentmark-bridge-macos"

# Launcher script
cp "$SCRIPT_DIR/../templates/launcher.sh" "$STAGE_DIR/bin/agentmark-mcp"
chmod +x "$STAGE_DIR/bin/agentmark-mcp"

# ──────────────────────────────────────────────────────────────────────
# 5. Build the .pkg
# ──────────────────────────────────────────────────────────────────────
section "Build .pkg"
COMPONENT_PKG="$BUILD_DIR/agentmark-component.pkg"

# pkgbuild creates a single-component package. We pair it with
# productbuild so we can attach a Distribution.xml (which controls the
# installer UX — license screen, post-install symlink to /usr/local/bin).
pkgbuild \
    --root "$BUILD_DIR/stage" \
    --identifier "$BUNDLE_ID" \
    --version "$VERSION" \
    --install-location "/" \
    --scripts "$SCRIPT_DIR/../templates/macos-pkg-scripts" \
    "$COMPONENT_PKG"

DISTRIBUTION_XML="$BUILD_DIR/distribution.xml"
sed "s/__VERSION__/$VERSION/g; s/__BUNDLE_ID__/$BUNDLE_ID/g; s/__DISPLAY_NAME__/$DISPLAY_NAME/g" \
    "$SCRIPT_DIR/../templates/distribution.xml" > "$DISTRIBUTION_XML"

productbuild \
    --distribution "$DISTRIBUTION_XML" \
    --package-path "$BUILD_DIR" \
    --version "$VERSION" \
    "$PKG_OUT"

# ──────────────────────────────────────────────────────────────────────
# 6. Sign + notarise (optional — only when Apple secrets are present)
# ──────────────────────────────────────────────────────────────────────
if [[ -n "${APPLE_DEVELOPER_ID:-}" ]]; then
    section "Sign .pkg"
    SIGNED_PKG="$BUILD_DIR/AgentMark-${VERSION}-macos-signed.pkg"
    productsign \
        --sign "$APPLE_DEVELOPER_ID" \
        "$PKG_OUT" \
        "$SIGNED_PKG"
    mv "$SIGNED_PKG" "$PKG_OUT"

    if [[ -n "${APPLE_APP_NOTARIZATION_USER:-}" && -n "${APPLE_APP_NOTARIZATION_TEAM_ID:-}" && -n "${APPLE_APP_NOTARIZATION_PASSWORD:-}" ]]; then
        section "Notarise .pkg"
        xcrun notarytool submit "$PKG_OUT" \
            --apple-id "$APPLE_APP_NOTARIZATION_USER" \
            --team-id "$APPLE_APP_NOTARIZATION_TEAM_ID" \
            --password "$APPLE_APP_NOTARIZATION_PASSWORD" \
            --wait
        xcrun stapler staple "$PKG_OUT"
    else
        echo "Notarisation env vars not set; skipping. Apple Gatekeeper will warn end users."
    fi
else
    echo "APPLE_DEVELOPER_ID not set; skipping signing. The .pkg works but Gatekeeper will warn."
fi

section "Done"
echo "Installer: $PKG_OUT"
ls -lh "$PKG_OUT"
