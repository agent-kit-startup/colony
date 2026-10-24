// Omarchy shell integration (More → Omarchy integration…, Omarchy only): the bar widget
// and menu entries of src-tauri/src/omarchy_shell.rs, installed or removed only after
// this panel has listed every file and command the step touches (kit ADR 2026-10-23,
// point 4). Also keeps this window's status for the bar widget (open gates, live runs).
import { api, errText, h, type OmarchyPlan } from "./api";
import { pendingGates } from "./gates";
import { launches } from "./launches";
import { runs } from "./runs";
import { omarchyDetected } from "./skin";
import { btn } from "./ui";

let overlay: HTMLElement | null = null;

function stateText(s: string): string {
  if (s === "installed") return "installed";
  if (s === "absent") return "not installed";
  return s.replace(/^conflict: /, "blocked: ");
}

function stepList(p: OmarchyPlan): HTMLElement {
  const verb: Record<string, string> = { write: "Write", remove: "Remove", run: "Run" };
  return h("ol", { class: "omarchy-steps" }, ...p.steps.map((s) => h("li", {}, h("span", { class: "dim" }, `${verb[s.kind] ?? s.kind} `), h("code", {}, s.target))));
}

export async function openOmarchyPanel(status: (message: string) => void) {
  overlay?.remove();
  const box = h("div", { class: "engine-box" });
  overlay = h("div", { id: "omarchy-panel" }, box);
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

  const render = async (note?: { text: string; bad: boolean }) => {
    let install: OmarchyPlan;
    let remove: OmarchyPlan;
    try {
      [install, remove] = await Promise.all([api.omarchyIntegrationPlan("install"), api.omarchyIntegrationPlan("remove")]);
    } catch (e) {
      box.replaceChildren(h("div", { class: "bad" }, errText(e)));
      return;
    }
    const msg = h("div", { class: `engine-msg ${note?.bad ? "bad" : "dim"}` }, note?.text ?? "");
    let busy = false;
    const act = async (plan: OmarchyPlan, label: string) => {
      if (busy) return;
      busy = true;
      msg.textContent = `${label}…`;
      try {
        const report = await api.omarchyIntegrationApply(plan.action);
        const failed = report.filter((l) => l.startsWith("failed"));
        const text = failed.length ? `${label}: ${failed.length} step(s) failed. ${failed.join(" · ")}` : `${label}: done (${report.length} steps).`;
        status(text);
        await render({ text: report.join("\n"), bad: failed.length > 0 });
      } catch (e) {
        msg.textContent = errText(e);
        msg.classList.add("bad");
      } finally {
        busy = false;
      }
    };
    const installed = install.widget === "installed" || install.menu === "installed";
    const actions = h("div", { class: "engine-actions" });
    if (!install.blocked) actions.append(btn(installed ? "Update" : "Install", () => void act(install, installed ? "Update" : "Install")));
    if (!remove.blocked) actions.append(btn("Remove", () => void act(remove, "Remove")));
    box.replaceChildren(
      h("div", { class: "card-title" }, "Omarchy integration", h("span", { class: "spacer" }), btn("✕", close, { class: "icon", title: "Close" })),
      h("p", { class: "hint" }, "A Colony bar widget (open gates and live runs; a click opens the Inbox or focuses Colony) and menu entries (Open Colony, Colony Inbox, Open folder in Colony). Nothing is written until you press a button below; Remove deletes only what Colony wrote."),
      h("div", { class: "engine-row" }, h("span", { class: "dim" }, "Bar widget"), h("span", {}, stateText(install.widget))),
      h("div", { class: "engine-row" }, h("span", { class: "dim" }, "Menu entries"), h("span", {}, stateText(install.menu))),
      ...(install.blocked ? [h("div", { class: "hint" }, install.blocked)] : [h("div", { class: "hint" }, `${installed ? "Update" : "Install"} will:`), stepList(install)]),
      ...(remove.blocked ? [] : [h("div", { class: "hint" }, "Remove will:"), stepList(remove)]),
      actions,
      msg,
    );
    (actions.querySelector("button") as HTMLButtonElement | null)?.focus();
  };
  await render();
}

/** Keep this window's status file current for the bar widget (Omarchy only). */
export function publishShellStatus(folder: () => string | null) {
  let timer = 0;
  let last = "";
  const push = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (!omarchyDetected()) return;
      const gates = pendingGates().length;
      const live = launches.list().filter((l) => l.state !== "ended").length;
      const key = `${folder()}|${gates}|${live}`;
      if (key === last) return;
      last = key;
      api.shellStatusSet(folder(), gates, live).catch(() => {});
    }, 400);
  };
  runs.on(push);
  launches.on(push);
  return push;
}
