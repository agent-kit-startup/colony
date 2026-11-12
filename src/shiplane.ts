// Ship lane tile of the Git e CI/CD view (ADR 2026-10-23 git-cicd-tab-read-in-mc-act-in-colony,
// kit agent-kit-dev .cursor/memory/decisions/). Read side: the snapshot's `shipLane` field
// (Mission Control data 1.8.0, Agent Kit 6.9.0 and later), the same rows the kit web page's
// Ship lane card shows. Act side: a row gets a Colony button only when its action is one of
// the host allowlist kinds (src-tauri/src/hostreq.rs KINDS), and the button only opens an
// approval card under Requests; nothing runs before Approve, and a merge into a production
// base needs the typed yes there (re-derived from the forge in Rust, never from this file).
// /git-prod and /kit-prod stay copy-only. Every snapshot string is forge or repo text:
// rendered as text nodes through h(), never as markup. The open PR list itself is the Pull
// requests tile (src/forge.ts, live gh): one list, one action per PR (src/prlist.ts).
// The tile is one status line (src/shipline.ts, plan colony-git-tab-forge-ux r5): it opens
// to the rows while a row is pending or red, or on click.
import { h } from "./api";
import { isPromote, isStagingSync, mergeBlock, prMethod } from "./prgate";
import "./shiplane.css";
import { mainInStaging, shipLine, stagingAhead } from "./shipline";
import { snapshot, type J } from "./snapshot";
import { btn, emptyCta } from "./ui";

/** First Mission Control data version that carries `shipLane`. */
export const SHIP_LANE_DATA_VERSION = "1.8.0";

export type ShipAction =
  | { kind: "merge-pr"; args: { number: number; method: "squash" | "merge" } }
  | { kind: "rerun-checks"; args: { run: number } }
  | { kind: "open-pr"; args: { shape: "promote" | "staging-sync" } };

export interface ShipHost {
  /** Open an approval card for `a` (Requests); resolves when the card exists. */
  request(a: ShipAction, what: string): void;
  copy(text: string, what: string): void;
  openEngine(): void;
}

const o = (v: unknown): J => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : {});
const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const posInt = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);
const STATES: Record<string, [string, string]> = { green: ["Done", "green"], red: ["Blocked", "red"], pending: ["Pending", "yellow"], unknown: ["Unknown", "gray"] };

