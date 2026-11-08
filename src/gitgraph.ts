// Commit graph in the native Git view (plan colony-explorer-git-workbench x6): an SVG lane
// graph of local branches, remote-tracking branches, tags and HEAD, loaded a page at a time as
// the list scrolls, with a commit's message, author, changed files and per-file diff on click.
// Read-only (git-cicd ADR amend 2026-11-07): no rebase, cherry-pick, reset or checkout here.
// Commit text is untrusted: every string goes in as a text node, never as HTML.
import { api, errText, h, type CommitDetail, type GraphCommit, type GraphPage, type GraphRef } from "./api";
import { type GraphRow, layoutGraph, shortHash } from "./graphlayout";
import { ago } from "./ui";

const PAGE = 150;
/** Row height and lane pitch in px; `.gg-row` in src/styles.css uses the same row height. */
const ROW_H = 24;
const LANE_W = 14;
const SVG_NS = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** Diff text as one line element per line, coloured by its leading character (textContent only). */
export function diffLines(text: string): HTMLElement[] {
  return text.split("\n").map((line) => {
    const cls = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : "";
    return h("div", { class: cls }, line);
  });
}

const x = (lane: number) => lane * LANE_W + LANE_W / 2;

/** One row's graph cell: the lines crossing it and the commit dot. */
function rowSvg(row: GraphRow, lanes: number, isHead: boolean): SVGSVGElement {
  const w = Math.max(1, lanes) * LANE_W;
  const mid = ROW_H / 2;
  const s = svg("svg", { class: "gg-svg", width: w, height: ROW_H, viewBox: `0 0 ${w} ${ROW_H}`, "aria-hidden": "true" });
  for (const seg of row.segs) {
    const a = x(seg.from);
    const b = x(seg.to);
    const d =
      seg.part === "pass"
        ? `M${a} 0V${ROW_H}`
        : seg.part === "top"
          ? a === b
            ? `M${a} 0V${mid}`
            : `M${a} 0C${a} ${mid * 0.6} ${b} ${mid * 0.4} ${b} ${mid}`
          : a === b
            ? `M${a} ${mid}V${ROW_H}`
            : `M${a} ${mid}C${a} ${mid + mid * 0.6} ${b} ${mid + mid * 0.4} ${b} ${ROW_H}`;
    s.append(svg("path", { d, class: `gg-line gg-c${seg.colour}` }));
  }
  const cx = x(row.lane);
  if (isHead) s.append(svg("circle", { cx, cy: mid, r: 6, class: "gg-head-ring" }));
  s.append(svg("circle", { cx, cy: mid, r: row.merge ? 3 : 4, class: `gg-dot gg-c${row.colour}` }));
  return s;
}

function refLabel(r: GraphRef, upstream: string | null): HTMLElement {
  const isUp = r.kind === "remote" && r.name === upstream;
  const cls = `gg-ref gg-ref-${r.kind}${r.head ? " is-head" : ""}${isUp ? " is-upstream" : ""}`;
  const title = r.head ? `HEAD: ${r.name} (checked out)` : isUp ? `${r.name}: upstream of the current branch` : r.kind === "tag" ? `tag ${r.name}` : r.kind === "remote" ? `remote-tracking ${r.name}` : r.name;
  return h("span", { class: cls, title }, r.head ? `HEAD → ${r.name}` : r.name);
}

export class CommitGraph {
  readonly el: HTMLElement;
  private head = h("div", { class: "gg-head mono small" });
  private list = h("div", { class: "gg-list", role: "list", "aria-label": "Commit graph" });
  private moreBtn = h("button", { class: "gg-more", hidden: "" }, "Load more commits");
  private note = h("div", { class: "dim small", hidden: "" });
  private detail = h("div", { class: "gg-detail", hidden: "" });
  private commits: GraphCommit[] = [];
  private page: GraphPage | null = null;
  private shownKey = "";
  private selected = "";
  private loading = false;
  private stale = true;
  private visible = false;
  private seq = 0;

