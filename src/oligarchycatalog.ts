// The rules bound to the catalog this build plays: the engine's placeholder in a build from these
// sources, the game's own catalog in a release build (scripts/oligarchy-catalog.mjs).
import { createRules } from "@dadado/oligarchy-engine";
import catalog, { source } from "virtual:oligarchy-catalog";

export const rules = createRules(catalog);
export const catalogSource = source;
