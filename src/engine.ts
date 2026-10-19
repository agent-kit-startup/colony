// Engine panel (More → Engine…) and status-bar badge: which Agent Kit build Colony runs
// (src-tauri/src/engine.rs), install/update from the kit's GitHub release, roll back, and
// the Node runtime. The PATH fallback is flagged as an unmanaged engine.
import { api, type EngineStatus, errText, h } from "./api";
import { btn } from "./ui";

let overlay: HTMLElement | null = null;

function badgeText(s: EngineStatus): { text: string; cls: string; tip: string } {
  const node = s.node ? `node ${s.nodeVersion} (${s.nodeSource})` : `node: ${s.nodeError ?? "not found"}`;
  const tip = [s.label, s.root ?? "", node, s.note ?? "", s.error ?? "", "Click: More → Engine"].filter(Boolean).join("\n");
  if (s.source === "managed") return { text: `engine ${s.manifest?.version ?? "?"}`, cls: s.node ? "" : "warn", tip };
  if (s.source === "env") return { text: `engine ${s.manifest?.version ?? "?"} (COLONY_ENGINE)`, cls: s.node ? "" : "warn", tip };
  if (s.source === "unmanaged") return { text: "⚠ unmanaged engine", cls: "warn", tip };
  return { text: "⚠ no engine", cls: "bad", tip };
}

/** Fill the status-bar slot; returns the status for callers that need it. */
export async function refreshEngineBadge(el: HTMLElement): Promise<EngineStatus | null> {
  try {
    const s = await api.engineStatus();
    const b = badgeText(s);
    el.textContent = b.text;
    el.title = b.tip;
    el.classList.toggle("warn", b.cls === "warn");
    el.classList.toggle("bad", b.cls === "bad");
    return s;
  } catch (e) {
    el.textContent = "engine: ?";
    el.title = errText(e);
    return null;
  }
}

function row(label: string, value: string | Node): HTMLElement {
  return h("div", { class: "engine-row" }, h("span", { class: "dim" }, label), typeof value === "string" ? h("span", {}, value) : value);
}

export function closeEnginePanel() {
  overlay?.remove();
  overlay = null;
}

/** The Engine panel. `onChanged` runs after an install, update or rollback. */
export async function openEnginePanel(onChanged: (message: string) => void) {
  overlay?.remove();
  const box = h("div", { class: "engine-box" });
  overlay = h("div", { id: "engine-panel" }, box);
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) close();
  });
  document.body.append(overlay);
  const close = () => {
    overlay?.remove();
    overlay = null;
  };
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
      onChanged(text);
      await render();
    } catch (e) {
      msg.textContent = errText(e);
      msg.classList.add("bad");
    } finally {
      busy = false;
    }
  };

  const render = async () => {
    let s: EngineStatus;
    try {
      s = await api.engineStatus();
    } catch (e) {
      box.replaceChildren(h("div", { class: "bad" }, errText(e)));
      return;
    }
    const m = s.manifest;
    const version = h("input", { placeholder: "latest", spellcheck: "false", size: "10", title: "Engine version to install (empty: the latest release)" }) as HTMLInputElement;
    const installed = s.installed.length
      ? h("div", {}, ...s.installed.map((i) => h("div", { class: i.supported ? "" : "dim", title: i.reason ?? "" }, `${i.current ? "● " : "○ "}${i.version}${i.supported ? "" : " (not supported)"}${s.previous === i.version ? " · previous" : ""}`)))
      : h("span", { class: "dim" }, "none");
    const unmanaged = s.source === "unmanaged" || s.source === "none";
    box.replaceChildren(
      h("div", { class: "card-title" }, "Agent Kit engine", h("span", { class: "spacer" }), btn("✕", close, { class: "icon", title: "Close" })),
      row("In use", h("span", { class: unmanaged ? "warn" : "" }, s.label)),
      ...(s.error ? [row("Problem", h("span", { class: "bad" }, s.error))] : []),
      ...(s.note ? [row("Note", h("span", { class: "warn" }, s.note))] : []),
      ...(m ? [row("Contracts", `driver protocol ${m.driverProtocol} · Mission Control data ${m.dashboardDataVersion ?? "?"} · Node ${m.node || "any"}`)] : []),
      row("Supported", s.supported),
      row("Mission Control", s.dashboard ?? "not running"),
      row("Node", s.node ? `${s.nodeVersion} (${s.nodeSource}) ${s.node}` : h("span", { class: "warn" }, s.nodeError ?? "not found")),
      row("Installed", installed),
      ...(s.agentKitOverride ? [row("Agent runs", `COLONY_AGENT_KIT_BIN=${s.agentKitOverride}`)] : []),
      ...(s.dashboardOverride ? [row("Server", `COLONY_DASHBOARD_SERVE=${s.dashboardOverride}`)] : []),
      row("Folder", s.dataDir ? `${s.dataDir}/engine` : "?"),
      h(
        "div",
        { class: "engine-actions" },
        version,
        btn(s.installed.length ? "Update engine" : "Install engine", () =>
          void act(`Downloading the engine from ${s.releaseRepo}`, async () => {
            const r = await api.engineInstall(version.value.trim());
            return `Engine ${r.version} installed (sha256 ${r.sha256.slice(0, 12)}…; ${r.signature}). New agent runs use it; reopen the folder to restart Mission Control on it.`;
          }),
        ),
        btn("Roll back", () =>
          void act("Rolling back", async () => `Engine ${await api.engineRollback()} is current again. Reopen the folder to restart Mission Control on it.`),
          s.previous ? {} : { disabled: "true", title: "No previous engine" },
        ),
        btn("Install Node runtime", () => void act(`Downloading Node ${s.nodePin} from nodejs.org`, () => api.engineInstallNode()), {
          title: `Pinned official Node ${s.nodePin} build, checked against SHASUMS256.txt, into ${s.dataDir ?? "?"}/runtime`,
        }),
      ),
      msg,
      h("div", { class: "hint dim" }, s.source === "env" ? "COLONY_ENGINE is set: it wins over the managed engine until you unset it." : "COLONY_ENGINE=<kit checkout> runs a working tree instead (development)."),
    );
  };
  window.addEventListener(
    "keydown",
    function esc(ev) {
      if (ev.key !== "Escape" || !overlay) return;
      window.removeEventListener("keydown", esc);
      close();
    },
  );
  box.append(h("div", { class: "dim" }, "Reading the engine…"));
  await render();
}
