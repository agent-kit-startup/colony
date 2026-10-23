#!/bin/sh
# Colony installer (Linux x86_64, per user, no sudo).
#
#   curl -fsSL https://colony.missionkit.io/install.sh | sh
#   curl -fsSL https://colony.missionkit.io/install.sh | sh -s -- --uninstall
#
# It downloads SHA256SUMS and SHA256SUMS.sig of a release, verifies the signature
# with the Colony release public key below (minisign format, made by the Tauri
# signer in the release workflow), checks the tarball against SHA256SUMS, and only
# then installs. Any failed check stops before anything is written.
#
# Layout of a release under the download base:
#   <base>/LATEST                                  one line: the latest version
#   <base>/v<version>/SHA256SUMS                   sha256 of every release file
#   <base>/v<version>/SHA256SUMS.sig               base64 minisign signature of SHA256SUMS
#   <base>/v<version>/colony-<version>-linux-x86_64.tar.gz
#
# Installs:
#   ${XDG_DATA_HOME:-~/.local/share}/colony/app/<version>/   binary and icon
#   ${XDG_DATA_HOME:-~/.local/share}/colony/app/current      symlink to the version in use
#   ~/.local/bin/colony                                      launcher
#   ${XDG_DATA_HOME:-~/.local/share}/applications/colony.desktop
#
# Environment:
#   COLONY_DOWNLOAD_BASE  download base, https:// or file:// (default below)
#   COLONY_VERSION        version to install (default: the one in <base>/LATEST)
#   COLONY_BIN_DIR        launcher folder (default ~/.local/bin)
#
# The Colony repository is private, so its GitHub releases cannot be fetched
# anonymously: the default base only works once the release files are published
# there (see docs/release.md).
set -eu

PUBKEY_ID="9A9BB4349C2248C6"
PUBKEY="RWTGSCKcNLSbmtr69jGw/BdVDJPeqVUJFZYuePFlQH0626GHgPpxdalV"
DEFAULT_BASE="https://colony.missionkit.io/releases"

say() { printf 'colony-install: %s\n' "$*"; }
die() { printf 'colony-install: error: %s\n' "$*" >&2; exit 1; }

base="${COLONY_DOWNLOAD_BASE:-$DEFAULT_BASE}"
version="${COLONY_VERSION:-}"
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
app_root="$data_home/colony/app"
bin_dir="${COLONY_BIN_DIR:-$HOME/.local/bin}"
launcher="$bin_dir/colony"
desktop="$data_home/applications/colony.desktop"
marker="# colony-install launcher"

usage() {
  cat <<EOF
Usage: install.sh [--version <x.y.z>] [--uninstall] [--omarchy-snippet]
  --version          install this version instead of the latest one
  --uninstall        remove the installed app, its launcher and its desktop entry
                     (the managed engine, Node runtime and settings stay; paths are printed)
  --omarchy-snippet  print an optional Omarchy 4 Hyprland snippet (keybinding and
                     window rule for Colony) and exit; nothing is installed or written
EOF
}

# Optional Omarchy 4 snippet. Printed only; Colony and this installer never write
# under ~/.config/hypr. Uses the Omarchy Lua helpers (o.bind / o.window).
omarchy_snippet() {
  cat <<'EOF'
-- Colony on Omarchy 4 (optional). Paste into ~/.config/hypr/bindings.lua, or save
-- as ~/.config/hypr/colony.lua and add require("hypr.colony") to hyprland.lua.
-- To remove it, delete these lines.

-- SUPER+SHIFT+I: focus the Colony window, or start Colony when none is open.
-- A suggestion: SUPER+SHIFT+I is free in the Omarchy 4 defaults; pick another key
-- if you bound it yourself (omarchy menu keybindings --print lists them).
o.bind("SUPER + SHIFT + I", "Colony", { launch = "colony", focus = "^colony$" })

-- Colony keeps native decorations: Hyprland draws no titlebar, so there are no
-- window buttons to hide. Add your own rules here if you want them, for example:
-- o.window("^colony$", { workspace = "3" })
EOF
}

