// Oligarchy inside Colony (kit ADR 2026-11-17 oligarchy-web-game-data-contract-colony-pairing,
// points 1, 6 and 8): the game is the web page served from its origin, loaded in a sandboxed
// frame when the view is first shown. Colony runs no game engine. The page asks for the game
// data and Colony answers over the narrow channel of ./oligarchyfeed.ts (the ADR point 2 shape,
// posted to the exact game origin), then posts a fresh copy on every snapshot change. The frame
// gets no Tauri command or capability (none names its origin), navigation away from the game
// origin is refused by the CSP `frame-src` and by the webview's navigation check (src-tauri
// lib.rs), and offline (no answer to a HEAD request to the page) the view says the game needs the
// network instead of showing a blank frame or WebKit's error page.
import { h } from "./api";
import { type CockpitHost, View } from "./cockpit";
import { FRAME_SANDBOX, gameDataRequestHandler, gameUrl, OLIGARCHY_ORIGINS, postGameData } from "./oligarchyfeed";
import { snapshot } from "./snapshot";
import { btn, emptyCta } from "./ui";

/** How long the reachability request may take before the view says the game needs the network. */
const PROBE_MS = 8000;

export interface GameHost {
  /** Pick a folder (the game shown with no folder). */
  openFolder(): void;
  /** Back to the welcome screen, with no folder open. */
  welcome(): void;
}

export class OligarchyView extends View {
  /** The one origin this build loads the game from. */
  readonly origin = OLIGARCHY_ORIGINS[0];
  readonly url = gameUrl(this.origin) ?? "";
  private frame: HTMLIFrameElement | null = null;
  /** The folder the page last had data for: a folder switch reloads the page. */
  private loadedFor: string | null = null;
  /** The page asked for data at least once since it loaded (its live script is there). */
  private asked = false;
  /** Set by the window's offline event, cleared by its online event. */
  private netDown = false;
  /** A reachability request is running. */
  private probing = false;
  private readonly bar: HTMLElement;
  private readonly noFolder: HTMLElement[];
  private readonly offline: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly stage = h("div", { class: "oligarchy-stage", style: "display: contents" });

  constructor(host: CockpitHost, private game: GameHost) {
    super(host, "kv kv-oligarchy");
    this.noFolder = [
      btn("Open folder", () => this.game.openFolder(), { class: "status-bar-btn", "data-act": "open-folder", title: "Pick the folder whose shipped work feeds the game" }),
      btn("Back", () => this.game.welcome(), { class: "status-bar-btn", "data-act": "welcome", title: "Back to the welcome screen" }),
    ];
    this.bar = h(
      "div",
      { class: "oligarchy-bar" },
      h("span", { class: "dim small oligarchy-origin", title: this.url }, `Oligarchy · loaded from ${new URL(this.url).host}`),
      ...this.noFolder,
      btn("Reload", () => this.reload(), { class: "status-bar-btn", "data-act": "reload", title: "Load the game page again" }),
    );
    this.offline = emptyCta({
      icon: "colony",
      headline: "The game needs the network",
      support: `Oligarchy is a page loaded from ${new URL(this.url).host}. Colony shows it again when the network is back.`,
      actions: [{ label: "Try again", onClick: () => this.reload(), act: "retry", title: "Load the game page again" }],
    });
    this.offline.classList.add("oligarchy-offline");
    this.loading = h("div", { class: "oligarchy-offline dim small" }, `Loading the game from ${new URL(this.url).host}…`);
    const answer = gameDataRequestHandler(
      () => this.frame?.contentWindow,
      this.origin,
      () => this.ledger(),
    );
    window.addEventListener("message", (ev) => {
      // No folder: no answer, so the page plays the trial with its "no data" note.
      if (!this.host.workspaceRoot()) return;
      if (answer(ev)) this.asked = true;
    });
    window.addEventListener("online", () => {
      this.netDown = false;
      this.sync();
    });
    window.addEventListener("offline", () => {
      this.netDown = true;
      this.sync();
    });
  }

  /** The ledger of the open folder; null with no folder. */
  private ledger(): unknown {
    return this.host.workspaceRoot() ? snapshot.outcomeLedger : null;
  }

  /** Online now, as far as the webview knows. */
  private online(): boolean {
    return !this.netDown && navigator.onLine !== false;
  }

  /** Whether the frame or the network-needed state is on screen (for the smoke). */
  get state(): "frame" | "offline" | "loading" | "idle" {
    const s = this.el.dataset.state;
    return s === "frame" || s === "offline" || s === "loading" ? s : "idle";
  }

  get frameEl(): HTMLIFrameElement | null {
    return this.frame;
  }

  protected render(): Node[] {
    // Rendered once: later changes update these nodes in place, so the frame never reloads on
    // a snapshot change (moving an iframe in the DOM reloads it).
    return [this.bar, this.stage];
  }

  show() {
    super.show();
    this.sync();
  }

  /** Snapshot change, folder switch or server restart: no re-render, only the data and the state. */
  invalidate() {
    if (this.visible || this.frame) this.sync();
  }

  /** Load the page again (Reload, Try again). */
  reload() {
    this.frame?.remove();
    this.frame = null;
    this.sync();
  }

  /**
   * Load the page, after a HEAD request to the same address: WebKitGTK may report online with no
   * route out (navigator.onLine stays true), and a frame that fails to load shows WebKit's error
   * page, not ours. The request carries no cookie, no referrer and no data.
   */
  private async load(root: string) {
    if (this.probing) return;
    this.probing = true;
    this.el.dataset.state = "loading";
    this.stage.replaceChildren(this.loading);
    const stop = new AbortController();
    const timer = window.setTimeout(() => stop.abort(), PROBE_MS);
    let reached = false;
    try {
      await fetch(this.url, { method: "HEAD", mode: "no-cors", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: stop.signal });
      reached = true;
    } catch {
      reached = false;
    } finally {
      window.clearTimeout(timer);
      this.probing = false;
    }
    if (!reached) {
      this.stage.replaceChildren(this.offline);
      this.el.dataset.state = "offline";
      return;
    }
    if (this.frame || !this.visible || !this.online()) return this.sync();
    this.asked = false;
    this.loadedFor = root;
    // Sandbox before src: the first load already runs sandboxed.
    this.frame = h("iframe", { class: "oligarchy-frame", sandbox: FRAME_SANDBOX, referrerpolicy: "no-referrer", title: "Oligarchy", src: this.url });
    this.stage.replaceChildren(this.frame);
    this.el.dataset.state = "frame";
    // A folder opened or closed while the request ran: load for the folder open now.
    if (this.host.workspaceRoot() !== root) this.sync();
  }

  private sync() {
    const root = this.host.workspaceRoot();
    for (const b of this.noFolder) b.hidden = !!root;
    if (!this.online()) {
      // The page stays loaded if it is (its own state keeps running); a new load waits.
      if (!this.frame) {
        this.stage.replaceChildren(this.offline);
        this.el.dataset.state = "offline";
      }
      return;
    }
    if (this.frame && this.loadedFor !== root) {
      this.frame.remove();
      this.frame = null;
    }
    if (!this.frame) {
      if (this.visible) void this.load(root);
      return;
    }
    if (this.stage.firstChild !== this.frame) this.stage.replaceChildren(this.frame);
    this.el.dataset.state = "frame";
    if (this.asked && root) postGameData(this.frame.contentWindow, this.origin, this.ledger());
  }
}
