#!/usr/bin/env bash
# Smoke for packaging/install.sh, offline: a fake release (stub binary) signed with
# a throwaway key, served over file://, installed into a scratch HOME. Checks the
# OpenSSL verifier (and minisign when installed), refusals on a tampered
# SHA256SUMS, a foreign key, a tampered tarball and an unsupported base, then an
# upgrade that keeps one previous version, and the uninstall.
# Usage: packaging/smoke/install-smoke.sh   (needs node_modules: pnpm install)
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tauri="$repo/node_modules/.bin/tauri"
[[ -x "$tauri" ]] || { echo "missing $tauri: pnpm install first" >&2; exit 1; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
pass=0
ok() { echo "ok   $*"; pass=$((pass + 1)); }
fail() { echo "FAIL $*" >&2; exit 1; }

"$tauri" signer generate -w "$work/key" -p smoke --ci >/dev/null 2>&1
"$tauri" signer generate -w "$work/other" -p smoke --ci >/dev/null 2>&1
pub="$(base64 -d < "$work/key.pub" | sed -n 2p)"
pubid="$(base64 -d < "$work/key.pub" | sed -n 1p | awk '{ print $NF }')"
# The installer under test, with the throwaway key instead of the release key.
sed -e "s|^PUBKEY=.*|PUBKEY=\"$pub\"|" -e "s|^PUBKEY_ID=.*|PUBKEY_ID=\"$pubid\"|" \
  "$repo/packaging/install.sh" > "$work/install.sh"

release() { # version [key]
  local v="$1" key="${2:-$work/key}"
  printf '#!/bin/sh\necho colony-stub %s "$@"\n' "$v" > "$work/stub"
  chmod 755 "$work/stub"
  COLONY_RELEASE_BIN="$work/stub" "$repo/packaging/make-release.sh" "$v" "$work/base/v$v" >/dev/null
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD=smoke "$tauri" signer sign -f "$key" "$work/base/v$v/SHA256SUMS" >/dev/null 2>&1
  echo "$v" > "$work/base/LATEST"
}

home="$work/home"
run() { # PATH-filtered install.sh run in the scratch home
  env -i HOME="$home" PATH="$path" COLONY_DOWNLOAD_BASE="file://$work/base" "$@"
}
mkdir -p "$home" "$work/nominisign"
# PATH without minisign: link the tools the installer and the smoke need.
for t in sh bash curl tar gzip sha256sum base64 mktemp tr sed awk grep head tail od wc cat cp mv rm ln mkdir chmod dirname basename readlink uname openssl ldconfig env printf; do
  p="$(command -v "$t" 2>/dev/null)" && ln -sf "$p" "$work/nominisign/$t"
done
path="$work/nominisign"

release 0.0.1
out="$(run sh "$work/install.sh" 2>&1)" || fail "install 0.0.1: $out"
grep -q "signature ok (openssl" <<<"$out" || fail "openssl verifier not used: $out"
[[ "$("$home/.local/bin/colony" x)" == "colony-stub 0.0.1 x" ]] || fail "launcher does not run 0.0.1"
grep -q '^X-Colony-Install=1' "$home/.local/share/applications/colony.desktop" || fail "desktop entry"
ok "install 0.0.1 from LATEST, openssl signature check, launcher, desktop entry"

if command -v minisign >/dev/null; then
  out="$(env -i HOME="$home" PATH="$path:$(dirname "$(command -v minisign)")" COLONY_DOWNLOAD_BASE="file://$work/base" sh "$work/install.sh" 2>&1)" || fail "minisign install: $out"
  grep -q "signature ok (minisign" <<<"$out" || fail "minisign verifier not used: $out"
  ok "minisign signature check"
else
  echo "skip minisign signature check (minisign not installed)"
fi

cp "$work/base/v0.0.1/SHA256SUMS" "$work/sums.bak"
echo "0000  extra" >> "$work/base/v0.0.1/SHA256SUMS"
run sh "$work/install.sh" >/dev/null 2>&1 && fail "tampered SHA256SUMS was accepted"
cp "$work/sums.bak" "$work/base/v0.0.1/SHA256SUMS"
ok "refuses a SHA256SUMS that does not match its signature"

cp "$work/base/v0.0.1/SHA256SUMS.sig" "$work/sig.bak"
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=smoke "$tauri" signer sign -f "$work/other" "$work/base/v0.0.1/SHA256SUMS" >/dev/null 2>&1
run sh "$work/install.sh" >/dev/null 2>&1 && fail "signature by a foreign key was accepted"
cp "$work/sig.bak" "$work/base/v0.0.1/SHA256SUMS.sig"
ok "refuses a signature by another key"

base64 -d < "$work/sig.bak" | sed '3s/timestamp:/timestamp:9/' | base64 -w0 > "$work/base/v0.0.1/SHA256SUMS.sig"
run sh "$work/install.sh" >/dev/null 2>&1 && fail "tampered trusted comment was accepted"
cp "$work/sig.bak" "$work/base/v0.0.1/SHA256SUMS.sig"
ok "refuses a signature whose trusted comment was changed"

tb="$work/base/v0.0.1/colony-0.0.1-linux-x86_64.tar.gz"
cp "$tb" "$work/tb.bak"
printf 'x' >> "$tb"
out="$(run sh "$work/install.sh" 2>&1)" && fail "tampered tarball was accepted"
grep -q "sha256 mismatch" <<<"$out" || fail "tampered tarball: wrong error: $out"
cp "$work/tb.bak" "$tb"
ok "refuses a tarball that does not match SHA256SUMS"

env -i HOME="$home" PATH="$path" COLONY_DOWNLOAD_BASE="http://example.invalid" sh "$work/install.sh" >/dev/null 2>&1 && fail "http base accepted"
ok "refuses a base that is not https or file"

release 0.0.2
release 0.0.3
run sh "$work/install.sh" --version 0.0.2 >/dev/null 2>&1 || fail "install 0.0.2"
run sh "$work/install.sh" >/dev/null 2>&1 || fail "install 0.0.3"
[[ "$("$home/.local/bin/colony")" == "colony-stub 0.0.3" ]] || fail "launcher does not run 0.0.3"
kept="$(cd "$home/.local/share/colony/app" && ls -d 0.* | tr '\n' ' ')"
[[ "$kept" == "0.0.2 0.0.3 " ]] || fail "expected 0.0.2 and 0.0.3 kept, got: $kept"
ok "upgrade keeps exactly the previous version"

mkdir -p "$home/.local/share/colony/engine/x"
out="$(run sh "$work/install.sh" --uninstall 2>&1)" || fail "uninstall: $out"
[[ ! -e "$home/.local/bin/colony" && ! -e "$home/.local/share/colony/app" && ! -e "$home/.local/share/applications/colony.desktop" ]] || fail "uninstall left files"
[[ -d "$home/.local/share/colony/engine/x" ]] || fail "uninstall removed the engine"
ok "uninstall removes app, launcher and desktop entry, keeps the engine"

printf '#!/bin/sh\necho mine\n' > "$home/.local/bin/colony"
out="$(run sh "$work/install.sh" 2>&1)" && fail "overwrote a foreign launcher"
[[ "$(cat "$home/.local/bin/colony")" == *mine* ]] || fail "foreign launcher changed"
ok "does not overwrite a launcher it did not write"

snip="$work/snip-home"
mkdir -p "$snip"
out="$(env -i HOME="$snip" PATH="$path" COLONY_DOWNLOAD_BASE="http://example.invalid" sh "$work/install.sh" --omarchy-snippet 2>&1)" || fail "omarchy snippet: $out"
grep -q '^o.bind("SUPER + SHIFT + I", "Colony", { launch = "colony", focus = "^colony\$" })$' <<<"$out" || fail "omarchy snippet: no o.bind line: $out"
[[ -z "$(ls -A "$snip")" ]] || fail "omarchy snippet wrote into HOME: $(ls -A "$snip")"
ok "--omarchy-snippet prints the Omarchy 4 snippet, downloads and writes nothing"

# Updater files: AppImage + its updater signature -> latest.json; package-channel tarball.
printf 'ELF-stub' > "$work/Colony_0.0.9_amd64.AppImage"
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=smoke "$tauri" signer sign -f "$work/key" "$work/Colony_0.0.9_amd64.AppImage" >/dev/null 2>&1
COLONY_RELEASE_BIN="$work/stub" COLONY_PACKAGE_BIN="$work/stub" COLONY_RELEASE_APPIMAGE="$work/Colony_0.0.9_amd64.AppImage" \
  "$repo/packaging/make-release.sh" 0.0.9 "$work/rel9" >/dev/null
node -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1] + "/latest.json", "utf8"));
  const p = m.platforms["linux-x86_64-appimage"];
  const sig = fs.readFileSync(process.argv[1] + "/Colony_0.0.9_amd64.AppImage.sig", "utf8").trim();
  if (m.version !== "0.0.9" || !p || p.signature !== sig || Object.keys(m.platforms).length !== 1
    || p.url !== "https://github.com/agent-kit-startup/colony/releases/download/v0.0.9/Colony_0.0.9_amd64.AppImage"
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(m.pub_date)) { console.error(JSON.stringify(m)); process.exit(1); }
' "$work/rel9" || fail "latest.json"
for f in colony-0.0.9-linux-x86_64-package.tar.gz Colony_0.0.9_amd64.AppImage latest.json; do
  grep -q " $f\$" "$work/rel9/SHA256SUMS" || fail "$f not in SHA256SUMS"
done
ok "make-release writes latest.json (AppImage only), the package tarball, and lists them in SHA256SUMS"

echo "install smoke: $pass checks passed"
