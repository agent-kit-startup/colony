// Conflict window (plan colony-explorer-git-workbench x7; git-cicd ADR amend 2026-11-07 point
// 6). The file list and hunks come from `agent-kit conflicts --json`; per hunk the operator
// picks ours, theirs, both, the DevOps agent's proposal or a manual edit, in a three-pane view
// (ours | theirs | result). "Ask DevOps" runs `agent-kit conflicts propose` through the kit
// (never a model call from Colony) and shows every proposal with its rationale before
// anything changes. Save writes the file through the jailed write; Stage files the
// `stage-resolved` host request (Approve card). Commit, continue and push stay with the
// operator. Diff, commit and agent text is untrusted: text nodes and textarea values only.
import { api, errText, h } from "./api";
import { applyChoices, type Choice, type ConflictFile, type ConflictHunk, type ConflictsListing, hasMarkers, pick, type ProposeResult, unresolved } from "./conflictmerge";
import { btn, busy, empty } from "./ui";

export interface ConflictHost {
  status: (msg: string) => void;
  confirm: (message: string) => Promise<boolean>;
  /** File the stage-resolved host request; resolves with the request id. */
  stage: (path: string) => Promise<string>;
  /** Show a request's Approve card. */
  revealRequest: (id: string) => void;
  /** The working tree moved (save, abort): reload the Explorer marks and the Git view. */
  changed: () => void;
}

interface FileState {
  file: ConflictFile;
  /** The working file as read when the listing was taken: Save refuses if it changed. */
  original: string | null;
  choices: Map<number, Choice>;
  proposal: ProposeResult | null;
  saved: boolean;
}

const sideLabel = (s: { ref: string; sha: string; subject: string } | null, fallback: string) => (s ? `${s.ref} ${s.sha.slice(0, 7)} · ${s.subject}` : fallback);

export class ConflictView {
  readonly el: HTMLElement;
  private head = h("div", { class: "cf-head" });
  private list = h("div", { class: "cf-files", role: "list", "aria-label": "Conflicted files" });
  private body = h("div", { class: "cf-body" });
  private listing: ConflictsListing | null = null;
  private files = new Map<string, FileState>();
  private current = "";
  private backend = h("select", { "aria-label": "DevOps agent backend" });
  private verify = h("input", { type: "checkbox", checked: "" });

  constructor(private host: ConflictHost) {
    for (const b of ["auto", "claude", "cursor-agent"]) this.backend.append(h("option", { value: b }, b));
    this.el = h("div", { class: "cv cv-conflicts" }, h("div", { class: "cv-body cf" }, this.head, h("div", { class: "cf-main" }, this.list, this.body)));
  }

  /** Read the conflicts again (keeps the choices of files whose hunks did not move). */
  async load(focus?: string) {
    this.head.replaceChildren(h("span", { class: "dim" }, "Reading conflicts (agent-kit conflicts --json)…"));
    let listing: ConflictsListing;
    try {
      listing = await api.conflictsList();
    } catch (e) {
      this.listing = null;
      this.head.replaceChildren(h("div", { class: "hint warn" }, errText(e)));
      this.list.replaceChildren();
      this.body.replaceChildren();
      return;
    }
    this.listing = listing;
    const old = this.files;
    this.files = new Map();
    for (const f of listing.files) {
      const prev = old.get(f.path);
      const same = prev && JSON.stringify(prev.file.hunks) === JSON.stringify(f.hunks);
      this.files.set(f.path, same ? { ...prev, file: f } : { file: f, original: null, choices: new Map(), proposal: null, saved: false });
    }
    const rel = focus && listing.root && focus.startsWith(`${listing.root}/`) ? focus.slice(listing.root.length + 1) : focus;
    this.current = rel && this.files.has(rel) ? rel : this.files.has(this.current) ? this.current : (listing.files[0]?.path ?? "");
    this.renderHead();
    this.renderList();
    await this.renderFile();
  }

