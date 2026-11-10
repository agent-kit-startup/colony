import { defineConfig } from "vite";
import { oligarchyCatalog } from "./scripts/oligarchy-catalog.mjs";

// Tauri expects a fixed dev port and a relative base for the custom protocol.
export default defineConfig({
  base: "./",
  clearScreen: false,
  // The game's catalog: the engine's placeholder unless a release build names the content file.
  plugins: [oligarchyCatalog()],
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 6000 },
  worker: { format: "es" },
});
