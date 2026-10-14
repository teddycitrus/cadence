import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ChromeConnection } from "./chrome";
import { BrowserTab } from "./tab";

/**
 * The built-in browser: one Chrome (with a profile kept in the data dir, so
 * sign-ins persist like a normal browser) and tabs per workspace. Tab 0 is
 * the one agents drive; people can open more beside it.
 */
export class BuiltInBrowser {
  private chrome: Promise<ChromeConnection> | null = null;
  private tabs = new Map<string, Promise<BrowserTab>>();

  constructor(private dataDir: string) {}

  private connection(): Promise<ChromeConnection> {
    this.chrome ??= (async () => {
      const profile = join(this.dataDir, "browser-profile");
      mkdirSync(profile, { recursive: true });
      const chrome = await ChromeConnection.launch(profile);
      // Files never download onto the host from here.
      await chrome.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => undefined);
      chrome.onClose(() => {
        this.chrome = null;
        this.tabs.clear();
      });
      return chrome;
    })().catch((err) => {
      this.chrome = null;
      throw err;
    });
    return this.chrome;
  }

  static readonly MAX_TABS = 8;

  private key = (workspaceId: string, index: number) => (index ? `${workspaceId}#${index}` : workspaceId);

  /** One of the workspace's tabs, opened on first use. */
  tab(workspaceId: string, index = 0): Promise<BrowserTab> {
    if (!Number.isInteger(index) || index < 0 || index >= BuiltInBrowser.MAX_TABS) throw new Error("No such tab");
    const key = this.key(workspaceId, index);
    let t = this.tabs.get(key);
    if (!t) {
      t = (async () => {
        const chrome = await this.connection();
        const { targetId } = await chrome.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await chrome.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
        const tab = new BrowserTab(chrome, targetId, sessionId);
        await tab.init();
        return tab;
      })();
      t.catch(() => this.tabs.delete(key));
      this.tabs.set(key, t);
    }
    return t;
  }

  /** The tab if one is open, without opening one. */
  async existing(workspaceId: string): Promise<BrowserTab | null> {
    const t = this.tabs.get(workspaceId);
    return t ? t.catch(() => null) : null;
  }

  /** Which of the workspace's tabs are open. */
  open(workspaceId: string): number[] {
    return [...this.tabs.keys()].flatMap((k) => (k === workspaceId ? [0] : k.startsWith(`${workspaceId}#`) ? [Number(k.slice(workspaceId.length + 1))] : [])).sort((a, b) => a - b);
  }

  /** Closes one tab, or all of the workspace's tabs. */
  async closeTab(workspaceId: string, index?: number): Promise<void> {
    for (const i of index === undefined ? this.open(workspaceId) : [index]) {
      const key = this.key(workspaceId, i);
      const t = this.tabs.get(key);
      this.tabs.delete(key);
      await (await t?.catch(() => null))?.close();
    }
  }

  async closeAll(): Promise<void> {
    const chrome = this.chrome;
    this.tabs.clear();
    this.chrome = null;
    await (await chrome?.catch(() => null))?.close();
  }
}
