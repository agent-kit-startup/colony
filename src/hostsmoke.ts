// COLONY_SMOKE steps for host requests (called from runSmoke in main.ts, so this code runs
// only during the code-path smoke). With COLONY_GH_BIN=packaging/smoke/fake-gh.sh nothing
// reaches GitHub: a terminal tab files real `"$COLONY_HOST_CLI" request ...` calls, the
// smoke clicks the card buttons (the same handlers as the operator's clicks) and checks the
// requester's exit code and the fake gh's argv log.
import { api, errText } from "./api";
import { forgeApi } from "./forge";
import { hostApi, hostRequests } from "./hostreq";
import { prAction, rowAction, shipLaneGate } from "./shiplane";
import { snapshot } from "./snapshot";

export interface SmokeCtx {
  root: string;
  log: (step: string, ok: boolean, detail?: unknown) => Promise<unknown>;
  wait: (ms: number) => Promise<unknown>;
  until: (cond: () => boolean, ms: number) => Promise<boolean>;
  shot: (name: string) => Promise<void>;
  showTab: (id: string) => void;
  view: (id: string) => HTMLElement;
  term: (line: string) => Promise<void>;
  activeTab: () => string;
}

export async function hostSmoke(c: SmokeCtx) {
  const read = (rel: string) => api.readTextFile(`${c.root}/${rel}`).catch(() => "");
  const untilFile = async (rel: string, ok: (t: string) => boolean, ms: number) => {
    for (let i = 0; i < ms / 200; i++) {
      const t = await read(rel);
      if (ok(t)) return t;
      await c.wait(200);
    }
    return read(rel);
  };
  const git = c.view("git");
  // A card about a PR lives in the PR's merge box (its detail tab): the Requests list's row
  // opens that tab, the same click as the operator's.
  const req = (kind: string, n: number, origin: string) => hostRequests.items.find((i) => i.kind === kind && i.origin === origin && Object.values(i.args).includes(n));
  const find = (kind: string, n: number, origin = "agent") => {
    const r = req(kind, n, origin);
    return r ? document.querySelector<HTMLElement>(`.hostreq-card[data-id="${r.id}"]`) : null;
  };
  const ready = async (kind: string, n: number, origin = "agent") => {
    await c.until(() => {
      const r = req(kind, n, origin);
      if (r && !find(kind, n, origin)) git.querySelector<HTMLButtonElement>(`.hostreq-pointer[data-id="${r.id}"] button[data-act="open-pr-tab"]`)?.click();
      return !!find(kind, n, origin)?.dataset.ctx;
    }, 20000);
    return find(kind, n, origin);
  };
  const click = (el: Element | null | undefined, act: string) => el?.querySelector<HTMLButtonElement>(`button[data-act="${act}"]`)?.click();
  // Background job: the shell stays free and the file gets the CLI's output and exit code.
  const file = (args: string, out: string) => c.term(`( "$COLONY_HOST_CLI" request ${args} > ${out} 2>&1; echo "exit=$?" >> ${out} ) &\n`);
  const done = (t: string) => t.includes("exit=");
  try {
    // Every terminal tab inherits the spool and the CLI path.
    await c.term(`printf '%s\\n%s\\n' "$COLONY_HOST_SPOOL" "$COLONY_HOST_CLI" > host-env.txt\n`);
    const env = (await untilFile("host-env.txt", (t) => t.split("\n").length > 2, 6000)).split("\n");
    await c.log("host-env", !!env[0] && env[0] === hostRequests.spool && /\/colony$/.test(env[1]), { spool: env[0], cli: env[1], store: hostRequests.spool });
    const st = await forgeApi.status();
    await c.log("forge-status", !!st.bin && st.authenticated, st);

    // An agent's merge request: a card with the PR context, approved by a click.
    c.showTab("git");
    await file(`merge-pr 7 --reason "smoke: checks are green"`, "hostreq-merge7.out");
    const m7 = await ready("merge-pr", 7);
    // The Ship rail item carries the Git view's badge.
    const badge = document.querySelector('.tab[data-tab="ship"] .badge')?.textContent;
    const text = m7?.textContent ?? "";
    const runningShown = !!m7?.querySelector(".chip-running")?.getClientRects().length;
    await c.log("host-request-card", !!m7 && !runningShown && m7.dataset.production === "no" && text.includes("Smoke PR seven") && text.includes("feat/base ← feat/seven") && text.includes("smoke: checks are green") && badge === "1", { badge, runningShown, production: m7?.dataset.production, text: text.slice(0, 300) });
    await c.shot("git-request");
    const lists = (t: string) => t.split("\n").filter((l) => l.startsWith("pr list")).length;
    const listsBefore = lists(await read("gh-proof.txt"));
    click(m7, "approve");
    const out7 = await untilFile("hostreq-merge7.out", done, 20000);
    let proof = await read("gh-proof.txt");
    await c.log("host-request-approve", out7.includes("exit=0") && out7.includes("Merged pull request #7") && proof.includes("pr merge 7 --squash") && !find("merge-pr", 7), { out: out7, gh: proof.split("\n").filter((l) => l.startsWith("pr merge")) });
    // The PR list reloads after the merge, with no click on its ↻ (a merged PR must not linger).
    proof = await untilFile("gh-proof.txt", (t) => lists(t) > listsBefore, 10000);
    await c.log("pr-list-reload-after-merge", lists(proof) > listsBefore, { before: listsBefore, after: lists(proof) });

    // A production base (release) needs the typed yes: without it nothing runs. No --method:
    // the host rule squashes it (only the promote and the staging sync keep a merge commit).
    await file("merge-pr 8", "hostreq-merge8.out");
    const m8 = await ready("merge-pr", 8);
    click(m8, "approve");
    await c.wait(800);
    const refusedText = m8?.querySelector(".hostreq-out")?.textContent ?? "";
    // The host re-checks on its own: an approve without the yes is refused there too.
    const id8 = hostRequests.items.find((i) => i.kind === "merge-pr" && i.args.number === 8)?.id ?? "";
    const direct = await hostApi.approve(id8).then(() => "approved", errText);
    const before = (await read("gh-proof.txt")).includes("pr merge 8");
    const yes = m8?.querySelector<HTMLInputElement>("input.yes");
    if (yes) yes.value = "yes";
    click(m8, "approve");
    const out8 = await untilFile("hostreq-merge8.out", done, 20000);
    proof = await read("gh-proof.txt");
    await c.log("host-request-production", m8?.dataset.production === "yes" && /type yes/i.test(refusedText) && /type yes/i.test(direct) && !before && out8.includes("exit=0") && proof.includes("pr merge 8 --squash"), { refusedText, direct, out: out8 });

    // Deny with a reason: the agent gets exit 2 and the reason; gh is never called.
    await file(`rerun-checks 4243 --reason "smoke: flaky lint"`, "hostreq-rerun.out");
    const rr = await ready("rerun-checks", 4243);
    const why = rr?.querySelector<HTMLInputElement>("input.deny-reason");
    if (why) why.value = "smoke says no";
    click(rr, "deny");
    const outR = await untilFile("hostreq-rerun.out", done, 20000);
    proof = await read("gh-proof.txt");
    await c.log("host-request-deny", outR.includes("exit=2") && outR.includes("denied by the operator: smoke says no") && !proof.includes("run rerun 4243"), { out: outR });

    // Refused before the spool: a production push and a kind outside the allowlist.
    await c.term(`"$COLONY_HOST_CLI" request push-branch release > hostreq-refused.out 2>&1; echo "exit=$?" >> hostreq-refused.out; "$COLONY_HOST_CLI" request shell ls >> hostreq-refused.out 2>&1; echo "exit=$?" >> hostreq-refused.out\n`);
    const outF = await untilFile("hostreq-refused.out", (t) => (t.match(/exit=/g) ?? []).length >= 2, 10000);
    await c.log("host-request-refused", (outF.match(/exit=64/g) ?? []).length === 2 && hostRequests.count === 0, { out: outF.slice(-400) });

    // The operator's own merge from the PR list goes through the same card.
    c.showTab("git");
    await c.until(() => !!git.querySelector('.pr-row[data-pr="7"]'), 15000);
    click(git.querySelector('.pr-row[data-pr="7"]'), "merge");
    const local = await ready("merge-pr", 7, "colony");
    click(local, "approve");
    await c.until(() => !find("merge-pr", 7, "colony"), 15000);
    proof = await read("gh-proof.txt");
    await c.log("pr-list-merge", !!local && (proof.match(/pr merge 7 --squash/g) ?? []).length === 2 && hostRequests.count === 0, { prs: git.querySelectorAll(".pr-row").length });

    // CI/CD tab: runs of this branch, rerun the failed one.
    c.showTab("cicd");
    const cicd = c.view("cicd");
    await c.until(() => cicd.querySelectorAll(".cicd-run").length > 0, 15000);
    click(cicd.querySelector('.cicd-run[data-run="4243"]'), "rerun");
    const rerun = await untilFile("gh-proof.txt", (t) => t.includes("run rerun 4243 --failed"), 10000);
    await c.log("cicd-rerun", c.activeTab() === "cicd" && cicd.querySelectorAll(".cicd-run").length === 2 && rerun.includes("run rerun 4243 --failed") && !cicd.querySelector('.cicd-run[data-run="4242"] button[data-act="rerun"]'), { runs: cicd.querySelectorAll(".cicd-run").length });
    await c.shot("cicd");
  } catch (e) {
    await c.log("host-smoke", false, errText(e));
  }
}