uninstall() {
  removed=0
  if [ -d "$app_root" ]; then rm -rf "$app_root"; say "removed $app_root"; removed=1; fi
  if [ -f "$launcher" ]; then
    if grep -q "$marker" "$launcher" 2>/dev/null; then rm -f "$launcher"; say "removed $launcher"; removed=1
    else say "kept $launcher: not written by this installer"; fi
  fi
  if [ -f "$desktop" ] && grep -q "^X-Colony-Install=1" "$desktop" 2>/dev/null; then
    rm -f "$desktop"; say "removed $desktop"; removed=1
  fi
  [ "$removed" = 1 ] || say "nothing to remove"
  say "left in place (delete by hand if you want them gone):"
  say "  $data_home/colony/engine and $data_home/colony/runtime (managed engine, Node)"
  say "  ${XDG_CONFIG_HOME:-$HOME/.config}/colony (settings)"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) uninstall; exit 0 ;;
    --omarchy-snippet) omarchy_snippet; exit 0 ;;
    --version) [ $# -ge 2 ] || die "--version needs a value"; version="$2"; shift 2 ;;
    --version=*) version="${1#--version=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

case "$base" in
  https://*|file://*) ;;
  *) die "COLONY_DOWNLOAD_BASE must start with https:// or file:// (got $base)" ;;
esac
base="${base%/}"

[ "$(uname -s)" = Linux ] || die "only Linux is supported for now (got $(uname -s))"
case "$(uname -m)" in
  x86_64|amd64) arch=x86_64 ;;
  *) die "only x86_64 is supported for now (got $(uname -m))" ;;
esac

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }
need curl; need tar; need sha256sum; need base64; need mktemp

fetch() { # url dest
  curl -fsSL --proto '=https,file' --retry 2 -o "$2" "$1" || die "download failed: $1"
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

if [ -z "$version" ]; then
  fetch "$base/LATEST" "$tmp/LATEST"
  version="$(tr -d ' \t\r\n' < "$tmp/LATEST")"
fi
version="${version#v}"
case "$version" in
  ''|*[!0-9A-Za-z.+-]*) die "invalid version: '$version'" ;;
esac

rel="$base/v$version"
tarball="colony-$version-linux-$arch.tar.gz"
say "installing Colony $version from $rel"
fetch "$rel/SHA256SUMS" "$tmp/SHA256SUMS"
fetch "$rel/SHA256SUMS.sig" "$tmp/SHA256SUMS.sig"

# --- signature of SHA256SUMS -------------------------------------------------
# The .sig file is base64 of a minisign signature file. Verified with minisign
# when it is installed, else with OpenSSL 3 (Ed25519 + BLAKE2b-512, the same
# checks minisign makes). Neither present: stop, never install unverified.
base64 -d < "$tmp/SHA256SUMS.sig" > "$tmp/SHA256SUMS.minisig" 2>/dev/null || die "SHA256SUMS.sig is not base64"

verify_openssl() {
  d="$tmp/v"; mkdir -p "$d"
  printf '%s\n' "$PUBKEY" | base64 -d > "$d/pk" 2>/dev/null || return 1
  sed -n 2p "$tmp/SHA256SUMS.minisig" | base64 -d > "$d/sig" 2>/dev/null || return 1
  sed -n 4p "$tmp/SHA256SUMS.minisig" | base64 -d > "$d/gsig" 2>/dev/null || return 1
  tc="$(sed -n 3p "$tmp/SHA256SUMS.minisig")"
  case "$tc" in "trusted comment: "*) tc="${tc#trusted comment: }" ;; *) return 1 ;; esac
  [ "$(wc -c < "$d/pk")" -eq 42 ] && [ "$(wc -c < "$d/sig")" -eq 74 ] && [ "$(wc -c < "$d/gsig")" -eq 64 ] || return 1
  # Algorithm "ED" (prehashed) only, and the key id must be ours.
  [ "$(head -c 2 "$d/sig")" = ED ] || { say "signature is not a prehashed minisign signature"; return 1; }
  [ "$(tail -c +3 "$d/pk" | head -c 8 | od -An -tx1 | tr -d ' \n')" = "$(tail -c +3 "$d/sig" | head -c 8 | od -An -tx1 | tr -d ' \n')" ] \
    || { say "signature key id does not match the Colony release key $PUBKEY_ID"; return 1; }
  # SubjectPublicKeyInfo DER prefix for Ed25519, then the 32-byte key.
  { printf '\060\052\060\005\006\003\053\145\160\003\041\000'; tail -c 32 "$d/pk"; } > "$d/pk.der"
  tail -c 64 "$d/sig" > "$d/sig.raw"
  openssl dgst -blake2b512 -binary "$tmp/SHA256SUMS" > "$d/digest" || return 1
  openssl pkeyutl -verify -pubin -inkey "$d/pk.der" -keyform DER -rawin -in "$d/digest" -sigfile "$d/sig.raw" >/dev/null 2>&1 || return 1
  { cat "$d/sig.raw"; printf '%s' "$tc"; } > "$d/global"
  openssl pkeyutl -verify -pubin -inkey "$d/pk.der" -keyform DER -rawin -in "$d/global" -sigfile "$d/gsig" >/dev/null 2>&1 || return 1
}

