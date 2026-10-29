// Workspace: the kit's workspace items under one rail item (ADR 2026-10-24 amend 2026-10-28).
// Its sections switch with an inner navigation at the head of the view, never in the tab
// strip. Each section is its own pinned view (src/main.ts WORKSPACE_SECTIONS), so Back /
// Forward, `view:<section>` and the palette reach it like any other view.
import { h } from "./api";
import { icon, type IconKind } from "./icons";

export interface WorkspaceSection { id: string; label: string; icon: IconKind; tip: string }

export const SECTION_INFO: Record<string, WorkspaceSection> = {
  memory: { id: "memory", label: "Memory", icon: "field-report", tip: "Memory: the kit's error and decision records" },
  health: { id: "health", label: "Health", icon: "health", tip: "Health: the kit's health checks" },
  decisions: { id: "decisions", label: "Decisions", icon: "review", tip: "Decisions: the ADRs of this folder, by Status and date" },
  agents: { id: "agents", label: "Agents", icon: "agents", tip: "Agents: the agent definitions of this folder" },
  skills: { id: "skills", label: "Skills", icon: "checklist", tip: "Skills: the skills of this folder" },
  rules: { id: "rules", label: "Rules", icon: "shield", tip: "Rules: the rules of this folder" },
  commands: { id: "commands", label: "Commands", icon: "commands", tip: "Commands: the slash commands of this folder" },
  config: { id: "config", label: "Config", icon: "config", tip: "Config: Colony's settings (skin, title bar, rail, Omarchy integration)" },
  plans: { id: "plans", label: "Plans", icon: "plans", tip: "Plans: the active plan, the backlog and the parked plans" },
};

export function sectionInfo(id: string): WorkspaceSection {
  return SECTION_INFO[id] ?? { id, label: id, icon: "overview", tip: id };
}

/**
 * One section's view: the inner navigation over `order`, this section marked (only its 1px
 * border colour changes), then `body`. `open` shows another section.
 */
export function workspaceSection(id: string, order: string[], body: HTMLElement, open: (id: string) => void): HTMLElement {
  const nav = h(
    "nav",
    { class: "ws-nav", role: "tablist", "aria-label": "Workspace" },
    ...order.map((s) => {
      const info = sectionInfo(s);
      const b = h("button", { class: `ws-nav-btn${s === id ? " active" : ""}`, role: "tab", "aria-selected": String(s === id), title: info.tip }, icon(info.icon, "tab-svg"), info.label);
      b.dataset.section = s;
      b.addEventListener("click", () => open(s));
      return b;
    }),
  );
  return h("div", { class: "ws-view" }, nav, h("div", { class: "ws-body" }, body));
}