/**
 * Git e CI/CD steps (plan git-cicd-bento-colony p3): the Ship lane tile over the live
 * snapshot (the engine's collector reads the same fake gh first on PATH), its buttons
 * opening approval cards, the typed yes for staging -> main, the fixed-shape open-pr kind
 * and its refusals. Nothing reaches GitHub: gh is the fixture, the work clone's origin URL
 * does not resolve and its push URL is a scratch mirror.
 */
export async function gitCicdSmoke(c: SmokeCtx) {
  const read = (rel: string) => api.readTextFile(`${c.root}/${rel}`).catch(() => "");
  const untilFile = async (rel: string, ok: (t: string) => boolean, ms: number) => {
    for (let i = 0; i < ms / 200; i++) {
      const t = await read(rel);
      if (ok(t)) return t;
      await c.wait(200);
    }
    return read(rel);
  };
  const git = c.view("git");
  const card = (kind: string, arg: unknown, origin = "colony") => {
    const r = hostRequests.items.find((i) => i.kind === kind && i.origin === origin && Object.values(i.args).includes(arg));
    return { r, el: r ? document.querySelector<HTMLElement>(`.hostreq-card[data-id="${r.id}"]`) : null };
  };
  const ready = async (kind: string, arg: unknown, origin = "colony") => {
    await c.until(() => {
      const x = card(kind, arg, origin);
      if (x.r && !x.el) git.querySelector<HTMLButtonElement>(`.hostreq-pointer[data-id="${x.r.id}"] button[data-act="open-pr-tab"]`)?.click();
      return !!card(kind, arg, origin).el?.dataset.ctx;
    }, 20000);
    return card(kind, arg, origin);
  };
  const click = (el: Element | null | undefined, act: string) => el?.querySelector<HTMLButtonElement>(`button[data-act="${act}"]`)?.click();
  const tile = () => git.querySelector<HTMLElement>(".bento-ship");
  // The tile is a status line; its rows show while one is pending or red, or after the toggle.
  const row = (id: string) => {
    const t = tile();
    if (t?.dataset.open === "false") t.querySelector<HTMLButtonElement>('button[data-act="ship-toggle"]')?.click();
    return tile()?.querySelector<HTMLElement>(`.ship-row[data-row="${id}"]`) ?? null;
  };
  const proof = () => read("gh-proof.txt");
  try {
    c.showTab("git");
    // The live snapshot's ship lane, with the forge half read through the fixture gh.
    const live = () => !!snapshot.data?.shipLane?.remote?.available && !!row("tag-ci");
    await c.until(live, 60000);
    const t = tile();
    const ids = [...(t?.querySelectorAll<HTMLElement>(".ship-row") ?? [])].map((e) => e.dataset.row);
    const acts = (id: string) => [...(row(id)?.querySelectorAll<HTMLButtonElement>("button[data-act]") ?? [])].map((b) => b.dataset.act);
    // One PR list: the Pull requests tile (live gh). Its titles are forge text, as text nodes.
    await c.until(() => !!git.querySelector('.pr-row[data-pr="8"]'), 15000);
    const pr8 = git.querySelector<HTMLElement>('.pr-row[data-pr="8"]');
    const bento = git.querySelector(".git-bento");
    const noBars = [...(bento?.querySelectorAll<HTMLElement>("*") ?? [])].every((e) => !e.style.borderLeft && !e.style.boxShadow);
    await c.log(
      "ship-lane-tile",
      live() &&
        bento?.firstElementChild === t &&
        ["release-close", "staging-main", "tag-ci", "staging-sync"].every((id) => ids.includes(id)) &&
        acts("release-close").includes("ship-merge-pr") &&
        acts("staging-main").includes("ship-open-pr") &&
        acts("tag-ci").includes("ship-rerun-checks") &&
        acts("staging-sync").includes("ship-open-pr") &&
        !t?.querySelector(".ship-pr, .ship-prs") &&
        !!pr8?.textContent?.includes("<img src=x") &&
        !git.querySelector(".git-bento img") &&
        noBars &&
        t?.dataset.gate === "",
      { version: snapshot.data?.dashboardDataVersion, rows: ids, actions: Object.fromEntries(ids.map((id) => [id, acts(String(id))])), gate: t?.dataset.gate },
    );
    await c.shot("git-cicd");

    // The action table and the engine gate, on fixed lanes (pure functions of the tile).
    const lane = (o: Record<string, unknown>) => ({ remote: { available: true, prs: [], ...((o.remote as object) ?? {}) }, local: { stagingAheadOfMain: 2, mainInStaging: true, ...((o.local as object) ?? {}) } });
    const promote = { number: 9, head: "staging", base: "main", draft: false, mergeable: "mergeable", checks: { failing: [], pending: 0 } };
    const sync = { number: 12, head: "chore/sync-staging-main-578dc26", base: "staging", draft: false, mergeable: "mergeable", checks: { failing: [], pending: 0 } };
    const cases: [string, unknown, string][] = [
      ["promote PR open -> merge with a merge commit", rowAction({ id: "staging-main", state: "pending" }, lane({ remote: { prs: [promote] } }))?.action, JSON.stringify({ kind: "merge-pr", args: { number: 9, method: "merge" } })],
      ["promote PR checks running -> no merge, no second PR", rowAction({ id: "staging-main", state: "pending" }, lane({ remote: { prs: [{ ...promote, checks: { failing: [], pending: 2 } }] } })), "null"],
      ["promote PR conflicting -> no merge", prAction({ ...promote, mergeable: "conflicting" }), "null"],
      ["promote PR mergeability unknown -> no merge", prAction({ ...promote, mergeable: "unknown" }), "null"],
      ["sync PR open -> merge it with a merge commit, no Open sync PR", rowAction({ id: "staging-sync", state: "red" }, lane({ remote: { prs: [sync] }, local: { mainInStaging: false } }))?.action, JSON.stringify({ kind: "merge-pr", args: { number: 12, method: "merge" } })],
      ["main not in staging, no sync PR -> open-pr staging-sync", rowAction({ id: "staging-sync", state: "red" }, lane({ local: { mainInStaging: false } }))?.action, JSON.stringify({ kind: "open-pr", args: { shape: "staging-sync" } })],
      ["staging ahead, no PR -> open-pr promote", rowAction({ id: "staging-main", state: "pending" }, lane({}))?.action, JSON.stringify({ kind: "open-pr", args: { shape: "promote" } })],
      ["staging-main green -> nothing", rowAction({ id: "staging-main", state: "green" }, lane({ local: { stagingAheadOfMain: 0 } })), "null"],
      ["tag CI red, no run id -> nothing", rowAction({ id: "tag-ci", state: "red" }, lane({ remote: { tagCi: { runId: null } } })), "null"],
      ["tag CI green -> nothing", rowAction({ id: "tag-ci", state: "green" }, lane({ remote: { tagCi: { runId: 5 } } })), "null"],
      ["main in staging -> no sync", rowAction({ id: "staging-sync", state: "green" }, lane({})), "null"],
      ["forge down -> no merge", rowAction({ id: "release-close", state: "pending" }, { remote: { available: false, prs: [{ number: 3, head: "chore/close-release-1", base: "staging" }] }, local: {} }), "null"],
      ["close PR into main is not a release close", rowAction({ id: "release-close", state: "pending" }, lane({ remote: { prs: [{ number: 3, head: "chore/close-release-1", base: "main" }] } })), "null"],
      ["npm row -> nothing (copy only)", rowAction({ id: "npm", state: "red" }, lane({})), "null"],
      ["draft PR -> no merge", prAction({ number: 4, head: "a", base: "staging", draft: true }), "null"],
      ["forged PR number -> no merge", prAction({ number: "4; rm", head: "a", base: "staging" }), "null"],
      ["promote PR -> merge commit", prAction(promote), JSON.stringify({ kind: "merge-pr", args: { number: 9, method: "merge" } })],
      ["data 1.7.0 -> engine gate", typeof shipLaneGate({ dashboardDataVersion: "1.7.0", shipLane: {} }), "string"],
      ["data 1.8.0 without shipLane -> engine gate", typeof shipLaneGate({ dashboardDataVersion: "1.8.0" }), "string"],
      ["data 1.10.0 with shipLane -> shown", String(shipLaneGate({ dashboardDataVersion: "1.10.0", shipLane: { rows: [] } })), "null"],
    ];
    const verdicts = cases.map(([what, got, want]) => ({ what, got: got === undefined ? "undefined" : got === null ? "null" : typeof got === "string" ? got : JSON.stringify(got), want }));
    await c.log("ship-actions-table", verdicts.every((v) => v.got === v.want), verdicts.filter((v) => v.got !== v.want));

    // Release close into staging: squash, no typed yes.
    click(row("release-close"), "ship-merge-pr");
    const m11 = await ready("merge-pr", 11);
    click(m11.el, "approve");
    let gh = await untilFile("gh-proof.txt", (x) => x.includes("pr merge 11 --squash"), 15000);
    await c.log("ship-merge-staging", m11.el?.dataset.production === "no" && gh.includes("pr merge 11 --squash"), { production: m11.el?.dataset.production });

    // Open the staging -> main PR: fixed branches and title, no typed yes (it merges nothing).
    click(row("staging-main"), "ship-open-pr");
    const op = await ready("open-pr", "promote");
    const opText = op.el?.textContent ?? "";
    click(op.el, "approve");
    gh = await untilFile("gh-proof.txt", (x) => x.includes("pr create --base main --head staging"), 15000);
    await c.log("ship-open-promote", op.el?.dataset.production === "no" && opText.includes("Promote staging to main") && opText.includes("main ← staging") && gh.includes("pr create --base main --head staging --title Promote staging to main --body"), { text: opText.slice(0, 300) });

    // Rerun the failed jobs of the tag's CI run.
    click(row("tag-ci"), "ship-rerun-checks");
    const rr = await ready("rerun-checks", 4300);
    click(rr.el, "approve");
    gh = await untilFile("gh-proof.txt", (x) => x.includes("run rerun 4300 --failed"), 15000);
    await c.log("ship-rerun-tag-ci", !!rr.el && gh.includes("run rerun 4300 --failed"), {});

    // Staging fast-forward sync: origin/main's tip pushed (to the scratch mirror) to a new
    // chore/ branch, then the PR into staging.
    click(row("staging-sync"), "ship-open-pr");
    const sy = await ready("open-pr", "staging-sync");
    const syText = sy.el?.textContent ?? "";
    click(sy.el, "approve");
    gh = await untilFile("gh-proof.txt", (x) => x.includes("pr create --base staging --head chore/sync-staging-main-"), 20000);
    await c.term(`{ git rev-parse refs/remotes/origin/main; git --git-dir="$(git config remote.origin.pushurl)" for-each-ref --format='%(refname) %(objectname)' refs/heads/chore/; } > sync-proof.txt 2>&1\n`);
    const sp = (await untilFile("sync-proof.txt", (x) => x.split("\n").length > 2, 8000)).trim().split("\n");
    const sha = sp[0] ?? "";
    await c.log("ship-staging-sync", /^[0-9a-f]{40}$/.test(sha) && sp.includes(`refs/heads/chore/sync-staging-main-${sha.slice(0, 7)} ${sha}`) && gh.includes(`pr create --base staging --head chore/sync-staging-main-${sha.slice(0, 7)} --title chore: sync staging with main (${sha.slice(0, 7)})`) && syText.includes("never forced"), { proof: sp, text: syText.slice(0, 300) });

    // Staging -> main merge from the PR list: refused without the typed yes (the UI and the
    // host both), then a merge commit with it.
    await c.until(() => !!git.querySelector('.pr-row[data-pr="9"]'), 15000);
    const r9 = git.querySelector<HTMLElement>('.pr-row[data-pr="9"]');
    const sel = r9?.querySelector<HTMLSelectElement>("select");
    if (sel) sel.value = "merge";
    click(r9, "merge");
    const m9 = await ready("merge-pr", 9);
    click(m9.el, "approve");
    await c.wait(800);
    const refusedText = m9.el?.querySelector(".hostreq-out")?.textContent ?? "";
    const direct = await hostApi.approve(m9.r?.id ?? "").then(() => "approved", errText);
    const before = (await proof()).includes("pr merge 9");
    const yes = m9.el?.querySelector<HTMLInputElement>("input.yes");
    if (yes) yes.value = "yes";
    click(m9.el, "approve");
    gh = await untilFile("gh-proof.txt", (x) => x.includes("pr merge 9 --merge"), 15000);
    await c.log("ship-merge-main-yes", m9.el?.dataset.production === "yes" && /type yes/i.test(refusedText) && /type yes/i.test(direct) && !before && gh.includes("pr merge 9 --merge"), { refusedText, direct });

    // Security review fixes: a fork PR into main is refused on its card (no typed yes helps),
    // and every merge is pinned to the head commit the card showed.
    await c.term(`( "$COLONY_HOST_CLI" request merge-pr 10 --method merge > fork10.out 2>&1; echo "exit=$?" >> fork10.out ) &\n`);
    const f10 = await ready("merge-pr", 10, "agent");
    const fText = f10.el?.textContent ?? "";
    const approveOff = !!f10.el?.querySelector<HTMLButtonElement>('button[data-act="approve"]')?.disabled;
    const forced = await hostApi.approve(f10.r?.id ?? "", "yes").then(() => "approved", errText);
    click(f10.el, "deny");
    const fOut = await untilFile("fork10.out", (x) => x.includes("exit="), 15000);
    gh = await proof();
    await c.log(
      "ship-fork-refused",
      fText.includes("mallory:staging") && fText.includes("another repository") && approveOff && /Refused/.test(forced) && fOut.includes("exit=2") && !gh.includes("pr merge 10") && /pr merge 9 --merge --match-head-commit [0-9a-f]{40}/.test(gh),
      { forced, approveOff, out: fOut.slice(-200), text: fText.slice(0, 300) },
    );

    // open-pr takes a fixed shape only: free branches, a merge method or an unknown shape exit 64.
    await c.term(`for a in "open-pr main" "open-pr --base main --head feat/x" "open-pr promote --method merge" "open-pr"; do "$COLONY_HOST_CLI" request $a >> open-pr-refused.out 2>&1; echo "exit=$?" >> open-pr-refused.out; done\n`);
    const outF = await untilFile("open-pr-refused.out", (x) => (x.match(/exit=/g) ?? []).length >= 4, 10000);
    await c.log("ship-open-pr-refused", (outF.match(/exit=64/g) ?? []).length === 4 && hostRequests.count === 0, { out: outF.slice(-400), pending: hostRequests.count });
  } catch (e) {
    await c.log("git-cicd-smoke", false, errText(e));
  }
}

