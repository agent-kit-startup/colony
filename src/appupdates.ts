// Settings → App updates (kit ADR 2026-10-24 amend 2026-11-19 points 6 and 7): the version,
// the distribution channel, the check and Update and restart (src-tauri/src/appupdate.rs),
// moved out of the About panel. Direct builds check the latest GitHub Release and install
// the signed AppImage in place; package builds say updates come from the package manager.
// Showing Settings reads the local status only: the GitHub check runs from the button or from
// Help → Check for updates, which opens Settings here and runs it (main.ts).
import { api, type AppUpdateInfo, type AppUpdateStatus, errText, h } from "./api";
import { btn } from "./ui";

/** What the update check found. */
export function updateText(u: AppUpdateInfo, s: AppUpdateStatus): string {
  if (!u.available) return `Colony ${u.current} is up to date.`;
  return `Colony ${u.available} is available (this is ${u.current}). ${s.canInstall ? "Install it with Update and restart." : s.note}`;
}

function row(label: string, value: string): HTMLElement {
  return h("div", { class: "settings-row" }, h("span", { class: "dim" }, label), h("span", {}, value));
}

export class AppUpdates {
  readonly el = h("div", { id: "settings-app-updates", class: "settings-body" });
  private readonly msg = h("div", { class: "settings-msg dim" });
  private state: AppUpdateStatus | null = null;
  private busy = false;

  /** `report`: the status bar. */
  constructor(private readonly report: (message: string) => void) {}

  /** Read the local status (no network) and render the rows. */
  async load(): Promise<AppUpdateStatus | null> {
    try {
      this.state = await api.appUpdateStatus();
    } catch (e) {
      this.el.replaceChildren(h("div", { class: "settings-msg bad" }, errText(e)));
      return null;
    }
    this.render(this.state);
    return this.state;
  }

  private render(s: AppUpdateStatus) {
    const actions = h("div", { class: "settings-actions" });
    if (s.canCheck) actions.append(btn("Check for updates", () => void this.check()));
    if (s.canInstall) actions.append(btn("Update and restart", () => void this.act("Downloading and verifying the update", () => api.appUpdateInstall())));
    this.el.replaceChildren(
      row("Version", s.version),
      row("Channel", s.channel === "direct" ? "direct (GitHub Releases)" : "package (distro package)"),
      row("Installed as", s.install),
      row("Updates", s.note),
      ...(actions.children.length ? [actions] : []),
      this.msg,
    );
  }

  private async act(label: string, run: () => Promise<string>) {
    if (this.busy) return;
    this.busy = true;
    this.msg.textContent = `${label}…`;
    this.msg.classList.remove("bad");
    try {
      const text = await run();
      this.msg.textContent = text;
      this.report(text);
    } catch (e) {
      this.msg.textContent = errText(e);
      this.msg.classList.add("bad");
      this.report(`Check for updates: ${errText(e)}`);
    } finally {
      this.busy = false;
    }
  }

  /** The check (the button, and Help → Check for updates). A build that cannot check (a
   *  package build, a development build) says where its updates come from. */
  async check() {
    const s = this.state ?? (await this.load());
    if (!s) return;
    if (!s.canCheck) {
      const text = `Colony ${s.version}: ${s.note}`;
      this.msg.textContent = text;
      this.report(text);
      return;
    }
    await this.act("Checking the latest GitHub Release", async () => updateText(await api.appUpdateCheck(), s));
  }
}
