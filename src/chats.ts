// Saved agent chats of the opened folder (src-tauri/src/chats.rs): the Claude Code sessions
// started in this folder, newest first, for the Mission view's Chats card. A row resumes
// one in a terminal tab (`claude --resume <id>`, the cockpit host's resumeChat). Read on
// demand, never polled: when a folder opens, from the card's refresh button and when an
// interactive claude tab ends (that is when a session has been saved).
import { api, type ChatList, errText } from "./api";

class ChatStore {
  list: ChatList | null = null;
  error = "";
  loading = false;
  /** Drops the answer of a read that a newer one (or a folder switch) overtook. */
  private seq = 0;
  private listeners = new Set<() => void>();

  on(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  /** Forget the previous folder's list. */
  reset() {
    this.seq++;
    this.list = null;
    this.error = "";
    this.loading = false;
    this.changed();
  }

  async refresh() {
    const n = ++this.seq;
    this.loading = true;
    this.changed();
    try {
      const list = await api.chatSessions("claude");
      if (n !== this.seq) return;
      this.list = list;
      this.error = "";
    } catch (e) {
      if (n !== this.seq) return;
      this.list = null;
      this.error = errText(e);
    }
    this.loading = false;
    this.changed();
  }
}

export const chats = new ChatStore();
