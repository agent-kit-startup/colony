import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import "./styles.css";

interface WorkspaceInfo { root: string; name: string; isGit: boolean; hasKit: boolean; hasHandoff: boolean }
interface DashboardInfo { url: string; port: number; servePath: string; logPath: string }
interface StartupInfo { version: string; initialWorkspace: string | null; webkitDmabuf: string }

const app = document.getElementById("app")!;
app.innerHTML = `
  <div style="display:flex;flex-direction:column;height:100vh">
    <header style="display:flex;gap:8px;align-items:center;padding:6px 10px;border-bottom:1px solid var(--line);background:var(--bg-2)">
      <strong>Colony</strong><span id="ws" class="dim">no folder</span><span style="flex:1"></span>
      <button id="open" class="primary">Open folder</button>
    </header>
    <iframe id="mc" title="Mission Control" style="flex:1;border:0;background:#fff"></iframe>
    <footer id="status" class="dim" style="padding:3px 10px;border-top:1px solid var(--line)"></footer>
  </div>`;

const status = (t: string) => { document.getElementById("status")!.textContent = t; };

async function openWorkspace(path: string) {
  const ws = await invoke<WorkspaceInfo>("open_workspace", { path });
  document.getElementById("ws")!.textContent = ws.root;
  status("Starting Mission Control...");
  const mc = await invoke<DashboardInfo>("dashboard_start");
  (document.getElementById("mc") as HTMLIFrameElement).src = mc.url;
  status(`Mission Control ${mc.url}`);
}

document.getElementById("open")!.addEventListener("click", async () => {
  const picked = await open({ directory: true, multiple: false });
  if (typeof picked === "string") openWorkspace(picked).catch((e) => status(String(e)));
});

invoke<StartupInfo>("app_info").then((info) => {
  status(`Colony ${info.version} · WebKit DMA-BUF: ${info.webkitDmabuf}`);
  if (info.initialWorkspace) openWorkspace(info.initialWorkspace).catch((e) => status(String(e)));
});