/**
 * Forge-style Git tab steps (plan colony-git-tab-forge-ux r6): the PR list renders bot and
 * human PRs with one action per state (a conflicting PR offers Resolve and no Merge), the
 * filters, a card for a merged PR expires on Approve with nothing run, a promote cannot be
 * squashed, update-branch through its card, the PR detail tab and its merge box, and the Ship
 * lane status line. gh is the fixture (packaging/smoke/fake-gh.sh). With COLONY_SMOKE_SHOTS=1
 * the list and the detail are shot at 1280 and 1920 CSS px wide (page zoom, no window resize).
 */
export async function forgeUxSmoke(c: SmokeCtx & { closeTab: (id: string) => void; tabIds: () => string[] }) {
  const read = (rel: string) => api.readTextFile(`${c.root}/${rel}`).catch(() => "");
  const untilFile = async (rel: string, ok: (t: string) => boolean, ms: number) => {
    for (let i = 0; i < ms / 200; i++) {
      const t = await read(rel);
      if (ok(t)) return t;
      await c.wait(200);
    }
    return read(rel);
  };
  const git = c.view("git");
  const click = (el: Element | null | undefined, act: string) => el?.querySelector<HTMLButtonElement>(`button[data-act="${act}"]`)?.click();
  const req = (kind: string, n: number, origin: string) => hostRequests.items.find((i) => i.kind === kind && i.origin === origin && Object.values(i.args).includes(n));
  const cardOf = (kind: string, n: number, origin: string) => {
    const r = req(kind, n, origin);
    return r ? document.querySelector<HTMLElement>(`.hostreq-card[data-id="${r.id}"]`) : null;
  };
  const ready = async (kind: string, n: number, origin = "agent") => {
    await c.until(() => {
      const r = req(kind, n, origin);
      if (r && !cardOf(kind, n, origin)) git.querySelector<HTMLButtonElement>(`.hostreq-pointer[data-id="${r.id}"] button[data-act="open-pr-tab"]`)?.click();
      return !!cardOf(kind, n, origin)?.dataset.ctx;
    }, 20000);
    return cardOf(kind, n, origin);
  };
  const file = (args: string, out: string) => c.term(`( "$COLONY_HOST_CLI" request ${args} > ${out} 2>&1; echo "exit=$?" >> ${out} ) &\n`);
  const done = (t: string) => t.includes("exit=");
  const row = (n: number) => git.querySelector<HTMLElement>(`.pr-row[data-pr="${n}"]`);
  const acts = (el: Element | null) => [...(el?.querySelectorAll<HTMLButtonElement>(".pr-act button[data-act]") ?? [])].map((b) => b.dataset.act).join(",");
  const shotAt = async (name: string, width: number) => {
    const root = document.documentElement;
    const before = root.style.zoom;
    root.style.zoom = String(window.innerWidth / width);
    await c.wait(300);
    await c.shot(`${name}-${width}`);
    root.style.zoom = before;
  };
  try {
    c.showTab("git");
    const refresh = git.querySelector<HTMLButtonElement>('.forge-prs button[aria-label="Refresh pull requests"]');
    refresh?.click();
    await c.wait(200);
    // The rows are rebuilt when gh answers: wait for the reload to end before holding any row.
    await c.until(() => !refresh?.classList.contains("is-busy") && !!row(13) && !!row(14) && !!row(16), 15000);
    const pr7 = row(7);
    const pr13 = row(13);
    const pr14 = row(14);
    const states = [7, 8, 9, 13, 14, 15, 16].map((n) => `${n}:${row(n)?.dataset.state}:${acts(row(n))}`);
    const want = ["7:ready:merge", "8:ready:merge", "9:ready:merge", "13:behind:update-branch", "14:conflicts:resolve", "15:checks running:", "16:failing:"];
    const bot = !!pr13?.querySelector(".pr-bot") && !pr7?.querySelector(".pr-bot");
    const badge16 = row(16)?.querySelector<HTMLElement>(".pr-checks")?.title ?? "";
    const noBranches = !(pr7?.textContent ?? "").includes("feat/seven");
    // Selected rows: border colour only (computed style, no left bar, no tinted fill).
    pr14?.querySelector<HTMLInputElement>("input.pr-select")?.click();
    await c.wait(100);
    const sel14 = row(14);
    const cs = sel14 ? getComputedStyle(sel14) : null;
    const look = cs ? { selected: sel14?.classList.contains("is-selected"), bl: cs.borderLeftWidth, br: cs.borderRightWidth, shadow: cs.boxShadow, bg: cs.backgroundColor, color: cs.borderTopColor } : null;
    const borderOnly = !!cs && !!look?.selected && cs.borderLeftWidth === cs.borderRightWidth && cs.boxShadow === "none" && (cs.backgroundColor === "rgba(0, 0, 0, 0)" || cs.backgroundColor === "transparent");
    const bulk = git.querySelector<HTMLElement>(".pr-bulk");
    const bulkText = bulk && !bulk.hidden ? bulk.textContent ?? "" : "";
    click(bulk, "bulk-clear");
    await c.log(
      "forge-pr-list",
      JSON.stringify(states) === JSON.stringify(want) && bot && badge16.includes("signature-scan") && noBranches && borderOnly && /1 selected/.test(bulkText) && /Update branch \(0\)/.test(bulkText) && !/merge/i.test(bulkText.replace("Merges run one PR at a time", "")),
      { states, bot, badge16, noBranches, borderOnly, look, bulkText },
    );
    // Filters: Bot shows the bot PR only; Needs action hides running and draft PRs.
    git.querySelector<HTMLButtonElement>('button[data-filter="who-bot"]')?.click();
    await c.wait(150);
    const botOnly = [...git.querySelectorAll<HTMLElement>(".pr-row")].map((e) => e.dataset.pr).join(",");
    git.querySelector<HTMLButtonElement>('button[data-filter="who-all"]')?.click();
    git.querySelector<HTMLInputElement>('input[data-filter="needs-action"]')?.click();
    await c.wait(150);
    const needs = [...git.querySelectorAll<HTMLElement>(".pr-row")].map((e) => e.dataset.pr).join(",");
    git.querySelector<HTMLInputElement>('input[data-filter="needs-action"]')?.click();
    await c.wait(150);
    await c.log("forge-pr-filters", botOnly === "13" && needs === "7,8,9,13,14,16", { botOnly, needs });
    git.querySelector(".forge-prs")?.scrollIntoView({ block: "start" });
    await shotAt("forge-pr-list", 1280);
    await shotAt("forge-pr-list", 1920);

    // A card for a PR that merged already expires on Approve: nothing runs, the agent hears why.
    const before17 = (await read("gh-proof.txt")).includes("pr merge 17");
    await file("merge-pr 17", "forge-merge17.out");
    const m17 = await ready("merge-pr", 17);
    const stale = m17?.dataset.stale === "yes" && /Expired: already merged/.test(m17?.textContent ?? "") && m17?.querySelector<HTMLButtonElement>('button[data-act="approve"]')?.textContent === "Expire";
    click(m17, "approve");
    const out17 = await untilFile("forge-merge17.out", done, 20000);
    const proof17 = await read("gh-proof.txt");
    await c.log("forge-card-expires", stale && !before17 && out17.includes("exit=2") && out17.includes("expired: already merged") && !proof17.includes("pr merge 17") && !req("merge-pr", 17, "agent"), { stale, out: out17.slice(-300) });

    // A promote cannot be squashed: refused on the card and by the host, even with the yes.
    const squashes = (t: string) => (t.match(/pr merge 9 --squash/g) ?? []).length;
    const sq0 = squashes(await read("gh-proof.txt"));
    await file("merge-pr 9 --method squash", "forge-squash9.out");
    const m9 = await ready("merge-pr", 9);
    const refusedText = m9?.textContent ?? "";
    const approveOff = !!m9?.querySelector<HTMLButtonElement>('button[data-act="approve"]')?.disabled;
    const forced = await hostApi.approve(req("merge-pr", 9, "agent")?.id ?? "", "yes").then(() => "approved", errText);
    click(m9, "deny");
    const out9 = await untilFile("forge-squash9.out", done, 20000);
    await c.log("forge-promote-no-squash", /merge by the host rule, not squash/.test(refusedText) && approveOff && /not squash/.test(forced) && out9.includes("exit=2") && squashes(await read("gh-proof.txt")) === sq0, { approveOff, forced, out: out9.slice(-200) });

    // Update branch from the list: a card in PR 13's merge box, approved, gh pr update-branch 13.
    click(row(13), "update-branch");
    const u13 = await ready("update-branch", 13, "colony");
    const inBox = !!u13?.closest(".prd-merge") && c.activeTab() === "pr:13";
    click(u13, "approve");
    const proofU = await untilFile("gh-proof.txt", (t) => t.includes("pr update-branch 13"), 15000);
    await c.log("forge-update-branch", inBox && proofU.includes("pr update-branch 13"), { inBox, active: c.activeTab() });

    // PR detail: the conflicting PR's merge box lists the blocker and offers Resolve, not Merge.
    click(row(14), "open");
    await c.until(() => !!document.querySelector('.cv-pr[data-pr="14"] .prd-merge .actions'), 15000);
    const d14 = document.querySelector<HTMLElement>('.cv-pr[data-pr="14"]');
    const box = d14?.querySelector(".prd-merge");
    const merge14 = box?.querySelector<HTMLButtonElement>('button[data-act="merge"]');
    const boxOk = /Conflicts with feat\/base/.test(box?.textContent ?? "") && !!box?.querySelector('button[data-act="resolve"]') && !!merge14?.disabled && /squash/.test(box?.textContent ?? "");
    d14?.querySelector<HTMLButtonElement>('button[data-section="checks"]')?.click();
    await c.wait(150);
    const checks = d14?.querySelectorAll(".prd-check").length ?? 0;
    d14?.querySelector<HTMLButtonElement>('button[data-section="files"]')?.click();
    await c.until(() => (d14?.querySelector(".prd-diff")?.textContent ?? "").includes("new line from PR 14"), 10000);
    const files = (d14?.querySelector(".prd-diff")?.textContent ?? "").includes("new line from PR 14");
    d14?.querySelector<HTMLButtonElement>('button[data-section="conversation"]')?.click();
    await c.log("forge-pr-detail", c.activeTab() === "pr:14" && boxOk && checks === 2 && files, { boxOk, checks, files, box: (box?.textContent ?? "").slice(0, 300) });
    // A promote's merge box runs the ruleset preflight (agent-kit promote rules) before Merge.
    click(row(9), "open");
    await c.until(() => /required_signatures/.test(document.querySelector('.cv-pr[data-pr="9"] .prd-preflight')?.textContent ?? ""), 15000);
    const box9 = document.querySelector<HTMLElement>('.cv-pr[data-pr="9"] .prd-merge');
    const merge9 = box9?.querySelector<HTMLButtonElement>('button[data-act="merge"]');
    await c.log("forge-promote-preflight", /required_signatures \(ruleset 42\)/.test(box9?.textContent ?? "") && /merge commit/.test(box9?.textContent ?? "") && /typed yes/.test(box9?.textContent ?? "") && merge9?.textContent === "Merge (promote)…" && !merge9.disabled, { box: (box9?.textContent ?? "").slice(0, 400) });
    await shotAt("forge-pr-detail", 1280);
    await shotAt("forge-pr-detail", 1920);

    // Ship lane: one status line; the rows open while a row is red (tag CI in the fixture).
    c.showTab("git");
    const line = git.querySelector<HTMLElement>(".bento-ship .ship-line")?.textContent ?? "";
    await c.log("forge-ship-line", /shipped/.test(line) && /forge (read|not read)/.test(line), { line });
  } catch (e) {
    await c.log("forge-ux-smoke", false, errText(e));
  } finally {
    for (const id of c.tabIds()) if (id.startsWith("pr:")) c.closeTab(id);
    document.documentElement.style.zoom = "";
  }
}
