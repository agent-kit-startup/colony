#!/usr/bin/env bash
# Assemble the Linux release files of a built Colony into <out dir>:
#   colony-<version>-linux-x86_64.tar.gz   binary + icon (direct channel), what install.sh installs
#   colony-<version>-linux-x86_64-package.tar.gz
#                                          binary + icon built with --no-default-features
#                                          (package channel, no updater): the source of distro
#                                          packages (AUR colony-bin); when COLONY_PACKAGE_BIN is set
#   Colony_<version>_amd64.deb             the Tauri .deb bundle, when present
#   Colony_<version>_amd64.AppImage        the Tauri AppImage (direct channel, updates itself)
#   Colony_<version>_amd64.AppImage.sig    its updater signature (createUpdaterArtifacts)
#   latest.json                            the updater manifest (tauri-plugin-updater static
#                                          JSON), when the AppImage signature is present
#   install.sh                             the curl installer
#   SHA256SUMS                             sha256 of every file above
# Signing SHA256SUMS is a separate step (release workflow: tauri signer sign).
# Usage: packaging/make-release.sh <version> <out dir>   (after pnpm tauri build)
# Environment: COLONY_RELEASE_BIN, COLONY_PACKAGE_BIN, COLONY_RELEASE_APPIMAGE (paths),
#   COLONY_RELEASE_REPO (owner/name for latest.json URLs, default agent-kit-startup/colony),
#   COLONY_RELEASE_NOTES (latest.json notes).
set -euo pipefail
version="${1:?version}"
out="${2:?out dir}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin="${COLONY_RELEASE_BIN:-$repo/src-tauri/target/release/colony}"
deb="$repo/src-tauri/target/release/bundle/deb/Colony_${version}_amd64.deb"
appimage="${COLONY_RELEASE_APPIMAGE:-$repo/src-tauri/target/release/bundle/appimage/Colony_${version}_amd64.AppImage}"
pkgbin="${COLONY_PACKAGE_BIN:-}"
gh_repo="${COLONY_RELEASE_REPO:-agent-kit-startup/colony}"
[[ -x "$bin" ]] || { echo "missing $bin: run pnpm tauri build first" >&2; exit 1; }

name="colony-$version-linux-x86_64"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/$name" "$out"
install -m 755 "$bin" "$stage/$name/colony"
install -m 644 "$repo/src-tauri/icons/128x128@2x.png" "$stage/$name/colony.png"
tar --sort=name --owner=0 --group=0 --numeric-owner -C "$stage" -czf "$out/$name.tar.gz" "$name"
if [[ -n "$pkgbin" ]]; then
  [[ -x "$pkgbin" ]] || { echo "missing $pkgbin (COLONY_PACKAGE_BIN)" >&2; exit 1; }
  install -m 755 "$pkgbin" "$stage/$name/colony"
  tar --sort=name --owner=0 --group=0 --numeric-owner -C "$stage" -czf "$out/$name-package.tar.gz" "$name"
fi
if [[ -f "$deb" ]]; then cp "$deb" "$out/"; fi
if [[ -f "$appimage" ]]; then
  ai="Colony_${version}_amd64.AppImage"
  cp "$appimage" "$out/$ai"
  if [[ -f "$appimage.sig" ]]; then
    cp "$appimage.sig" "$out/$ai.sig"
    # Static updater manifest: only the AppImage is updated in place (src-tauri/src/appupdate.rs).
    node -e '
      const [version, sigFile, url, notes] = process.argv.slice(1);
      const fs = require("fs");
      const m = { version, notes, pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        platforms: { "linux-x86_64-appimage": { signature: fs.readFileSync(sigFile, "utf8").trim(), url } } };
      process.stdout.write(JSON.stringify(m, null, 2) + "\n");
    ' "$version" "$out/$ai.sig" "https://github.com/$gh_repo/releases/download/v$version/$ai" "${COLONY_RELEASE_NOTES:-Colony $version}" > "$out/latest.json"
  fi
fi
install -m 755 "$repo/packaging/install.sh" "$out/install.sh"
(cd "$out" && rm -f SHA256SUMS && sha256sum -- * > SHA256SUMS.tmp && mv SHA256SUMS.tmp SHA256SUMS)
echo "release files in $out:"
ls -l "$out"
