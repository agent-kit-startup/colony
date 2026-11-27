// About panel (Help → About Colony…): the version (and the license line). The distribution
// channel and the app update actions live in Settings → App updates (src/appupdates.ts; kit
// ADR 2026-10-24 amend 2026-11-19 points 6 and 7).
import { api, errText, h } from "./api";
import { btn } from "./ui";

let overlay: HTMLElement | null = null;

function row(label: string, value: string): HTMLElement {
  return h("div", { class: "engine-row" }, h("span", { class: "dim" }, label), h("span", {}, value));
}

export async function openAboutPanel() {
  overlay?.remove();
  const box = h("div", { class: "engine-box" });
  overlay = h("div", { id: "about-panel" }, box);
  const close = () => {
    overlay?.remove();
    overlay = null;
    window.removeEventListener("keydown", esc);
  };
  const esc = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") close();
  };
  window.addEventListener("keydown", esc);
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) close();
  });
  document.body.append(overlay);
  const title = h("div", { class: "card-title" }, "Colony", h("span", { class: "spacer" }), btn("✕", close, { class: "icon", title: "Close" }));
  try {
    const s = await api.appUpdateStatus();
    box.replaceChildren(title, row("Version", s.version), row("License", "Apache-2.0 · github.com/agent-kit-startup/colony"));
  } catch (e) {
    box.replaceChildren(title, h("div", { class: "bad" }, errText(e)));
  }
}