if command -v minisign >/dev/null 2>&1; then
  minisign -Vq -P "$PUBKEY" -m "$tmp/SHA256SUMS" -x "$tmp/SHA256SUMS.minisig" >/dev/null 2>&1 \
    || die "signature check of SHA256SUMS failed (minisign, key $PUBKEY_ID)"
  say "signature ok (minisign, key $PUBKEY_ID)"
elif command -v openssl >/dev/null 2>&1 && openssl version 2>/dev/null | grep -q '^OpenSSL [3-9]'; then
  verify_openssl || die "signature check of SHA256SUMS failed (openssl, key $PUBKEY_ID)"
  say "signature ok (openssl, key $PUBKEY_ID)"
else
  die "cannot verify the release signature: install minisign (Arch: pacman -S minisign; Debian/Ubuntu: apt install minisign; Fedora: dnf install minisign) or OpenSSL 3, then run this again"
fi

# --- checksum of the tarball -------------------------------------------------
expected="$(awk -v f="$tarball" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || die "$tarball is not listed in SHA256SUMS"
fetch "$rel/$tarball" "$tmp/$tarball"
actual="$(sha256sum "$tmp/$tarball" | awk '{ print $1 }')"
[ "$actual" = "$expected" ] || die "sha256 mismatch for $tarball (expected $expected, got $actual)"
say "sha256 ok ($tarball)"

# --- install -----------------------------------------------------------------
mkdir -p "$tmp/x"
tar -xzf "$tmp/$tarball" -C "$tmp/x" --no-same-owner
src="$tmp/x/colony-$version-linux-$arch"
[ -x "$src/colony" ] || die "the tarball has no colony binary at colony-$version-linux-$arch/colony"

if [ -f "$launcher" ] && ! grep -q "$marker" "$launcher" 2>/dev/null; then
  die "$launcher exists and was not written by this installer: move it away and run this again"
fi
mkdir -p "$app_root" "$bin_dir" "$(dirname "$desktop")"
previous="$(readlink "$app_root/current" 2>/dev/null || true)"
dest="$app_root/$version"
rm -rf "$dest.new"
cp -R "$src" "$dest.new"
rm -rf "$dest"
mv "$dest.new" "$dest"
ln -sfn "$version" "$app_root/current"

cat > "$launcher" <<EOF
#!/bin/sh
$marker
exec "$app_root/current/colony" "\$@"
EOF
chmod 755 "$launcher"

cat > "$desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Colony
GenericName=Mission Kit IDE
Comment=Mission Kit Colony desktop IDE
Exec=$app_root/current/colony %f
Icon=$app_root/current/colony.png
Terminal=false
Categories=Development;IDE;
StartupWMClass=colony
X-Colony-Install=1
EOF
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$desktop")" >/dev/null 2>&1 || true

# Keep the version just replaced (to go back: --version <it>), drop older ones.
for old in "$app_root"/*; do
  [ -d "$old" ] && [ ! -L "$old" ] || continue
  case "$(basename "$old")" in "$version"|"$previous") continue ;; esac
  rm -rf "$old"
done

say "installed Colony $version: $launcher"
if command -v ldconfig >/dev/null 2>&1 && ! ldconfig -p 2>/dev/null | grep -q 'libwebkit2gtk-4.1'; then
  say "note: webkit2gtk-4.1 was not found; Colony needs it (Arch: webkit2gtk-4.1; Debian/Ubuntu: libwebkit2gtk-4.1-0; Fedora: webkit2gtk4.1)"
fi
case ":$PATH:" in *":$bin_dir:"*) ;; *) say "note: $bin_dir is not on PATH; add it to start Colony as 'colony'" ;; esac