  private abs(path: string) {
    return `${this.listing?.root ?? ""}/${path}`;
  }

  private renderHead() {
    const l = this.listing;
    if (!l) return;
    const reload = btn("Reload", () => void this.load(), { "data-act": "cf-reload", title: "Read the conflicts again" });
    const abort = btn("Abort merge…", () => void this.abort(), { "data-act": "cf-abort", title: "git merge --abort, after a confirmation" });
    abort.hidden = l.operation !== "merge";
    this.head.replaceChildren(
      h(
        "div",
        { class: "panel-row" },
        h("strong", {}, l.files.length ? `${l.operation ?? "conflict"}: ${l.files.length} conflicted file(s)` : "No conflicts"),
        h("span", { class: "spacer" }),
        reload,
        abort,
      ),
      ...(l.ours || l.theirs
        ? [h("div", { class: "cf-sides mono small" }, h("div", { class: "ellipsis" }, `ours   ${sideLabel(l.ours, "HEAD")}`), h("div", { class: "ellipsis" }, `theirs ${sideLabel(l.theirs, "the incoming side")}`))]
        : []),
      h("div", { class: "hint" }, "Pick a side per hunk, ask the DevOps agent, or edit the result. Save writes the file; Stage asks for your Approve. Commit, continue and push stay with you (Working tree or terminal)."),
    );
  }

