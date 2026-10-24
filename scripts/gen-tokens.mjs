#!/usr/bin/env node
// Writes src/tokens.css from the kit's Mission Control skin token contract
// (agent-kit docs/contracts/mission-control-skins.json, copied verbatim to
// src/contracts/). `--check` compares instead of writing and exits 1 on a difference.
//
//   node scripts/gen-tokens.mjs [--check] [path/to/mission-control-skins.json]
//
// To follow a new contract version: copy the kit file over src/contracts/, run this
// script, review the diff. Colony keeps its own skin attribute (data-skin, src/skin.ts)
// and a short Colony-local block for values the contract does not name yet.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const check = args.includes("--check");
const contractPath = args.find((a) => !a.startsWith("--")) ?? join(root, "src/contracts/mission-control-skins.json");
const out = join(root, "src/tokens.css");
const c = JSON.parse(readFileSync(contractPath, "utf8"));

const LOCAL = [
  ["mc-selection", "rgba(59, 130, 246, 0.3)", "dashboard ::selection"],
  ["mc-shadow-card-hover", "0 0 0 1px var(--border-active), 0 4px 12px rgba(0, 0, 0, 0.2)", ".card:hover"],
  ["mc-shadow-popover", "0 12px 40px rgba(0, 0, 0, 0.5)", ""],
  ["mc-stepbar-height", "6px", ".now-stepbar-seg"],
  ["mc-step-marker-size", "20px", ".now-step-marker"],
];

const block = (sel, entries) => `${sel} {\n${entries.map(([k, v, note]) => `  --${k}: ${v};${note ? ` /* ${note} */` : ""}`).join("\n")}\n}\n`;
const surface = (skin) => c.surfaceTokens.map((k) => [k, c.skins[skin].tokens[k]]);
const others = Object.keys(c.skins).filter((s) => s !== c.defaultSkin);

const css = [
  `/* Mission Control design tokens, generated from the kit's skin token contract
 * version ${c.version}, ${c.$id}
 * by scripts/gen-tokens.mjs. Do not edit by hand: update
 * src/contracts/mission-control-skins.json and run \`pnpm tokens\`.
 *
 * Names are the dashboard's own; Colony has no second color name set. The default skin
 * (${c.defaultSkin}) is also the :root value; a skin overrides only the ${c.surfaceTokens.length} surface tokens
 * (src/skin.ts sets html[data-skin]). */\n`,
  block(`:root,\nhtml[data-skin="${c.defaultSkin}"]`, surface(c.defaultSkin)),
  ...others.map((s) => block(`html[data-skin="${s}"]`, surface(s))),
  block(":root", Object.entries(c.sharedTokens)),
  `\n/* Colony-local: values the dashboard writes inline in its rules, named here until the
 * contract adopts them. */\n`,
  block(":root", LOCAL),
].join("\n");

if (check) {
  const now = readFileSync(out, "utf8");
  if (now !== css) {
    console.error(`src/tokens.css is not the generated output of ${contractPath} (run pnpm tokens)`);
    process.exit(1);
  }
  console.log(`src/tokens.css matches contract ${c.version}`);
} else {
  writeFileSync(out, css);
  console.log(`wrote src/tokens.css from contract ${c.version}`);
}
