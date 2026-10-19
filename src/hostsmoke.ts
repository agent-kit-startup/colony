// COLONY_SMOKE steps for host requests (called from runSmoke in main.ts, so this code runs
// only during the code-path smoke). With COLONY_GH_BIN=packaging/smoke/fake-gh.sh nothing
// reaches GitHub: a terminal tab files real `"$COLONY_HOST_CLI" request ...` calls, the
// smoke clicks the card buttons (the same handlers as the operator's clicks) and checks the
// requester's exit code and the fake gh's argv log.
import { api, errText } from "./api";
import { forgeApi } from "./forge";
import { hostApi, hostRequests } from "./hostreq";

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
    const badge = document.querySelector('.tab[data-tab="git"] .badge')?.textContent;
    const text = m7?.textContent ?? "";
    const runningShown = !!m7?.querySelector(".chip-running")?.getClientRects().length;
    await c.log("host-request-card", !!m7 && !runningShown && m7.dataset.production === "no" && text.includes("Smoke PR seven") && text.includes("feat/base ← feat/seven") && text.includes("smoke: checks are green") && badge === "1", { badge, runningShown, production: m7?.dataset.production, text: text.slice(0, 300) });
    await c.shot("git-request");
    click(m7, "approve");
    const out7 = await untilFile("hostreq-merge7.out", done, 20000);
    let proof = await read("gh-proof.txt");
    await c.log("host-request-approve", out7.includes("exit=0") && out7.includes("Merged pull request #7") && proof.includes("pr merge 7 --squash") && !find("merge-pr", 7), { out: out7, gh: proof.split("\n").filter((l) => l.startsWith("pr merge")) });

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
