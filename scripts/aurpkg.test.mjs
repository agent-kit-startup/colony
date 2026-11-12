// The AUR package folder (packaging/aur/missionkit-colony-bin): it must not share a file
// with the AUR package colony-bin (Project-Colony's launcher, which owns /usr/bin/colony,
// colony.desktop and the hicolor colony.png), its desktop entries must start the renamed
// binary, and PKGBUILD, .SRCINFO and the local source files must agree.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dir = new URL("../packaging/aur/missionkit-colony-bin/", import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), "utf8");
const pkgbuild = read("PKGBUILD");
const srcinfo = read(".SRCINFO");

/** `key=value` of a PKGBUILD scalar. */
const scalar = (key) => pkgbuild.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1].replace(/^['"]|['"]$/g, "");
/** The quoted items of a PKGBUILD array. */
const array = (key) => {
  const body = pkgbuild.match(new RegExp(`^${key}=\\(([^)]*)\\)`, "m"))?.[1] ?? "";
  return [...body.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
};
/** Every value of a .SRCINFO key. */
const info = (key) => [...srcinfo.matchAll(new RegExp(`^\\s*${key} = (.+)$`, "gm"))].map((m) => m[1]);
/** `Key=value` lines of a desktop entry. */
const entry = (name) => Object.fromEntries(read(name).split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

test("the package is missionkit-colony-bin and claims nothing of colony-bin", () => {
  assert.equal(scalar("pkgname"), "missionkit-colony-bin");
  assert.deepEqual(array("provides"), ["missionkit-colony"]);
  assert.deepEqual(array("conflicts"), ["missionkit-colony"]);
  assert.ok(!/^replaces=/m.test(pkgbuild));
});

test("every installed file is named colony-hde or sits in the package's license folder", () => {
  const targets = [...pkgbuild.matchAll(/"\$\{pkgdir\}([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(targets, [
    "/usr/bin/colony-hde",
    "/usr/share/icons/hicolor/256x256/apps/colony-hde.png",
    "/usr/share/applications/colony-hde.desktop",
    "/usr/share/applications/colony-hde-handler.desktop",
    "/usr/share/licenses/${pkgname}/NOTICE",
    "/usr/share/licenses/${pkgname}/seti-ui.MIT.txt",
  ]);
  for (const taken of ["/usr/bin/colony", "/usr/share/applications/colony.desktop", "/usr/share/icons/hicolor/256x256/apps/colony.png"]) {
    assert.ok(!targets.includes(taken), `${taken} belongs to colony-bin`);
  }
});

test("the desktop entries start the renamed binary", () => {
  const app = entry("colony-hde.desktop");
  assert.equal(app.Exec, "colony-hde %f");
  assert.equal(app.Icon, "colony-hde");
  assert.equal(app.StartupWMClass, "colony-hde");
  assert.equal(app.MimeType, undefined);
  const link = entry("colony-hde-handler.desktop");
  assert.equal(link.Exec, "colony-hde %u");
  assert.equal(link.Icon, "colony-hde");
  assert.equal(link.MimeType, "x-scheme-handler/colony;");
  assert.equal(link.NoDisplay, "true");
});

test("the source is the release's package-channel tarball and the local files match their sums", () => {
  const sources = array("source");
  assert.equal(sources.length, 5);
  assert.equal(sources[0], "${_tarball}::${url}/releases/download/v${pkgver}/${_tarball}");
  assert.equal(scalar("_tarball"), "colony-${pkgver}-linux-x86_64-package.tar.gz");
  const sums = array("sha256sums");
  assert.equal(sums.length, sources.length);
  for (const s of sums) assert.match(s, /^[0-9a-f]{64}$/);
  for (const [i, name] of sources.entries()) {
    if (name.includes("::")) continue;
    assert.equal(createHash("sha256").update(readFileSync(new URL(name, dir))).digest("hex"), sums[i], `${name}: run updpkgsums`);
  }
});

test(".SRCINFO was generated from this PKGBUILD", () => {
  const ver = scalar("pkgver");
  assert.deepEqual(info("pkgname"), ["missionkit-colony-bin"]);
  assert.deepEqual(info("pkgver"), [ver]);
  assert.deepEqual(info("pkgrel"), [scalar("pkgrel")]);
  assert.deepEqual(info("sha256sums"), array("sha256sums"));
  assert.deepEqual(info("depends"), array("depends"));
  assert.deepEqual(info("provides"), array("provides"));
  assert.deepEqual(info("conflicts"), array("conflicts"));
  assert.equal(info("source")[0], `colony-${ver}-linux-x86_64-package.tar.gz::https://github.com/agent-kit-startup/colony/releases/download/v${ver}/colony-${ver}-linux-x86_64-package.tar.gz`);
  assert.deepEqual(info("source").slice(3), ["colony-hde.desktop", "colony-hde-handler.desktop"]);
});
