// COLONY_SMOKE steps for the Explorer git workbench (plan colony-explorer-git-workbench x8):
// file-type glyphs and their theme colours, git marks after an edit, the tree keyboard map
// with F2 rename, drag-move refused onto an existing name, the commit graph drawing a merge,
// and a scripted conflict resolved through the conflict window. Called from runSmoke in
// main.ts after every other git step, so the history packaging/smoke/workbench-fixture.sh
// adds never meets them. Keys and pointer moves are DOM events dispatched on the tree (the
// same handlers as a person's keys and drags), never OS input. The conflict listing comes
// from a real kit (COLONY_SMOKE_KIT_REAL, see packaging/smoke/fake-agent-kit.sh); the
// DevOps proposal is the fixture's, so no agent session runs.
// The x9 dogfood checks (operator delegation, 2026-11-08) add: the glyph classes on the
// dogfood repo's file names, the glyphs following an Omarchy theme switch (only when the
// runner names a stock theme in COLONY_SMOKE_THEME_SWITCH, on a scratch HOME), ignored rows
// dimmed, a mark after an edit from the terminal and a window focus, Ctrl+click /
// Ctrl+Up/Down / Ctrl+Space, Backspace in the filter, Enter, F2 then Esc, the multi-select
// menu rows, the 1px-border-only selection, an open tab following a dragged file, the base
// read for both conflicted files, the marks clearing after the merge commit, and the graph's
// tag and upstream labels, keyboard, paging and the absence of history-rewriting actions.
import { api, errText } from "./api";
import { hostRequests } from "./hostreq";
import type { SmokeCtx } from "./hostsmoke";
import { omarchyDetected, omarchyTheme, skin } from "./skin";

export interface WorkSmokeCtx extends SmokeCtx {
  tree: { refresh(): Promise<void>; reveal(path: string, isDir: boolean): Promise<void>; refreshMarks(): void };
  /** The status bar's current message. */
  statusText: () => string;
}

const CLASS_TOKEN: Record<string, string> = { dir: "--blue", code: "--green", config: "--yellow", docs: "--cyan", image: "--purple", archive: "--red", exec: "--orange", other: "--text-muted" };