/** "1.8.0" >= "1.7.3"? Non-numeric parts count as 0. */
export function dataAtLeast(have: unknown, want: string): boolean {
  if (typeof have !== "string") return false;
  const a = have.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const b = want.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/** The engine gate: why the ship lane cannot be shown, or null. */
export function shipLaneGate(data: J | null): string | null {
  if (!data) return "Waiting for Mission Control data…";
  const v = data.dashboardDataVersion;
  if (!dataAtLeast(v, SHIP_LANE_DATA_VERSION) || !data.shipLane || typeof data.shipLane !== "object") {
    return `This engine's Mission Control data is ${typeof v === "string" ? v : "unknown"}; the ship lane needs ${SHIP_LANE_DATA_VERSION} (Agent Kit 6.9.0 or later). Update the engine (Settings → Engine…) to see and act on it.`;
  }
  return null;
}

/**
 * The Colony action a ship lane row offers, from the snapshot's structured fields only. A row
 * whose PR is open offers its Merge (or nothing while that PR cannot be merged), never the
 * button that would open a second one.
 */
export function rowAction(row: J, lane: J): { label: string; action: ShipAction; tip: string } | null {
  const remote = o(lane.remote);
  const prs: J[] = remote.available === true && Array.isArray(remote.prs) ? remote.prs.map(o) : [];
  const merge = (pr: J, tip: string) => {
    const a = prAction(pr);
    return a ? { label: `Merge #${a.args.number}…`, action: a, tip } : null;
  };
  switch (s(row.id)) {
    case "release-close": {
      const pr = prs.find((p) => /close-release/i.test(s(p.head)) && s(p.base) === "staging");
      return pr ? merge(pr, "Squash-merge the release-close PR into staging (approval card)") : null;
    }
    case "staging-main": {
      const pr = prs.find((p) => isPromote(s(p.head), s(p.base)));
      if (pr) return merge(pr, "Merge staging into the default branch with a merge commit: the card needs your typed yes");
      if (s(row.state) === "pending" && (stagingAhead(lane) ?? 0) > 0) return { label: "Open PR…", action: { kind: "open-pr", args: { shape: "promote" } }, tip: "Open the staging → main pull request (approval card)" };
      return null;
    }
    case "tag-ci": {
      const run = posInt(o(remote.tagCi).runId);
      return s(row.state) === "red" && run ? { label: "Rerun failed…", action: { kind: "rerun-checks", args: { run } }, tip: `Rerun the failed jobs of run ${run} (approval card)` } : null;
    }
    case "staging-sync": {
      // The forge's compare (data 1.11.0) when there is one, else the local refs.
      if (mainInStaging(lane) !== false) return null;
      const pr = prs.find((p) => isStagingSync(s(p.head), s(p.base)));
      if (pr) return merge(pr, "Merge the sync PR into staging with a merge commit, so main is an ancestor of staging again (approval card)");
      return { label: "Open sync PR…", action: { kind: "open-pr", args: { shape: "staging-sync" } }, tip: "Push origin/main to a new chore/ branch and open its PR into staging (approval card)" };
    }
    default:
      return null;
  }
}

/** The merge a snapshot PR offers (src/prgate.ts method and gate), or null when it cannot merge now. */
export function prAction(pr: J): Extract<ShipAction, { kind: "merge-pr" }> | null {
  const n = posInt(pr.number);
  if (!n) return null;
  const head = s(pr.head);
  const base = s(pr.base);
  if (mergeBlock({ head, base, draft: pr.draft === true, mergeable: s(pr.mergeable), pendingChecks: posInt(o(pr.checks).pending) ?? 0 })) return null;
  return { kind: "merge-pr", args: { number: n, method: prMethod(head, base) } };
}

export class ShipLaneTile {
  readonly el = h("section", { class: "card bento-tile bento-ship ship-tile" });
  private body = h("div", { class: "ship-body" });
  /** The operator's click: null follows the rows (open while one is pending or red). */
  private userOpen: boolean | null = null;

  constructor(private host: ShipHost) {
    this.el.append(h("div", { class: "card-header" }, h("span", { class: "card-title" }, "Ship lane")), this.body);
  }

  render() {
    const data = snapshot.data;
    const gate = shipLaneGate(data);
    this.el.dataset.gate = gate ? "engine" : "";
    if (gate) {
      this.body.replaceChildren(
        data
          ? emptyCta({ icon: "devops", headline: "Update the engine to see the ship lane", support: gate, compact: true, actions: [{ label: "Engine…", onClick: () => this.host.openEngine(), act: "engine" }] })
          : h("div", { class: "empty dim" }, gate),
      );
      return;
    }
    const lane = o(data?.shipLane);
    const rows: J[] = Array.isArray(lane.rows) ? lane.rows.map(o) : [];
    const line = shipLine(lane);
    const open = this.userOpen ?? line.open;
    const toggle = btn(open ? "Hide rows" : "Show rows", () => {
      this.userOpen = !open;
      this.render();
    }, { class: "link", "data-act": "ship-toggle", "aria-expanded": String(open) });
    const kids: Node[] = [h("div", { class: `ship-line is-${line.tone}` }, h("span", { class: "ship-line-text grow", title: line.text }, line.text), toggle)];
    if (open) {
      if (lane.note) kids.push(h("div", { class: "hint" }, s(lane.note)));
      kids.push(rows.length ? h("ol", { class: "ship-rows", "aria-label": "Ship lane rows" }, ...rows.map((r) => this.row(r, lane))) : h("div", { class: "empty dim" }, "No ship lane rows for this repository."));
      kids.push(h("div", { class: "hint" }, "Buttons open an approval card; nothing runs before Approve. A merge into main needs your typed yes there. /git-prod and /kit-prod are copy-only: paste them in your own agent session."));
    }
    this.el.dataset.open = String(open);
    this.body.replaceChildren(...kids);
  }

  private row(r: J, lane: J): HTMLElement {
    const [label, tone] = STATES[s(r.state)] ?? STATES.unknown;
    const next = o(r.next);
    const text = s(next.text);
    const acts: HTMLElement[] = [];
    const act = rowAction(r, lane);
    if (act) acts.push(btn(act.label, () => this.host.request(act.action, act.label), { class: "primary", "data-act": `ship-${act.action.kind}`, title: act.tip }));
    if (text) acts.push(btn("Copy", () => this.host.copy(text, text), { "data-act": "ship-copy", title: `Copy for the ${s(next.destination) || "terminal"}` }));
    const el = h(
      "li",
      { class: `ship-row is-${tone}` },
      h("span", { class: "ship-row-label" }, s(r.label) || s(r.id)),
      h("span", { class: `ship-row-state is-${tone}` }, label),
      h("span", { class: "ship-row-detail" }, s(r.detail)),
      ...(text ? [h("code", { class: "ship-row-cmd" }, text)] : []),
      ...(acts.length ? [h("span", { class: "ship-row-acts" }, ...acts)] : []),
    );
    el.dataset.row = s(r.id);
    return el;
  }
}
