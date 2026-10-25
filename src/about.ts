// About panel (Help → About Colony…): version, distribution channel and app updates
// (src-tauri/src/appupdate.rs). Direct builds check the latest GitHub Release and install
// the signed AppImage in place; package builds say updates come from the package manager.
import { api, type AppUpdateStatus, errText, h } from "./api";
import { btn } from "./ui";

let overlay: HTMLElement | null = null;

function row(label: string, value: string | Node): HTMLElement {
  return h("div", { class: "engine-row" }, h("span", { class: "dim" }, label), typeof value === "string" ? h("span", {}, value) : value);
}

export async function openAboutPanel(status: (message: string) => void) {
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

  let s: AppUpdateStatus;
  try {
    s = await api.appUpdateStatus();
  } catch (e) {
    box.replaceChildren(h("div", { class: "bad" }, errText(e)));
    return;
  }
  const msg = h("div", { class: "engine-msg dim" });
  let busy = false;
  const act = async (label: string, run: () => Promise<string>) => {
    if (busy) return;
    busy = true;
    msg.textContent = `${label}…`;
    msg.classList.remove("bad");
    try {
      const text = await run();
      msg.textContent = text;
      status(text);
    } catch (e) {
      msg.textContent = errText(e);
      msg.classList.add("bad");
    } finally {
      busy = false;
    }
  };
  const actions = h("div", { class: "engine-actions" });
  if (s.canCheck) {
    actions.append(
      btn("Check for updates", () =>
        void act("Checking the latest GitHub Release", async () => {
          const u = await api.appUpdateCheck();
          if (!u.available) return `Colony ${u.current} is up to date.`;
          return `Colony ${u.available} is available (this is ${u.current}).${s.canInstall ? " Install it with Update and restart." : ` ${s.note}`}`;
        }),
      ),
    );
  }
  if (s.canInstall) {
    actions.append(btn("Update and restart", () => void act("Downloading and verifying the update", () => api.appUpdateInstall())));
  }
  box.replaceChildren(
    h("div", { class: "card-title" }, "Colony", h("span", { class: "spacer" }), btn("✕", close, { class: "icon", title: "Close" })),
    row("Version", s.version),
    row("Channel", s.channel === "direct" ? "direct (GitHub Releases)" : "package (distro package)"),
    row("Installed as", s.install),
    row("Updates", s.note),
    row("License", "Apache-2.0 · github.com/agent-kit-startup/colony"),
    ...(actions.childElementCount ? [actions] : []),
    msg,
  );
}