export async function workbenchSmoke(c: WorkSmokeCtx) {
  const tree = document.getElementById("tree")!;
  const abs = (rel: string) => `${c.root}/${rel}`;
  const rel = (p: string) => (p.startsWith(`${c.root}/`) ? p.slice(c.root.length + 1) : p);
  const read = (r: string) => api.readTextFile(abs(r)).catch(() => null);
  const rowOf = (r: string) => tree.querySelector<HTMLElement>(`.tree-row[data-path="${CSS.escape(abs(r))}"]`);
  const markOf = (r: string) => rowOf(r)?.querySelector<HTMLElement>(".git-mark")?.dataset.mark ?? "";
  const focused = () => rel(tree.querySelector<HTMLElement>(".tree-row.focused")?.dataset.path ?? "");
  const visible = () => [...tree.querySelectorAll<HTMLElement>(".tree-row[data-path]")].filter((r) => !r.hidden);
  const key = async (k: string, mods: KeyboardEventInit = {}) => {
    tree.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
    await c.wait(120);
  };
  const untilAsync = async (cond: () => Promise<boolean>, ms: number) => {
    for (let i = 0; i < ms / 200; i++) {
      if (await cond()) return true;
      await c.wait(200);
    }
    return cond();
  };
  const untilFile = async (r: string, ok: (t: string) => boolean, ms: number) => {
    await untilAsync(async () => ok((await read(r)) ?? ""), ms);
    return (await read(r)) ?? "";
  };
  // A fixture run in the terminal tab: its output and exit code land in <out>.
  const fixture = async (args: string, out: string) => {
    await c.term(`sh packaging/smoke/workbench-fixture.sh ${args} > ${out} 2>&1; echo "exit=$?" >> ${out}\n`);
    return untilFile(out, (t) => t.includes("exit="), 20000);
  };
  const marksAfter = async (want: Record<string, string>, ms = 8000) => {
    c.tree.refreshMarks();
    await c.until(() => Object.entries(want).every(([r, m]) => markOf(r) === m), ms);
    return Object.fromEntries(Object.keys(want).map((r) => [r, markOf(r)]));
  };
  const tokenColour = (v: string) => {
    const s = document.createElement("span");
    s.style.color = `var(${v})`;
    document.body.append(s);
    const col = getComputedStyle(s).color;
    s.remove();
    return col;
  };
  const hexRgb = (hex: string | undefined) => {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex ?? "");
    return m ? `rgb(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)})` : "";
  };
  const iconOf = (r: string) => rowOf(r)?.querySelector<SVGElement>("svg.file-icon") ?? null;
  /** Rows whose glyph colour is not their class's skin token right now. */
  const offToken = (paths: string[]) =>
    paths.filter((p) => {
      const svg = iconOf(p);
      return !svg || getComputedStyle(svg).color !== tokenColour(CLASS_TOKEN[svg.dataset.class ?? "other"] ?? "--text-muted");
    });
  try {
    c.showTab("mission");
    await c.tree.refresh();

    // x3: every row has a bundled glyph, coloured by its file class from the theme tokens.
    {
      const rows = visible();
      const icons = rows.map((r) => r.querySelector<SVGElement>("svg.file-icon"));
      const noGlyph = rows.filter((_, i) => !icons[i]?.dataset.glyph || !icons[i]?.querySelector("path")).map((r) => rel(r.dataset.path ?? ""));
      const wrongColour = rows
        .map((r, i) => ({ r, svg: icons[i] }))
        .filter(({ r, svg }) => svg && !r.classList.contains("git-ignored") && getComputedStyle(svg).color !== tokenColour(CLASS_TOKEN[svg.dataset.class ?? "other"] ?? "--text-muted"))
        .map(({ r, svg }) => `${rel(r.dataset.path ?? "")}:${svg?.dataset.class}`);
      const classes = [...new Set(icons.map((s) => s?.dataset.class ?? ""))].sort();
      const colours = new Set(icons.filter((s) => s && !s.closest(".git-ignored")).map((s) => getComputedStyle(s!).color));
      const sample = Object.fromEntries(["README.md", "package.json", "packages", "LICENSE"].map((r) => [r, `${rowOf(r)?.querySelector<SVGElement>("svg.file-icon")?.dataset.glyph ?? "-"}/${rowOf(r)?.querySelector<SVGElement>("svg.file-icon")?.dataset.class ?? "-"}`]));
      await c.log("explorer-glyphs", rows.length > 0 && !noGlyph.length && !wrongColour.length && classes.includes("dir") && colours.size >= 3, { rows: rows.length, classes, colours: colours.size, sample, noGlyph: noGlyph.slice(0, 10), wrongColour: wrongColour.slice(0, 10) });
    }

    // x9 step 2: the dogfood repo's names get the classes its steps list (folders blue, code
    // green, config yellow, docs cyan, images purple, executables orange), in the skin's tokens.
    const look = "smoke-look";
    const lookWant: Record<string, string> = {
      [look]: "dir",
      [`${look}/src`]: "dir",
      [`${look}/src/main.ts`]: "code",
      [`${look}/app.conf`]: "config",
      [`${look}/package.json`]: "config",
      [`${look}/.gitignore`]: "config",
      [`${look}/README.md`]: "docs",
      [`${look}/docs/notes.md`]: "docs",
      [`${look}/assets/logo.svg`]: "image",
      [`${look}/build.sh`]: "exec",
    };
    {
      const files: Record<string, string> = {
        "src/main.ts": "export const main = 1;\n",
        "app.conf": "name = colony\n",
        "package.json": "{}\n",
        ".gitignore": "node_modules/\n",
        "README.md": "# look\n",
        "docs/notes.md": "notes\n",
        "assets/logo.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n",
        "build.sh": "#!/bin/sh\necho build\n",
      };
      for (const d of [look, `${look}/src`, `${look}/docs`, `${look}/assets`]) await api.createDir(abs(d));
      for (const [f, t] of Object.entries(files)) await api.writeTextFile(abs(`${look}/${f}`), t);
      for (const f of Object.keys(files)) await c.tree.reveal(abs(`${look}/${f}`), false);
      const got = Object.fromEntries(Object.keys(lookWant).map((p) => [p, iconOf(p)?.dataset.class ?? "-"]));
      const wrongClass = Object.entries(lookWant).filter(([p, k]) => got[p] !== k).map(([p, k]) => `${p}: ${got[p]} (want ${k})`);
      const wrong = offToken(Object.keys(lookWant));
      await c.log("explorer-look", !wrongClass.length && !wrong.length, { skin: skin(), classes: got, wrongClass, wrongColour: wrong });
    }

    // x9 step 2: switch the Omarchy theme and the glyphs follow. The switch is the fixture's
    // copy of a stock theme's colors.toml over the HOME's current one (what omarchy-theme-set
    // leaves behind), run only when the runner names the theme in COLONY_SMOKE_THEME_SWITCH,
    // so a run on a real HOME never touches its theme. Then the original comes back.
    {
      const code = `${look}/src/main.ts`;
      const colourOf = (p: string) => {
        const svg = iconOf(p);
        return svg ? getComputedStyle(svg).color : "";
      };
      const before = { theme: omarchyTheme()?.name ?? null, green: tokenColour("--green"), icon: colourOf(code) };
      if (!omarchyDetected() || skin() !== "omarchy") {
        await c.log("explorer-theme", true, { skip: "not on the Omarchy skin (no Omarchy theme under HOME)", skin: skin() });
      } else {
        const out = await fixture("theme", "workbench-theme.out");
        if (out.includes("skip:")) {
          await c.log("explorer-theme", true, { skip: out.trim().split("\n")[0], before });
        } else {
          const switched = await c.until(() => tokenColour("--green") !== before.green && colourOf(code) !== before.icon, 15000);
          const t = omarchyTheme();
          const after = { theme: t?.name ?? null, green: tokenColour("--green"), icon: colourOf(code), themeGreen: hexRgb(t?.tokens["--green"]) };
          const wrong = offToken(Object.keys(lookWant));
          const back = await fixture("theme-restore", "workbench-theme-restore.out");
          const restored = await c.until(() => tokenColour("--green") === before.green && colourOf(code) === before.icon, 15000);
          await c.log("explorer-theme", out.includes("exit=0") && switched && after.icon === after.green && after.icon === after.themeGreen && !wrong.length && back.includes("exit=0") && restored, {
            fixture: out.trim().split("\n")[0],
            before,
            after,
            wrongColour: wrong,
            restored,
          });
        }
      }
    }

    // x2: marks follow an edit (M), a new file (U, and its folder), and the edit undone.
    {
      const tracked = "LICENSE";
      const before = (await read(tracked)) ?? "";
      await api.writeTextFile(abs(tracked), `${before}\n`);
      await api.createDir(abs("smoke-marks"));
      await api.writeTextFile(abs("smoke-marks/new.txt"), "new\n");
      await c.tree.reveal(abs("smoke-marks/new.txt"), false);
      const edited = await marksAfter({ [tracked]: "M", "smoke-marks": "U", "smoke-marks/new.txt": "U" });
      await api.writeTextFile(abs(tracked), before);
      const undone = await marksAfter({ [tracked]: "" });
      // x9 step 3: an ignored file (the kit's .gitignore has *.pem) is dimmed, with no letter.
      const ign = "smoke-x9.pem";
      await api.writeTextFile(abs(ign), "ignored\n");
      await c.tree.reveal(abs(ign), false);
      c.tree.refreshMarks();
      const dimmed = await c.until(() => !!rowOf(ign)?.classList.contains("git-ignored"), 8000);
      const ignName = rowOf(ign)?.querySelector<HTMLElement>(".name");
      const ignored = { dimmed, letter: markOf(ign), name: ignName ? getComputedStyle(ignName).color : "", muted: tokenColour("--text-muted") };
      // x9 step 3: an edit from the terminal shows once the window has the focus again (the
      // focus handler's refresh, no explicit one here), and goes when the file is put back.
      await c.term(`printf '\\n' >> ${tracked}\n`);
      await untilFile(tracked, (t) => t !== before, 5000);
      window.dispatchEvent(new Event("focus"));
      const onFocus = await c.until(() => markOf(tracked) === "M", 8000);
      await api.writeTextFile(abs(tracked), before);
      window.dispatchEvent(new Event("focus"));
      const offFocus = await c.until(() => markOf(tracked) === "", 8000);
      await c.log("git-marks", edited[tracked] === "M" && edited["smoke-marks"] === "U" && edited["smoke-marks/new.txt"] === "U" && undone[tracked] === "" && ignored.dimmed && ignored.letter === "" && ignored.name === ignored.muted && onFocus && offFocus, { edited, undone, ignored, terminalEdit: { onFocus, offFocus } });
    }

    // x4: the tree's keyboard map, the type-ahead filter and F2 rename.
    {
      const d = "smoke-keys";
      await api.createDir(abs(d));
      await api.createDir(abs(`${d}/inner`));
      for (const f of [`${d}/inner/x.txt`, `${d}/zz-alpha.txt`, `${d}/zz-beta.txt`]) await api.writeTextFile(abs(f), `${f}\n`);
      await c.tree.reveal(abs(`${d}/zz-alpha.txt`), false);
      tree.focus();
      const r: Record<string, unknown> = { start: focused() };
      await key("ArrowDown");
      r.down = focused() === `${d}/zz-beta.txt`;
      await key("ArrowUp");
      r.up = focused() === `${d}/zz-alpha.txt`;
      await key("ArrowDown", { shiftKey: true });
      r.shiftSelect = tree.querySelectorAll(".tree-row.selected").length === 2;
      await key("ArrowUp");
      await key("ArrowUp");
      r.onDir = focused() === `${d}/inner`;
      await key("ArrowRight");
      r.expand = await c.until(() => !!rowOf(`${d}/inner/x.txt`), 3000);
      await key("ArrowRight");
      r.firstChild = focused() === `${d}/inner/x.txt`;
      await key("ArrowLeft");
      r.parent = focused() === `${d}/inner`;
      await key("ArrowLeft");
      r.collapse = await c.until(() => !rowOf(`${d}/inner/x.txt`), 3000);
      await key("Home");
      r.home = focused() === rel(visible()[0]?.dataset.path ?? "");
      await key("End");
      r.end = focused() === rel(visible().at(-1)?.dataset.path ?? "");
      const all = visible().length;
      for (const ch of "zz-b") await key(ch);
      const filter = tree.querySelector<HTMLElement>(".tree-filter");
      const shown = visible().filter((row) => row.classList.contains("file")).map((row) => rel(row.dataset.path ?? ""));
      r.filter = filter?.textContent === "zz-b" && !filter.hidden && focused() === `${d}/zz-beta.txt` && shown.length > 0 && shown.every((p) => p.split("/").pop()!.includes("zz-b"));
      r.filtered = `${all} -> ${visible().length}`;
      await key("Escape");
      r.cleared = !!filter?.hidden && visible().length === all && focused() === `${d}/zz-beta.txt`;
      await key("F2");
      const input = await c.until(() => document.activeElement?.classList.contains("tree-input") ?? false, 3000);
      if (input) {
        const el = document.activeElement as HTMLInputElement;
        el.value = "zz-gamma.txt";
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      }
      r.rename = input && (await untilAsync(async () => (await read(`${d}/zz-gamma.txt`)) !== null && (await read(`${d}/zz-beta.txt`)) === null, 4000));
      const ok = ["down", "up", "shiftSelect", "onDir", "expand", "firstChild", "parent", "collapse", "home", "end", "filter", "cleared", "rename"].every((k) => r[k] === true);
      await c.log("explorer-keyboard", ok, r);
    }

    // x9 step 4: the rest of the selection keys, the multi-select menu, Enter, F2 then Esc,
    // and the selection drawn as a 1px border colour only (no bar, no tinted background).
    {
      const d = "smoke-keys";
      const a = `${d}/zz-alpha.txt`;
      const g = `${d}/zz-gamma.txt`;
      await c.tree.reveal(abs(a), false);
      tree.focus();
      const sel = () => [...tree.querySelectorAll<HTMLElement>(".tree-row.selected")].map((row) => rel(row.dataset.path ?? "")).sort().join(",");
      const click = async (p: string, mods: MouseEventInit = {}) => {
        rowOf(p)?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...mods }));
        await c.wait(150);
      };
      const r: Record<string, unknown> = { start: sel() };
      await click(g, { ctrlKey: true });
      r.ctrlClickAdd = sel() === `${a},${g}`;
      await click(g, { ctrlKey: true });
      r.ctrlClickRemove = sel() === a;
      // Ctrl+Up moves the cursor (gamma -> alpha -> inner) and leaves the selection alone;
      // Ctrl+Space then adds the focused row.
      const inner = `${d}/inner`;
      await key("ArrowUp", { ctrlKey: true });
      await key("ArrowUp", { ctrlKey: true });
      r.ctrlUpKeeps = focused() === inner && sel() === a;
      await key(" ", { ctrlKey: true });
      r.ctrlSpace = sel() === `${inner},${a}`;
      // The 1px border rule on a selected row against a plain one.
      const plain = rowOf(g);
      const st = (el: HTMLElement | null) => {
        const cs = el ? getComputedStyle(el) : null;
        return cs ? { bg: cs.backgroundColor, left: cs.borderLeftWidth, right: cs.borderRightWidth, top: cs.borderTopWidth, shadow: cs.boxShadow, border: cs.borderLeftColor } : null;
      };
      const sSel = st(rowOf(a));
      const sPlain = st(plain);
      r.style = { selected: sSel, plain: sPlain };
      r.borderOnly = !!sSel && !!sPlain && sSel.bg === sPlain.bg && sSel.left === "1px" && sSel.right === "1px" && sSel.top === "1px" && sSel.shadow === "none" && sSel.border !== sPlain.border;
      // Right-click inside a two-row selection: the rows act on both.
      const gr = rowOf(a)?.getBoundingClientRect();
      rowOf(a)?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: (gr?.left ?? 0) + 20, clientY: (gr?.top ?? 0) + (gr?.height ?? 0) / 2 }));
      const menuRow = (act: string) => document.querySelector<HTMLButtonElement>(`#tree-menu:not([hidden]) button[data-act="${act}"]`)?.textContent ?? "";
      r.menu = { delete: menuRow("tree-delete"), copy: menuRow("tree-copy-path") };
      r.multiMenu = menuRow("tree-delete") === "Delete 2 items" && menuRow("tree-copy-path") === "Copy 2 paths";
      window.dispatchEvent(new Event("click"));
      r.menuClosed = !!document.getElementById("tree-menu")?.hidden;
      // Backspace edits the type-ahead filter; Esc clears it.
      for (const ch of "zz-g") await key(ch);
      await key("Backspace");
      const filter = tree.querySelector<HTMLElement>(".tree-filter");
      r.backspace = filter?.textContent === "zz-" && !filter.hidden;
      await key("Escape");
      r.filterCleared = !!filter?.hidden;
      // F2 then Esc: the field closes and the name stays.
      await c.tree.reveal(abs(a), false);
      tree.focus();
      r.onAlpha = focused() === a && sel() === a;
      await key("F2");
      const input = await c.until(() => document.activeElement?.classList.contains("tree-input") ?? false, 3000);
      if (input) (document.activeElement as HTMLInputElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      r.renameCancelled = input && (await c.until(() => !tree.querySelector(".tree-input"), 3000)) && (await read(a)) !== null;
      // Enter opens the focused file in an editor tab.
      tree.focus();
      await key("Enter");
      r.enterOpens = await c.until(() => c.activeTab() === abs(a), 4000);
      const ok = ["ctrlClickAdd", "ctrlClickRemove", "ctrlUpKeeps", "ctrlSpace", "borderOnly", "multiMenu", "menuClosed", "backspace", "filterCleared", "onAlpha", "renameCancelled", "enterOpens"].every((k) => r[k] === true);
      await c.log("explorer-select", ok, r);
    }

    // x5: drag two selected rows onto a folder that already has one of the names: the other
    // moves, the existing one is refused and left as it was.
    {
      const d = "smoke-drag";
      await api.createDir(abs(d));
      await api.createDir(abs(`${d}/sub`));
      await api.writeTextFile(abs(`${d}/sub/a.txt`), "existing\n");
      await api.writeTextFile(abs(`${d}/a.txt`), "dragged a\n");
      await api.writeTextFile(abs(`${d}/b.txt`), "dragged b\n");
      await c.tree.reveal(abs(`${d}/sub/a.txt`), false);
      // x9 step 5: b.txt is open in an editor tab before the drag; the tab follows it.
      await c.tree.reveal(abs(`${d}/b.txt`), false);
      rowOf(`${d}/b.txt`)?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      const tabOpen = await c.until(() => c.activeTab() === abs(`${d}/b.txt`), 4000);
      await c.tree.reveal(abs(`${d}/a.txt`), false);
      tree.focus();
      await key("ArrowDown", { shiftKey: true });
      const selected = [...tree.querySelectorAll<HTMLElement>(".tree-row.selected")].map((row) => rel(row.dataset.path ?? ""));
      const src = rowOf(`${d}/a.txt`);
      const dst = rowOf(`${d}/sub`);
      src?.scrollIntoView({ block: "center" });
      await c.wait(150);
      const at = (el: HTMLElement | null) => {
        const b = el?.getBoundingClientRect();
        return b ? { clientX: b.left + Math.min(40, b.width / 2), clientY: b.top + b.height / 2 } : { clientX: 0, clientY: 0 };
      };
      const p0 = at(src);
      const p1 = at(dst);
      const pe = (type: string, p: { clientX: number; clientY: number }) => new PointerEvent(type, { ...p, button: 0, buttons: type === "pointerup" ? 0 : 1, isPrimary: true, pointerId: 1, pointerType: "mouse", bubbles: true, cancelable: true });
      src?.dispatchEvent(pe("pointerdown", p0));
      window.dispatchEvent(pe("pointermove", { clientX: p0.clientX, clientY: (p0.clientY + p1.clientY) / 2 }));
      window.dispatchEvent(pe("pointermove", p1));
      const target = !!dst?.classList.contains("drop-target");
      window.dispatchEvent(pe("pointerup", p1));
      const moved = await untilAsync(async () => (await read(`${d}/sub/b.txt`)) === "dragged b\n" && (await read(`${d}/b.txt`)) === null, 5000);
      const kept = (await read(`${d}/a.txt`)) === "dragged a\n" && (await read(`${d}/sub/a.txt`)) === "existing\n";
      const notice = c.statusText();
      const tabFollows = tabOpen && (await c.until(() => c.activeTab() === abs(`${d}/sub/b.txt`), 4000));
      await c.log("drag-move-refused", selected.length === 2 && target && moved && kept && notice.includes("not moved") && notice.includes("a.txt") && tabFollows, { selected, target, moved, kept, notice, tabOpen, tabFollows, activeTab: rel(c.activeTab()) });
    }

    // x6: a merge made in the terminal shows in the graph (merge dot, HEAD, labels), and a
    // click shows the merge's details and a file's diff.
    {
      const out = await fixture("graph", "workbench-graph.out");
      window.dispatchEvent(new Event("focus")); // back from a terminal: the graph reloads
      c.showTab("git");
      const git = c.view("git");
      const mergeRow = () => [...git.querySelectorAll<HTMLElement>(".gg-row")].find((row) => row.querySelector(".gg-subject")?.textContent?.startsWith("Merge branch 'smoke/graph-feature'"));
      const drawn = await c.until(() => !!mergeRow(), 15000);
      const row = mergeRow();
      const g = {
        fixture: out.trim().split("\n").at(-1),
        rows: git.querySelectorAll(".gg-row").length,
        mergeDot: !!row?.querySelector('.gg-dot[r="3"]'),
        lines: row?.querySelectorAll(".gg-line").length ?? 0,
        head: !!row?.classList.contains("is-head") && !!row?.querySelector(".gg-ref.is-head"),
        sideLabel: [...git.querySelectorAll(".gg-ref")].some((r) => r.textContent === "smoke/graph-feature"),
        detail: "",
        diff: "",
      };
      row?.click();
      const detail = git.querySelector<HTMLElement>(".gg-detail");
      await c.until(() => !!detail && !detail.hidden && (detail.textContent ?? "").includes("Merge of"), 8000);
      g.detail = (detail?.textContent ?? "").slice(0, 160);
      const file = [...(detail?.querySelectorAll<HTMLElement>(".git-file") ?? [])].find((f) => f.textContent?.includes("smoke-graph/feature.txt"));
      file?.click();
      await c.until(() => (detail?.querySelector(".git-diff:not([hidden]) .git-out")?.textContent ?? "").includes("+one"), 8000);
      g.diff = (detail?.querySelector(".git-out")?.textContent ?? "").slice(-80);
      detail?.querySelector<HTMLButtonElement>(".gg-close")?.click();
      // x9 step 7: tag and upstream labels, Up/Down + Enter + Esc on the rows, no rebase /
      // cherry-pick / reset action, and a second page when the history has one.
      const x9: Record<string, unknown> = {
        tag: [...git.querySelectorAll(".gg-ref-tag")].some((r) => r.textContent === "v6.9.0"),
        upstream: [...git.querySelectorAll<HTMLElement>(".gg-ref.is-upstream")].map((r) => r.textContent).join(","),
      };
      const kd = (el: Element | null, k: string) => el?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
      row?.focus();
      kd(row ?? null, "ArrowDown");
      const next = document.activeElement as HTMLElement | null;
      x9.keyDown = !!next?.classList.contains("gg-row") && next !== row;
      kd(next, "Enter");
      x9.keyEnter = await c.until(() => !!detail && !detail.hidden && !!next?.classList.contains("is-selected"), 8000);
      kd(next, "Escape");
      x9.keyEsc = await c.until(() => !!detail?.hidden, 3000);
      const gg = git.querySelector<HTMLElement>(".gg");
      x9.rewriteActions = [...(gg?.querySelectorAll<HTMLButtonElement>("button") ?? [])].map((b) => b.textContent ?? "").filter((t) => /rebase|cherry|reset|checkout/i.test(t));
      const more = git.querySelector<HTMLButtonElement>(".gg-more");
      const count = () => git.querySelectorAll(".gg-row").length;
      if (more && !more.hidden) {
        const n = count();
        more.click();
        x9.loadMore = (await c.until(() => count() > n, 10000)) ? `${n} -> ${count()}` : false;
      } else x9.loadMore = `one page (${count()} rows)`;
      Object.assign(g, { x9 });
      const x9ok = x9.tag === true && !!x9.upstream && x9.keyDown === true && x9.keyEnter === true && x9.keyEsc === true && (x9.rewriteActions as string[]).length === 0 && x9.loadMore !== false;
      await c.log("graph-merge", out.includes("exit=0") && drawn && g.mergeDot && g.lines >= 2 && g.head && g.sideLabel && g.detail.includes("Merge of") && g.diff.includes("+one") && x9ok, g);
    }

    // x7: a merge stopped on two files, resolved in the conflict window: one file with the
    // DevOps proposal (stubbed propose), one with a manual edit; each saved, then staged
    // through its stage-resolved card; the commit stays with the operator (the fixture here).
    {
      const out = await fixture("conflict", "workbench-conflict.out");
      const cfg = "smoke-merge/config.ts";
      const conf = "smoke-merge/app.conf";
      await c.tree.reveal(abs(cfg), false);
      const marked = await marksAfter({ [cfg]: "!", [conf]: "!" });
      const r: Record<string, unknown> = { fixture: out.includes("exit=0"), marked };
      rowOf(cfg)?.querySelector<HTMLElement>(".git-mark")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      const win = () => document.querySelector<HTMLElement>(".cv-conflicts");
      await c.until(() => !!win() && (win()!.querySelectorAll(".cf-file").length === 2 || !!win()!.querySelector(".cf-head .hint.warn")), 15000);
      const warn = win()?.querySelector(".cf-head .hint.warn")?.textContent ?? "";
      if (!win() || warn) {
        // No kit with `conflicts` (COLONY_SMOKE_KIT_REAL unset): only the window's refusal is checked.
        const noKit = warn.includes("agent-kit conflicts");
        await c.term(`git merge --abort\n`);
        await c.log("conflict-window", noKit, { ...r, skip: noKit ? "no kit with `agent-kit conflicts` (set COLONY_SMOKE_KIT_REAL)" : null, warn });
      } else {
        const w = win()!;
        const sel = () => w.querySelector(".cf-file.is-selected")?.textContent ?? "";
        const btnIn = (scope: ParentNode, s: string) => scope.querySelector<HTMLButtonElement>(s);
        const stageAndApprove = async (path: string) => {
          btnIn(w, '[data-act="cf-stage"]')?.click();
          const req = await c.until(() => hostRequests.items.some((i) => i.kind === "stage-resolved" && i.args.path === path), 8000);
          const id = hostRequests.items.find((i) => i.kind === "stage-resolved" && i.args.path === path)?.id ?? "";
          const card = () => c.view("git").querySelector<HTMLElement>(`.hostreq-card[data-id="${id}"]`);
          await c.until(() => !!card()?.querySelector<HTMLButtonElement>('button[data-act="approve"]:not([disabled])'), 8000);
          card()?.querySelector<HTMLButtonElement>('button[data-act="approve"]')?.click();
          const staged = await untilAsync(async () => (await api.gitStatus()).files.some((f) => f.path === path && f.xy === "M "), 8000);
          c.showTab("conflicts");
          return { req, staged };
        };
        r.opened = sel().includes(cfg);
        r.sides = (w.querySelector(".cf-sides")?.textContent ?? "").replace(/\s+/g, " ").slice(0, 160);
        r.abortShown = !btnIn(w, '[data-act="cf-abort"]')?.hidden;
        r.cfgBase = w.querySelector(".cf-body .panel-row .dim.small")?.textContent ?? "";
        r.cfgBasePane = w.querySelector(".cf-hunk .cf-base summary")?.textContent ?? "";
        // config.ts: Ask DevOps (fixture proposal: theirs then ours), pick it, save, stage.
        btnIn(w, '[data-act="cf-propose"]')?.click();
        r.proposal = await c.until(() => !!w.querySelector(".cf-proposal.is-accepted") && !!btnIn(w, '[data-pick="proposal"]'), 15000);
        r.proposalSummary = w.querySelector(".cf-proposal-summary")?.textContent?.slice(0, 160) ?? "";
        // x9 step 6: the hunk names the proposal and its rationale; the status line says nothing changed yet.
        r.proposalText = [...w.querySelectorAll<HTMLElement>(".cf-proposal .small")].map((e) => e.textContent ?? "").find((t) => t.startsWith("DevOps proposal")) ?? "";
        r.proposeStatus = c.statusText();
        btnIn(w, '[data-pick="proposal"]')?.click();
        await c.until(() => !btnIn(w, '[data-act="cf-save"]')?.disabled, 3000);
        btnIn(w, '[data-act="cf-save"]')?.click();
        const cfgWant = 'export const mode = "prod";\nexport const mode = "staging";\nexport const retries = 3;\n';
        r.cfgSaved = (await untilFile(cfg, (t) => t === cfgWant, 5000)) === cfgWant;
        await c.until(() => !btnIn(w, '[data-act="cf-stage"]')?.disabled, 3000);
        r.cfgStage = await stageAndApprove(cfg);
        // app.conf: a manual edit in the result field, save, stage.
        [...w.querySelectorAll<HTMLElement>(".cf-file")].find((f) => f.textContent?.includes(conf))?.click();
        // The body re-renders after the file is read: wait for its own path, not the last file's.
        await c.until(() => sel().includes(conf) && w.querySelector(".cf-body .panel-row strong")?.textContent === conf && !!w.querySelector(".cf-result"), 5000);
        r.confBase = w.querySelector(".cf-body .panel-row .dim.small")?.textContent ?? "";
        r.confBasePane = w.querySelector(".cf-hunk .cf-base summary")?.textContent ?? "";
        r.confHunks = w.querySelectorAll(".cf-hunk").length;
        const res = w.querySelector<HTMLTextAreaElement>(".cf-result");
        if (res) {
          res.value = "port = 9091\n";
          res.dispatchEvent(new Event("input", { bubbles: true }));
          res.dispatchEvent(new Event("change", { bubbles: true }));
        }
        await c.until(() => !btnIn(w, '[data-act="cf-save"]')?.disabled, 3000);
        btnIn(w, '[data-act="cf-save"]')?.click();
        const confWant = "name = colony\nport = 9091\nlog = info\n";
        r.confSaved = (await untilFile(conf, (t) => t === confWant, 5000)) === confWant;
        await c.until(() => !btnIn(w, '[data-act="cf-stage"]')?.disabled, 3000);
        r.confStage = await stageAndApprove(conf);
        btnIn(w, '[data-act="cf-reload"]')?.click();
        r.noneLeft = await c.until(() => (w.querySelector(".cf-head strong")?.textContent ?? "") === "No conflicts", 10000);
        const after = await marksAfter({ [cfg]: "M", [conf]: "M" });
        r.marksAfter = after;
        const commit = await fixture("commit", "workbench-commit.out");
        r.commit = commit.trim().split("\n").slice(-2).join(" | ");
        // x9 step 6: the commit clears the marks of both files and their folder.
        r.marksCommitted = await marksAfter({ [cfg]: "", [conf]: "", "smoke-merge": "" });
        const cleared = Object.values(r.marksCommitted as Record<string, string>).every((m) => m === "");
        const stg = (x: unknown) => (x as { req?: boolean; staged?: boolean } | undefined) ?? {};
        const ok =
          r.fixture === true && marked[cfg] === "!" && marked[conf] === "!" && r.opened === true && r.abortShown === true && r.proposal === true && r.cfgSaved === true && stg(r.cfgStage).req === true && stg(r.cfgStage).staged === true && r.confSaved === true && stg(r.confStage).req === true && stg(r.confStage).staged === true && r.noneLeft === true && commit.includes("exit=0") && r.cfgBase === "base from index" && r.confBase === "base from index" && String(r.cfgBasePane).startsWith("base") && String(r.confBasePane).startsWith("base") && cleared && String(r.proposalText).startsWith("DevOps proposal: ") && String(r.proposeStatus).includes("nothing changed until you pick one");
        await c.log("conflict-window", ok, r);
      }
    }
  } catch (e) {
    await c.log("workbench-smoke", false, errText(e));
  }
}
