#!/usr/bin/env bash
# Shared helpers + pinned versions for the installer build scripts.
# Sourced by build-macos.sh and (indirectly via env vars) the
# Windows script.

# Pinned Node runtime. Bump when needed — every platform installer
# downloads from the official Node.js distribution.
NODE_VERSION="${NODE_VERSION:-22.11.0}"

# Bundle identifier (macOS) + Microsoft Product ID semantics (Windows).
BUNDLE_ID="${BUNDLE_ID:-ai.thinkfleet.agentmark}"

# Human-friendly display name.
DISPLAY_NAME="${DISPLAY_NAME:-ThinkFleet AgentMark}"

# Read the package.json version. Single source of truth so installers
# match the npm version.
read_pkg_version() {
    local pkg="$1"
    node -e "console.log(require('$pkg').version)"
}

# Download a Node binary tarball/zip for the requested platform/arch.
# Args: $1=platform (darwin-arm64 / darwin-x64 / win-x64), $2=output dir.
download_node() {
    local target="$1"
    local out_dir="$2"
    local archive_ext="tar.xz"
    if [[ "$target" == win-* ]]; then
        archive_ext="zip"
    fi
    local url="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${target}.${archive_ext}"
    local archive="$out_dir/node-${target}.${archive_ext}"

    mkdir -p "$out_dir"
    echo "Downloading Node v${NODE_VERSION} for ${target}…"
    curl --fail --location --silent --show-error --output "$archive" "$url"
    echo "$archive"
}

# Print a uniform header so the build log is scannable.
section() {
    echo
    echo "=== $1 ==="
}

# Fail loudly with a clear message.
die() {
    echo "ERROR: $*" >&2
    exit 1
}
