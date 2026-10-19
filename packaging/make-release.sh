#!/usr/bin/env bash
# Assemble the Linux release files of a built Colony into <out dir>:
#   colony-<version>-linux-x86_64.tar.gz   binary + icon, the file install.sh installs
#   Colony_<version>_amd64.deb             the Tauri .deb bundle, when present
#   install.sh                             the curl installer
#   SHA256SUMS                             sha256 of every file above
# Signing SHA256SUMS is a separate step (release workflow: tauri signer sign).
# Usage: packaging/make-release.sh <version> <out dir>   (after pnpm tauri build)
set -euo pipefail
version="${1:?version}"
out="${2:?out dir}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin="${COLONY_RELEASE_BIN:-$repo/src-tauri/target/release/colony}"
deb="$repo/src-tauri/target/release/bundle/deb/Colony_${version}_amd64.deb"
[[ -x "$bin" ]] || { echo "missing $bin: run pnpm tauri build first" >&2; exit 1; }

name="colony-$version-linux-x86_64"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/$name" "$out"
install -m 755 "$bin" "$stage/$name/colony"
install -m 644 "$repo/src-tauri/icons/128x128@2x.png" "$stage/$name/colony.png"
tar --sort=name --owner=0 --group=0 --numeric-owner -C "$stage" -czf "$out/$name.tar.gz" "$name"
[[ -f "$deb" ]] && cp "$deb" "$out/"
install -m 755 "$repo/packaging/install.sh" "$out/install.sh"
(cd "$out" && rm -f SHA256SUMS && sha256sum -- * > SHA256SUMS.tmp && mv SHA256SUMS.tmp SHA256SUMS)
echo "release files in $out:"
ls -l "$out"