  private renderList() {
    const rows = [...this.files.values()].map((st) => {
      const f = st.file;
      const left = f.kind === "text" ? unresolved(f.hunks, st.choices).length : 0;
      const tag = st.saved ? "saved" : f.kind !== "text" ? f.kind : left ? `${left}/${f.hunks.length} open` : "ready";
      const r = h("div", { class: `cf-file${f.path === this.current ? " is-selected" : ""}`, role: "listitem", tabindex: "0", title: f.reason ? `${f.path}: ${f.reason}` : f.path }, h("code", { class: "xy" }, f.xy), h("span", { class: "grow ellipsis" }, f.path), h("span", { class: "dim small" }, tag));
      const go = () => {
        this.current = f.path;
        this.renderList();
        void this.renderFile();
      };
      r.addEventListener("click", go);
      r.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      });
      return r;
    });
    this.list.replaceChildren(...(rows.length ? rows : [empty("No unmerged paths")]));
  }

  private async renderFile() {
    const st = this.files.get(this.current);
    if (!st) {
      this.body.replaceChildren();
      return;
    }
    const f = st.file;
    if (f.kind !== "text") {
      this.body.replaceChildren(h("div", { class: "hint warn" }, `${f.path}: ${f.kind}${f.reason ? ` (${f.reason})` : ""}. Resolve it in the terminal (git checkout --ours/--theirs, git rm or git add).`));
      return;
    }
    if (st.original === null) {
      try {
        st.original = await api.readTextFile(this.abs(f.path));
      } catch (e) {
        this.body.replaceChildren(h("div", { class: "hint warn" }, `${f.path}: ${errText(e)}`));
        return;
      }
    }
    const ask = btn("Ask DevOps", () => void this.propose(st, ask), { class: "primary", "data-act": "cf-propose", title: "agent-kit conflicts propose: a no-tools agent session proposes each hunk; nothing changes until you pick" });
    const save = btn("Save", () => void this.save(st), { "data-act": "cf-save" });
    const stage = btn("Stage…", () => void this.stage(st), { "data-act": "cf-stage", title: "git add of this file, after your Approve on its card" });
    const left = unresolved(f.hunks, st.choices);
    save.disabled = left.length > 0 || st.saved;
    // A file whose markers are already gone (resolved in the editor) can be staged as it is.
    stage.disabled = !st.saved && f.hunks.length > 0;
    const verifyLabel = h("label", { class: "check small" }, this.verify, " verify in a temporary worktree");
    this.body.replaceChildren(
      h("div", { class: "panel-row" }, h("strong", { class: "grow ellipsis mono" }, f.path), h("span", { class: "dim small" }, `base from ${f.baseSource ?? "none"}`), this.backend, verifyLabel, ask),
      ...(st.proposal ? [this.proposalSummary(st.proposal)] : []),
      ...f.hunks.map((hk) => this.hunkView(st, hk)),
      h("div", { class: "panel-row cf-actions" }, h("span", { class: "dim small grow" }, left.length ? `${left.length} hunk(s) still open: ${left.join(", ")}` : st.saved ? "Saved. Stage it, then commit from the Working tree." : "Every hunk resolved: save the file."), save, stage),
    );
  }

  private proposalSummary(p: ProposeResult): HTMLElement {
    const v = p.verification;
    return h(
      "div",
      { class: "cf-proposal-summary small" },
      h("div", {}, `DevOps (${p.backend}): ${p.proposals.filter((x) => x.status === "accepted").length} accepted, ${p.proposals.filter((x) => x.status === "refused").length} refused${p.unresolvedHunks.length ? `, no proposal for hunk(s) ${p.unresolvedHunks.join(", ")}` : ""}`),
      ...(p.replyRefused ? [h("div", { class: "hint warn" }, `Reply refused: ${p.replyRefused}`)] : []),
      h("div", { class: v.status === "failed" ? "hint warn" : "dim" }, `Verification: ${v.status}${v.reason ? ` (${v.reason})` : ""}`),
      ...v.commands.map((c) => h("details", {}, h("summary", { class: "mono" }, `${c.command} → exit ${c.exitCode}`), h("pre", { class: "git-out" }, c.tail))),
      ...v.notes.map((n) => h("div", { class: "dim" }, n)),
    );
  }

  private hunkView(st: FileState, hk: ConflictHunk): HTMLElement {
    const choice = st.choices.get(hk.index);
    const result = h("textarea", { class: "cf-result mono", rows: String(Math.min(16, Math.max(3, (choice?.text ?? hk.ours).split("\n").length + 1))), "aria-label": `Result of hunk ${hk.index}`, spellcheck: "false" });
    result.value = choice?.text ?? "";
    result.placeholder = "Pick a side above, or type the resolved text here";
    const proposal = st.proposal?.proposals.find((p) => p.hunk === hk.index);
    const set = (kind: Choice["kind"], text: string) => {
      st.choices.set(hk.index, { kind, text });
      st.saved = false;
      this.renderList();
      void this.renderFile();
    };
    const picks = [
      btn("Ours", () => set("ours", pick(hk, "ours")), { "data-pick": "ours", title: hk.oursLabel }),
      btn("Theirs", () => set("theirs", pick(hk, "theirs")), { "data-pick": "theirs", title: hk.theirsLabel }),
      btn("Both", () => set("both", pick(hk, "both")), { "data-pick": "both", title: "ours, then theirs" }),
      ...(proposal?.status === "accepted" ? [btn("DevOps", () => set("proposal", proposal.text), { "data-pick": "proposal", title: "The agent's proposal, shown below" })] : []),
    ];
    for (const b of picks) if (choice && b.dataset.pick === choice.kind) b.classList.add("is-on");
    result.addEventListener("input", () => {
      st.choices.set(hk.index, { kind: "manual", text: result.value });
      st.saved = false;
      tag.textContent = "manual edit";
    });
    // Leaving the field re-renders the counts (not on every key, so the caret stays put).
    result.addEventListener("change", () => {
      this.renderList();
      void this.renderFile();
    });
    const tag = h("span", { class: "dim small" }, choice ? (choice.kind === "manual" ? "manual edit" : `picked: ${choice.kind}`) : "open");
    const pane = (title: string, text: string, cls: string) => h("div", { class: `cf-pane ${cls}` }, h("div", { class: "cf-pane-title small ellipsis", title }, title), h("pre", { class: "cf-text mono" }, text || "(empty)"));
    return h(
      "section",
      { class: `cf-hunk${choice ? " is-resolved" : ""}`, "data-hunk": String(hk.index) },
      h("div", { class: "panel-row" }, h("strong", {}, `Hunk ${hk.index}`), h("span", { class: "dim small" }, `lines ${hk.startLine}-${hk.endLine}`), tag, h("span", { class: "spacer" }), ...picks),
      ...(hk.contextBefore ? [h("pre", { class: "cf-context mono small" }, hk.contextBefore)] : []),
      h("div", { class: "cf-panes" }, pane(`ours · ${hk.oursLabel}`, hk.ours, "cf-ours"), pane(`theirs · ${hk.theirsLabel}`, hk.theirs, "cf-theirs"), h("div", { class: "cf-pane cf-res" }, h("div", { class: "cf-pane-title small" }, "result"), result)),
      ...(hk.base !== null ? [h("details", { class: "cf-base" }, h("summary", { class: "small dim" }, `base · ${hk.baseLabel ?? ""}`), h("pre", { class: "cf-text mono" }, hk.base || "(empty)"))] : []),
      ...(proposal
        ? [
            h(
              "div",
              { class: `cf-proposal is-${proposal.status}` },
              h("div", { class: "small" }, proposal.status === "accepted" ? `DevOps proposal: ${proposal.rationale}` : `DevOps proposal refused: ${proposal.reason ?? ""}${proposal.rationale ? ` (${proposal.rationale})` : ""}`),
              h("pre", { class: "cf-text mono" }, proposal.text || "(empty: drop both sides)"),
            ),
          ]
        : []),
      ...(hk.contextAfter ? [h("pre", { class: "cf-context mono small" }, hk.contextAfter)] : []),
    );
  }

  private async propose(st: FileState, b: HTMLButtonElement) {
    const path = st.file.path;
    this.host.status(`DevOps: proposing ${path} (agent-kit conflicts propose, ${this.verify.checked ? "with" : "without"} verification)…`);
    await busy(b, "Asking…", async () => {
      try {
        st.proposal = await api.conflictsPropose(path, this.backend.value, this.verify.checked);
        this.host.status(`DevOps: proposals for ${path} are ready; nothing changed until you pick one`);
      } catch (e) {
        this.host.status(`DevOps: ${errText(e)}`);
        st.proposal = null;
        this.body.prepend(h("div", { class: "hint warn" }, errText(e)));
        return;
      }
    });
    if (this.current === path) await this.renderFile();
  }

  private async save(st: FileState) {
    const f = st.file;
    try {
      const now = await api.readTextFile(this.abs(f.path));
      if (st.original !== null && now !== st.original) throw new Error(`${f.path} changed on disk since the conflicts were read: Reload first (your picks stay where the hunks did not move)`);
      const text = applyChoices(now, f.hunks, st.choices);
      if (hasMarkers(text)) throw new Error("The result still has a conflict-marker line: edit it out first");
      await api.writeTextFile(this.abs(f.path), text);
      st.original = text;
      st.saved = true;
      this.host.status(`Saved ${f.path}: stage it when you are ready`);
      this.host.changed();
    } catch (e) {
      this.host.status(errText(e));
      this.body.prepend(h("div", { class: "hint warn" }, errText(e)));
      return;
    }
    this.renderList();
    await this.renderFile();
  }

  private async stage(st: FileState) {
    try {
      const id = await this.host.stage(st.file.path);
      this.host.status(`Stage ${st.file.path}: approve it on its card under Requests`);
      this.host.revealRequest(id);
    } catch (e) {
      this.host.status(errText(e));
    }
  }

  private async abort() {
    if (!(await this.host.confirm("Abort the merge? git merge --abort puts the branch back as it was before the merge and drops every resolution not committed."))) return;
    try {
      await api.gitMergeAbort();
      this.host.status("Merge aborted");
      this.files.clear();
      this.host.changed();
      await this.load();
    } catch (e) {
      this.host.status(errText(e));
    }
  }
}
