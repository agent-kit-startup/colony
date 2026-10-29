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
  const find = (kind: string, n: number, origin = "agent") => {
    const r = hostRequests.items.find((i) => i.kind === kind && i.origin === origin && Object.values(i.args).includes(n));
    return r ? git.querySelector<HTMLElement>(`.hostreq-card[data-id="${r.id}"]`) : null;
  };
  const ready = async (kind: string, n: number, origin = "agent") => {
    await c.until(() => !!find(kind, n, origin)?.dataset.ctx, 20000);
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

    // A production base (release) needs the typed yes: without it nothing runs.
    await file("merge-pr 8 --method rebase", "hostreq-merge8.out");
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
    await c.log("host-request-production", m8?.dataset.production === "yes" && /type yes/i.test(refusedText) && /type yes/i.test(direct) && !before && out8.includes("exit=0") && proof.includes("pr merge 8 --rebase"), { refusedText, direct, out: out8 });

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
    return { r, el: r ? git.querySelector<HTMLElement>(`.hostreq-card[data-id="${r.id}"]`) : null };
  };
  const ready = async (kind: string, arg: unknown, origin = "colony") => {
    await c.until(() => !!card(kind, arg, origin).el?.dataset.ctx, 20000);
    return card(kind, arg, origin);
  };
  const click = (el: Element | null | undefined, act: string) => el?.querySelector<HTMLButtonElement>(`button[data-act="${act}"]`)?.click();
  const tile = () => git.querySelector<HTMLElement>(".bento-ship");
  const row = (id: string) => tile()?.querySelector<HTMLElement>(`.ship-row[data-row="${id}"]`) ?? null;
  const proof = () => read("gh-proof.txt");
  try {
    c.showTab("git");
    // The live snapshot's ship lane, with the forge half read through the fixture gh.
    const live = () => !!snapshot.data?.shipLane?.remote?.available && !!row("tag-ci");
    await c.until(live, 60000);
    const t = tile();
    const ids = [...(t?.querySelectorAll<HTMLElement>(".ship-row") ?? [])].map((e) => e.dataset.row);
    const acts = (id: string) => [...(row(id)?.querySelectorAll<HTMLButtonElement>("button[data-act]") ?? [])].map((b) => b.dataset.act);
    const pr11 = t?.querySelector<HTMLElement>('.ship-pr[data-pr="11"]');
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
        !!pr11?.textContent?.includes("<img src=x") &&
        !t?.querySelector("img") &&
        noBars &&
        t?.dataset.gate === "",
      { version: snapshot.data?.dashboardDataVersion, rows: ids, actions: Object.fromEntries(ids.map((id) => [id, acts(String(id))])), gate: t?.dataset.gate },
    );
    await c.shot("git-cicd");

    // The action table and the engine gate, on fixed lanes (pure functions of the tile).
    const lane = (o: Record<string, unknown>) => ({ remote: { available: true, prs: [], ...((o.remote as object) ?? {}) }, local: { stagingAheadOfMain: 2, mainInStaging: true, ...((o.local as object) ?? {}) } });
    const promote = { number: 9, head: "staging", base: "main", draft: false };
    const cases: [string, unknown, string][] = [
      ["promote PR open -> merge with a merge commit", rowAction({ id: "staging-main", state: "pending" }, lane({ remote: { prs: [promote] } }))?.action, JSON.stringify({ kind: "merge-pr", args: { number: 9, method: "merge" } })],
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