  constructor() {
    this.el = h("div", { class: "gg" }, this.head, this.list, this.moreBtn, this.note, this.detail);
    this.moreBtn.addEventListener("click", () => void this.loadMore());
    this.list.addEventListener("scroll", () => {
      const l = this.list;
      if (l.scrollTop + l.clientHeight > l.scrollHeight - ROW_H * 8) void this.loadMore();
    });
    this.list.addEventListener("keydown", (e) => this.key(e));
  }

  /** Branch line before the graph arrives, from the snapshot (synchronous). */
  setBranch(branch: string) {
    if (!this.page) this.head.textContent = branch ? `HEAD → ${branch}` : "";
  }

  show() {
    this.visible = true;
    if (this.stale) void this.reload();
  }

  hide() {
    this.visible = false;
  }

  /** The repository moved (commit, checkout, fetch): reload the first page when shown. */
  invalidate() {
    this.stale = true;
    if (this.visible) void this.reload();
  }

  private async reload() {
    this.stale = false;
    const seq = ++this.seq;
    try {
      const p = await api.gitGraph(0, Math.max(PAGE, Math.min(this.commits.length, 500)));
      if (seq !== this.seq) return;
      this.apply(p, p.commits);
    } catch (e) {
      if (seq !== this.seq) return;
      this.note.hidden = false;
      this.note.textContent = `Could not read the commit graph: ${errText(e)}`;
    }
  }

  private async loadMore() {
    if (this.loading || !this.page?.more) return;
    this.loading = true;
    const seq = this.seq;
    this.moreBtn.disabled = true;
    try {
      const p = await api.gitGraph(this.commits.length, PAGE);
      if (seq !== this.seq) return;
      this.apply(p, this.commits.concat(p.commits));
    } catch (e) {
      this.note.hidden = false;
      this.note.textContent = `Could not load more commits: ${errText(e)}`;
    } finally {
      this.loading = false;
      this.moreBtn.disabled = false;
    }
  }

  private apply(p: GraphPage, commits: GraphCommit[]) {
    this.page = p;
    this.note.hidden = true;
    this.moreBtn.hidden = !p.more;
    this.head.replaceChildren(
      ...(p.branch ? [h("span", {}, `HEAD → ${p.branch}`)] : p.head ? [h("span", {}, `HEAD detached at ${shortHash(p.head)}`)] : []),
      ...(p.upstream ? [h("span", { class: "dim" }, ` · tracks ${p.upstream}`)] : []),
    );
    if (!p.isRepo) {
      this.commits = [];
      this.shownKey = "";
      this.list.replaceChildren(h("div", { class: "dim" }, "Not a git repository"));
      return;
    }
    const key = JSON.stringify([p.head, p.upstream, commits.map((c) => [c.hash, c.refs])]);
    if (key === this.shownKey) return;
    this.shownKey = key;
    this.commits = commits;
    if (!commits.length) {
      this.list.replaceChildren(h("div", { class: "dim" }, "No commits yet"));
      return;
    }
    const top = this.list.scrollTop;
    const { rows, lanes } = layoutGraph(commits);
    this.list.style.setProperty("--gg-w", `${Math.max(1, lanes) * LANE_W}px`);
    this.list.replaceChildren(...commits.map((c, i) => this.row(c, rows[i], lanes, p)));
    this.list.scrollTop = top;
  }

  private row(c: GraphCommit, r: GraphRow, lanes: number, p: GraphPage): HTMLElement {
    const isHead = c.hash === p.head;
    const refs = c.refs.map((x) => refLabel(x, p.upstream));
    // A detached HEAD has no branch label to carry it.
    if (isHead && !c.refs.some((x) => x.head)) refs.unshift(h("span", { class: "gg-ref is-head", title: "HEAD (detached)" }, "HEAD"));
    const el = h(
      "div",
      { class: `gg-row${c.hash === this.selected ? " is-selected" : ""}${isHead ? " is-head" : ""}`, role: "listitem", tabindex: "0", title: c.subject },
      h("span", { class: "gg-graph" }, rowSvg(r, lanes, isHead)),
      h("span", { class: "gg-msg" }, ...refs, h("span", { class: "gg-subject" }, c.subject)),
      h("span", { class: "gg-author dim small" }, c.author),
      h("span", { class: "gg-date dim small", title: c.date }, ago(c.date)),
      h("code", { class: "gg-hash dim small" }, shortHash(c.hash)),
    );
    el.dataset.hash = c.hash;
    el.addEventListener("click", () => void this.open(c.hash));
    return el;
  }

