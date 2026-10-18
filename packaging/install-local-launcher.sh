#!/usr/bin/env bash
# Install a per-user launcher for a local Colony build (no sudo):
#   ~/.local/bin/colony                          wrapper around the release binary
#   ~/.local/share/applications/colony.desktop   app launcher entry (walker / rofi / GNOME)
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin="$repo/src-tauri/target/release/colony"
icon="$repo/src-tauri/icons/128x128@2x.png"
[[ -x "$bin" ]] || { echo "Build first: pnpm tauri build (missing $bin)" >&2; exit 1; }
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
cat > "$HOME/.local/bin/colony" <<WRAP
#!/usr/bin/env bash
exec "$bin" "\$@"
WRAP
chmod +x "$HOME/.local/bin/colony"
cat > "$HOME/.local/share/applications/colony.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=Colony
GenericName=Mission Kit IDE
Comment=Mission Kit Colony desktop IDE
Exec=$bin %f
Icon=$icon
Terminal=false
Categories=Development;IDE;
StartupWMClass=colony
DESK
command -v update-desktop-database >/dev/null && update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
echo "Installed: $HOME/.local/bin/colony and $HOME/.local/share/applications/colony.desktop"
