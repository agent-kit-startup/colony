# Assets

Copies from the Colony design system Artifact (https://claude.ai/artifact/QnXZWxZk5ygiMARNhboRXz), taken on 2026-10-19 with the file names that Artifact gives them. The Artifact is the source; refresh these copies from it instead of editing them here.

| Folder | What | Use |
|--------|------|-----|
| `brand/` | `colony-icon.svg` (one 10px stroke in #E6E6E6, no fill) and `colony-icon-1024.png` (the same mark on #05090F). `src-tauri/icons/` is generated from the PNG with `pnpm tauri icon`. | Use as given on `bg-primary`, `art-night` or #05090F, with clear space of a quarter of its size. Do not redraw or recolor it. |
| `art/` | 13 pieces of generated key art, 1920px webp. | Loading screen, empty states, site, README and social. Never behind working views. Text goes on an `art-night` scrim, never on the bare picture. The art direction table in the Artifact says which piece fits where. |

The art was generated for Colony. No third-party artwork belongs in this repository, including the moodboard references kept outside it.
