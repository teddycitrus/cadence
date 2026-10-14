import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { LSPClient, LSPPlugin, languageServerExtensions, type Transport } from "@codemirror/lsp-client";

// Code intelligence in the Files editor: completions, hover, diagnostics,
// go to definition, rename, and formatting from TypeScript's language server,
// which runs in the workspace's folder on the host (owner and admins only).

const LANGUAGES: Record<string, string> = { ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescriptreact", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascriptreact" };

export const lspLanguage = (path: string): string | null => LANGUAGES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? null;

/** A file URI for a path inside the workspace folder (Windows drive paths too). */
export function fileUri(root: string, rel: string): string {
  const abs = `${root.replace(/\\/g, "/").replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;
  const encoded = abs.split("/").map((part, i) => (i === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part))).join("/");
  return encoded.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`;
}

const SERVER_REQUESTS = new Set(["client/registerCapability", "client/unregisterCapability", "workspace/configuration", "window/workDoneProgress/create"]);

/** Messages over the workspace's language-server socket; reconnects on the next send after a drop. */
function socketTransport(workspaceId: string): Transport {
  const handlers = new Set<(m: string) => void>();
  let socket: WebSocket | null = null;
  let queue: string[] = [];
  const open = () => {
    const s = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/workspaces/${workspaceId}/lsp`);
    s.onmessage = (e) => {
      const text = String(e.data);
      // Requests the editor's client does not implement: accept them here so the server carries on quietly.
      try {
        const m = JSON.parse(text) as { id?: number | string; method?: string; params?: { items?: unknown[] } };
        if (m.id !== undefined && m.method && SERVER_REQUESTS.has(m.method)) {
          s.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: m.method === "workspace/configuration" ? (m.params?.items ?? []).map(() => null) : null }));
          return;
        }
      } catch {
        // not JSON; pass it on
      }
      handlers.forEach((h) => h(text));
    };
    s.onopen = () => {
      for (const m of queue) s.send(m);
      queue = [];
    };
    s.onclose = () => {
      if (socket === s) socket = null;
    };
    socket = s;
  };
  return {
    send(message) {
      if (!socket) open();
      if (socket!.readyState === WebSocket.OPEN) socket!.send(message);
      else queue.push(message);
    },
    subscribe: (h) => void handlers.add(h),
    unsubscribe: (h) => void handlers.delete(h),
  };
}

interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number;
  message: string;
  source?: string;
}

const SEVERITY: Record<number, "error" | "warning" | "info" | "hint"> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

/**
 * TypeScript's server only answers diagnostics when asked (pull, LSP 3.17),
 * and the client shows only pushed ones, so ask after each pause in typing.
 */
const pullDiagnostics = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private seq = 0;
    constructor(private view: EditorView) {
      this.schedule(300);
    }
    update(u: ViewUpdate) {
      if (u.docChanged) this.schedule(600);
    }
    schedule(ms: number) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.pull(), ms);
    }
    async pull() {
      const plugin = LSPPlugin.get(this.view);
      if (!plugin) return;
      const seq = ++this.seq;
      try {
        await plugin.client.initializing;
        plugin.client.sync();
        const doc = plugin.syncedDoc;
        const r = await plugin.client.request<{ textDocument: { uri: string } }, { kind: string; items?: LspDiagnostic[] }>("textDocument/diagnostic", { textDocument: { uri: plugin.uri } });
        // A newer request, or edits since, make this answer stale.
        if (seq !== this.seq || doc !== plugin.syncedDoc || !r.items) return;
        const clamp = (n: number) => Math.min(Math.max(n, 0), doc.length);
        const diagnostics: Diagnostic[] = r.items.map((d) => ({ from: clamp(plugin.fromPosition(d.range.start, doc)), to: clamp(plugin.fromPosition(d.range.end, doc)), severity: SEVERITY[d.severity ?? 1] ?? "error", message: d.message, source: d.source }));
        this.view.dispatch(setDiagnostics(this.view.state, diagnostics));
      } catch {
        // The server is starting or gone; the next edit asks again.
      }
    }
    destroy() {
      if (this.timer) clearTimeout(this.timer);
    }
  },
);

const clients = new Map<string, LSPClient>();

/** The editor extension for one file, or nothing when the file is not TypeScript or JavaScript. */
export function codeIntelligence(workspaceId: string, root: string, path: string): Extension[] {
  const language = lspLanguage(path);
  if (!language) return [];
  let client = clients.get(workspaceId);
  if (!client) {
    client = new LSPClient({ rootUri: fileUri(root, ""), extensions: languageServerExtensions(), timeout: 10_000 }).connect(socketTransport(workspaceId));
    clients.set(workspaceId, client);
  }
  return [client.plugin(fileUri(root, path), language), pullDiagnostics];
}