  private key(e: KeyboardEvent) {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".gg-row");
    if (!row) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const to = (e.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling) as HTMLElement | null;
      to?.focus();
      if (!to && e.key === "ArrowDown") void this.loadMore();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void this.open(row.dataset.hash!);
    } else if (e.key === "Escape" && this.selected) {
      this.close();
    }
  }

  private mark() {
    for (const r of this.list.querySelectorAll<HTMLElement>(".gg-row")) r.classList.toggle("is-selected", r.dataset.hash === this.selected);
  }

  private close() {
    this.selected = "";
    this.detail.hidden = true;
    this.mark();
  }

  private async open(hash: string) {
    if (this.selected === hash && !this.detail.hidden) return this.close();
    this.selected = hash;
    this.mark();
    this.detail.hidden = false;
    this.detail.replaceChildren(h("div", { class: "dim small" }, `${shortHash(hash)} · loading…`));
    try {
      const d = await api.gitCommitDetail(hash);
      if (this.selected !== hash) return;
      this.renderDetail(d);
      this.detail.scrollIntoView({ block: "nearest" });
    } catch (e) {
      if (this.selected === hash) this.detail.replaceChildren(h("div", { class: "hint warn" }, errText(e)));
    }
  }

  private renderDetail(d: CommitDetail) {
    const diffTitle = h("div", { class: "git-diff-title mono small ellipsis" });
    const diffOut = h("pre", { class: "git-out" });
    const diffBox = h("div", { class: "git-diff", hidden: "" }, diffTitle, diffOut);
    let open = "";
    const files = d.files.map((f) => {
      const r = h("div", { class: "git-file", title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path }, h("code", { class: "xy" }, f.status), h("span", {}, f.oldPath ? `${f.oldPath} → ${f.path}` : f.path));
      r.addEventListener("click", async () => {
        for (const x of r.parentElement?.children ?? []) x.classList.toggle("is-selected", x === r && open !== f.path);
        if (open === f.path) {
          open = "";
          diffBox.hidden = true;
          return;
        }
        open = f.path;
        diffTitle.textContent = `${f.path} · loading diff…`;
        diffOut.replaceChildren();
        diffBox.hidden = false;
        try {
          const text = await api.gitCommitDiff(d.hash, f.path);
          if (open !== f.path) return;
          diffTitle.textContent = `${f.path} · click the file again to close`;
          diffOut.replaceChildren(...diffLines(text || "(no textual diff)"));
        } catch (e) {
          if (open === f.path) diffOut.textContent = errText(e);
        }
      });
      return r;
    });
    const closeBtn = h("button", { class: "gg-close", title: "Close (Esc)", "aria-label": "Close commit details" }, "Close");
    closeBtn.addEventListener("click", () => this.close());
    const when = new Date(d.date);
    this.detail.replaceChildren(
      h("div", { class: "panel-row" }, h("code", { class: "mono" }, shortHash(d.hash)), h("span", { class: "dim small" }, `${d.author} <${d.email}>`), h("span", { class: "dim small", title: d.date }, Number.isNaN(when.getTime()) ? d.date : when.toLocaleString()), h("span", { class: "spacer" }), closeBtn),
      ...(d.parents.length > 1 ? [h("div", { class: "dim small mono" }, `Merge of ${d.parents.map(shortHash).join(" + ")}; files against the first parent`)] : []),
      h("pre", { class: "gg-message" }, d.message),
      h("div", { class: "git-files" }, ...(files.length ? files : [h("div", { class: "dim" }, "No file changes against the first parent")])),
      diffBox,
    );
  }
}
