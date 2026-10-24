// COLONY_SMOKE steps for the saved chats (./chats.ts, src-tauri/src/chats.rs), called by
// the main smoke after the live launch steps. Fixture run: packaging/smoke/seed-chats.sh
// (from the bottom terminal, so it gets the smoke's scratch HOME) seeds the folder's
// Claude Code project folder with three sessions and a subagent transcript; the Mission
// view's Chats card lists exactly the three, newest first with their titles, and Resume
// opens fake-claude.sh with `--resume <id>`, then focuses that tab on a second click.
// Without the fixture only the read is checked (a real ~/.claude is never written).
import { api, errText } from "./api";
import { chats } from "./chats";

export interface ChatSmokeCtx {
  root: string;
  fixture: boolean;
  log(step: string, ok: boolean, detail?: unknown): Promise<unknown>;
  wait(ms: number): Promise<unknown>;
  until(cond: () => boolean, ms: number): Promise<boolean>;
  view(id: string): HTMLElement;
  shot(name: string): Promise<void>;
  showTab(id: string): void;
  term(line: string): Promise<void>;
  activeTab(): string;
  tabLabel(id: string): string;
  termCount(): number;
  closeTab(id: string): Promise<void>;
}

/** packaging/smoke/chats, newest first after seed-chats.sh. */
const SEEDED = [
  { id: "5e0b2c1a-7d4f-4a3b-9c2e-1f6a8b0d3c41", title: "Colony terminal chat", source: "custom" },
  { id: "6f1c3d2b-8e5a-4b4c-8d3f-2a7b9c1e4d52", title: "Synch plans with remote", source: "ai" },
  { id: "7a2d4e3c-9f6b-4c5d-9e4a-3b8c0d2f5e63", title: "List my saved chats please", source: "first-prompt" },
];

export async function chatSmoke(c: ChatSmokeCtx) {
  try {
    if (!c.fixture) {
      const l = await api.chatSessions("claude");
      await c.log("chats-list", l.status === "ok", { total: l.total, dir: l.dir, why: "no fixture: the real list is only read" });
      return;
    }
    const read = (rel: string) => api.readTextFile(`${c.root}/${rel}`).catch(() => "");
    const untilFile = async (rel: string, ok: (t: string) => boolean, ms: number) => {
      for (let i = 0; i < ms / 200; i++) {
        const t = await read(rel);
        if (ok(t)) return t;
        await c.wait(200);
      }
      return read(rel);
    };
    await c.term(`sh '${c.root}/packaging/smoke/seed-chats.sh' '${c.root}' > chats-seeded.txt 2>&1; echo "exit=$?" >> chats-seeded.txt\n`);
    const seeded = await untilFile("chats-seeded.txt", (t) => t.includes("exit="), 8000);

    // The card's refresh button reads them; exactly three rows, newest first. Chats live
    // in the Activity view (out of the one-fold Mission home).
    c.showTab("activity");
    const mission = c.view("activity");
    mission.querySelector<HTMLButtonElement>('[data-act="chats-refresh"]')?.click();
    const rows = () => [...mission.querySelectorAll<HTMLElement>(".chat-row")];
    await c.until(() => rows().length >= 3 && !chats.loading, 8000);
    await c.wait(200);
    const got = rows().map((r) => ({ id: r.dataset.chat ?? "", title: r.querySelector("strong, .dim")?.textContent ?? "", source: r.dataset.source ?? "" }));
    const count = mission.querySelector(".chat-row")?.closest(".card")?.querySelector(".card-count")?.textContent ?? "";
    mission.querySelector(".chat-row")?.closest(".card")?.scrollIntoView({ block: "center" });
    await c.shot("chats");
    await c.log("chats-list", seeded.includes("exit=0") && JSON.stringify(got) === JSON.stringify(SEEDED) && chats.list?.total === 3 && count === "3 saved", { seeded: seeded.trim(), rows: got, total: chats.list?.total, count });

    // Resume: a terminal tab with `claude --resume <id>` (fake-claude.sh records its argv),
    // labelled with the chat title; a second click focuses it instead of a second tab.
    const first = SEEDED[0];
    const termsBefore = c.termCount();
    rows()[0]?.querySelector<HTMLButtonElement>('button[data-act="resume"]')?.click();
    await c.until(() => c.termCount() > termsBefore && c.activeTab().startsWith("term:"), 5000);
    const tab = c.activeTab();
    const proof = await untilFile("interactive-proof.txt", (t) => t.includes("--resume"), 8000);
    const label = c.tabLabel(tab);
    c.showTab("activity");
    await c.wait(200);
    rows()[0]?.click();
    await c.wait(400);
    const again = { active: c.activeTab(), terms: c.termCount() };
    await c.log("chats-resume", proof.includes(`args: --resume ${first.id}\n`) && proof.includes(`cwd: ${c.root}`) && label === first.title && again.active === tab && again.terms === termsBefore + 1, { tab, label, proof: proof.trim(), again });
    await c.closeTab(tab);
  } catch (e) {
    await c.log("chats", false, errText(e));
  }
}
