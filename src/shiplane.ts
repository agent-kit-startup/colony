// Ship lane tile of the Git e CI/CD view (ADR 2026-10-23 git-cicd-tab-read-in-mc-act-in-colony,
// kit agent-kit-dev .cursor/memory/decisions/). Read side: the snapshot's `shipLane` field
// (Mission Control data 1.8.0, Agent Kit 6.9.0 and later), the same rows the kit web page's
// Ship lane card shows. Act side: a row gets a Colony button only when its action is one of
// the host allowlist kinds (src-tauri/src/hostreq.rs KINDS), and the button only opens an
// approval card under Requests; nothing runs before Approve, and a merge into a production
// base needs the typed yes there (re-derived from the forge in Rust, never from this file).
// /git-prod and /kit-prod stay copy-only. Every snapshot string is forge or repo text:
// rendered as text nodes through h(), never as markup.
import { h } from "./api";
import "./shiplane.css";
import { snapshot, type J } from "./snapshot";
import { btn, chip, emptyCta } from "./ui";

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
const PROMOTE_BASES = new Set(["main", "master"]);

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
    return `This engine's Mission Control data is ${typeof v === "string" ? v : "unknown"}; the ship lane needs ${SHIP_LANE_DATA_VERSION} (Agent Kit 6.9.0 or later). Update the engine (Run → Engine…) to see and act on it.`;
  }
  return null;
}

/** The Colony action a ship lane row offers, from the snapshot's structured fields only. */
export function rowAction(row: J, lane: J): { label: string; action: ShipAction; tip: string } | null {
  const remote = o(lane.remote);
  const local = o(lane.local);
  const prs: J[] = remote.available === true && Array.isArray(remote.prs) ? remote.prs.map(o) : [];
  switch (s(row.id)) {
    case "release-close": {
      const pr = prs.find((p) => /close-release/i.test(s(p.head)) && s(p.base) === "staging");
      const n = posInt(pr?.number);
      return n ? { label: `Merge #${n}…`, action: { kind: "merge-pr", args: { number: n, method: "squash" } }, tip: "Squash-merge the release-close PR into staging (approval card)" } : null;
    }
    case "staging-main": {
      const pr = prs.find((p) => s(p.head) === "staging" && PROMOTE_BASES.has(s(p.base)));
      const n = posInt(pr?.number);
      if (n) return { label: `Merge #${n}…`, action: { kind: "merge-pr", args: { number: n, method: "merge" } }, tip: "Merge staging into the default branch with a merge commit: the card needs your typed yes" };
      if (s(row.state) === "pending" && (posInt(local.stagingAheadOfMain) ?? 0) > 0) return { label: "Open PR…", action: { kind: "open-pr", args: { shape: "promote" } }, tip: "Open the staging → main pull request (approval card)" };
      return null;
    }
    case "tag-ci": {
      const run = posInt(o(remote.tagCi).runId);
      return s(row.state) === "red" && run ? { label: "Rerun failed…", action: { kind: "rerun-checks", args: { run } }, tip: `Rerun the failed jobs of run ${run} (approval card)` } : null;
    }
    case "staging-sync":
      return local.mainInStaging === false ? { label: "Open sync PR…", action: { kind: "open-pr", args: { shape: "staging-sync" } }, tip: "Push origin/main to a new chore/ branch and open its PR into staging (approval card)" } : null;
    default:
      return null;
  }
}

/** The merge a forge PR row offers: squash into a non-default base, a merge commit for staging → main. */
export function prAction(pr: J): ShipAction | null {
  const n = posInt(pr.number);
  if (!n || pr.draft === true) return null;
  const promote = s(pr.head) === "staging" && PROMOTE_BASES.has(s(pr.base));
  return { kind: "merge-pr", args: { number: n, method: promote ? "merge" : "squash" } };
}

export class ShipLaneTile {
  readonly el = h("section", { class: "card bento-tile bento-ship ship-tile" });
  private body = h("div", { class: "ship-body" });

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
    const remote = o(lane.remote);
    const counts: Record<string, number> = { green: 0, red: 0, pending: 0, unknown: 0 };
    for (const r of rows) if (s(r.state) in counts) counts[s(r.state)]++;
    const summary = [counts.green && `${counts.green} done`, counts.red && `${counts.red} blocked`, counts.pending && `${counts.pending} pending`, counts.unknown && `${counts.unknown} unknown`].filter(Boolean).join(" · ");
    const kids: Node[] = [h("div", { class: "ship-summary dim small" }, `${summary || "no rows"}${remote.fetchedAt ? ` · forge read ${s(remote.fetchedAt).replace("T", " ").slice(0, 16)}` : ""}`)];
    if (lane.note) kids.push(h("div", { class: "hint" }, s(lane.note)));
    kids.push(rows.length ? h("ol", { class: "ship-rows", "aria-label": "Ship lane rows" }, ...rows.map((r) => this.row(r, lane))) : h("div", { class: "empty dim" }, "No ship lane rows for this repository."));
    const prs: J[] = remote.available === true && Array.isArray(remote.prs) ? remote.prs.map(o) : [];
    if (prs.length) {
      kids.push(h("div", { class: "ship-sub" }, "Open pull requests"), h("ul", { class: "ship-prs" }, ...prs.map((p) => this.pr(p))));
    }
    kids.push(h("div", { class: "hint" }, "Buttons open an approval card under Requests; nothing runs before Approve. A merge into main needs your typed yes there. /git-prod and /kit-prod are copy-only: paste them in your own agent session."));
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

  private pr(p: J): HTMLElement {
    const checks = o(p.checks);
    const failing = Array.isArray(checks.failing) ? checks.failing.map(s) : [];
    const red = failing.length > 0 || s(p.mergeable) === "conflicting";
    const meta = [`${s(p.head)} → ${s(p.base)}`, s(p.mergeable) === "conflicting" ? "conflicts" : s(p.mergeState), failing.length ? `failing: ${failing.join(", ")}` : "", posInt(checks.pending) ? `${checks.pending} running` : "", p.draft === true ? "draft" : ""].filter(Boolean).join(" · ");
    const a = prAction(p);
    const n = posInt(p.number) ?? 0;
    const el = h(
      "li",
      { class: `ship-pr${red ? " is-red" : ""}` },
      h("strong", { class: "mono" }, `#${n}`),
      h("span", { class: "grow ellipsis", title: s(p.title) }, s(p.title)),
      h("span", { class: "mono dim small ellipsis", title: meta }, meta),
      ...(a ? [btn("Merge…", () => this.host.request(a, `Merge #${n}`), { "data-act": "ship-merge", title: a.args && "method" in a.args && a.args.method === "merge" ? "Merge commit into the default branch: the card needs your typed yes" : "Squash-merge (approval card)" })] : [chip("draft")]),
    );
    el.dataset.pr = String(n);
    return el;
  }
}
