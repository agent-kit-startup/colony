// The catalog a build of Colony plays (kit ADR 2026-11-06 game-content-canon-one-way-flow,
// amend 2026-11-07 point 8). The engine (@dadado/oligarchy-engine, Apache-2.0) holds the rules
// and a generic placeholder catalog; the game's own catalog is all rights reserved and never
// enters this repository. A build from these sources plays the placeholder. A release build
// plays the game's catalog when COLONY_GAME_CATALOG names a JSON file
// `{ "structures": [...], "threats": [...], "twoHex": [...] }` (.github/workflows/release.yml
// fetches it from the private content repository). Data only: nothing from that file runs.
// `node scripts/oligarchy-catalog.mjs` runs the same check on that file before the build.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { validateRulesCatalog } from "@dadado/oligarchy-engine";

export const CATALOG_MODULE = "virtual:oligarchy-catalog";
export const CATALOG_ENV = "COLONY_GAME_CATALOG";

/** The catalog file this build reads, or null for the placeholder. */
export function catalogPath(env = process.env) {
  const path = (env[CATALOG_ENV] ?? "").trim();
  return path || null;
}

/**
 * Check a parsed catalog file. Returns the problems (none = usable). A release must not ship a
 * catalog the engine would refuse at start, so the build fails on any of them.
 */
export function catalogProblems(catalog) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) return ["the catalog file must hold one JSON object"];
  const problems = [];
  if (!Array.isArray(catalog.twoHex) || catalog.twoHex.some((id) => typeof id !== "string")) problems.push("twoHex must be an array of structure ids");
  return [...problems, ...validateRulesCatalog(catalog)];
}

/** Read and check the catalog file at `path`. Returns its data; throws on a bad file. */
export function readCatalog(path, read = (p) => readFileSync(p, "utf8")) {
  let catalog;
  try {
    catalog = JSON.parse(read(path));
  } catch (e) {
    throw new Error(`${CATALOG_ENV}=${path}: cannot read the catalog (${e instanceof Error ? e.message : e})`);
  }
  const problems = catalogProblems(catalog);
  if (problems.length) throw new Error(`${CATALOG_ENV}=${path}: invalid catalog:\n- ${problems.join("\n- ")}`);
  return { structures: catalog.structures, threats: catalog.threats, twoHex: catalog.twoHex };
}

/** The source of the catalog module: the placeholder, or the checked catalog file. Throws on a bad file. */
export function catalogModuleSource(env = process.env, read = (p) => readFileSync(p, "utf8")) {
  const path = catalogPath(env);
  if (!path) return 'export { placeholderCatalog as default } from "@dadado/oligarchy-engine/placeholder";\nexport const source = "placeholder";\n';
  return `export default ${JSON.stringify(readCatalog(path, read))};\nexport const source = "content";\n`;
}

/**
 * The release check (release.yml, before the build): exit 0 when COLONY_GAME_CATALOG names a
 * catalog the engine accepts, 1 otherwise, an unset variable included.
 */
export function checkCatalogCli(env = process.env, log = console.log, fail = console.error) {
  const path = catalogPath(env);
  if (!path) {
    fail(`::error::${CATALOG_ENV} is not set: no catalog file to check`);
    return 1;
  }
  try {
    const { structures, threats, twoHex } = readCatalog(path);
    log(`${CATALOG_ENV}=${path}: ${structures.length} structures, ${threats.length} threats, twoHex ${twoHex.join(", ") || "none"}`);
    return 0;
  } catch (e) {
    fail(`::error::${e instanceof Error ? e.message.replaceAll("\n", " ") : e}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(checkCatalogCli());

/** Vite plugin: serves `virtual:oligarchy-catalog`. */
export function oligarchyCatalog() {
  const resolved = `\0${CATALOG_MODULE}`;
  return {
    name: "oligarchy-catalog",
    resolveId(id) {
      return id === CATALOG_MODULE ? resolved : null;
    },
    load(id) {
      if (id !== resolved) return null;
      const path = catalogPath();
      if (path) this.addWatchFile(path);
      return catalogModuleSource();
    },
  };
}
