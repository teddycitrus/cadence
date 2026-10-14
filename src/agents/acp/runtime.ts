import { createHash } from "node:crypto";
import type { ChatItemData } from "../../core/types";
import { providerInfo, type ProviderId } from "../../core/providers";
import type { ProviderRegistry } from "../providers";
import type { ChatRuntime, CliSupport, LiveSession, SessionOptions } from "../runtime";
import type { ToolBridge } from "../tool-bridge";
import { AcpConnection, type AcpLaunch } from "./connection";
import { startAcpSession } from "./session";

const COMPLETE_TIMEOUT_MS = 180_000;

/**
 * Runs chats through any harness that speaks the Agent Client Protocol
 * (Codex, Cursor, Grok, OpenCode). The harness runs on this machine with its
 * own login, or with a key from Settings > Providers.
 */
export class AcpRuntime implements ChatRuntime {
  readonly name: ProviderId;
  readonly cli: CliSupport;

  constructor(
    private id: ProviderId,
    private providers: ProviderRegistry,
    private bridge: ToolBridge,
  ) {
    this.name = id;
    this.cli = {
      command: ({ sessionId }) => {
        const template = this.providers.cliCommand(this.id);
        if (!template) throw new Error(`${providerInfo(this.id).label} has no CLI command set in Settings > Providers`);
        return template.replace(/\{session\}/g, sessionId);
      },
      transcript: (sessionId, cwd) => this.transcript(sessionId, cwd),
      ensureSession: (cwd) => this.newSession(cwd),
    };
  }

  private launch(cwd: string, model?: string): AcpLaunch {
    const info = providerInfo(this.id);
    const command = this.providers.command(this.id);
    if (!command) throw new Error(`${info.label} has no launch command; set one in Settings > Providers`);
    const saved = this.providers.settings(this.id).env;
    const forModel = model ? (this.providers.settings(this.id).modelEnv[model] ?? {}) : {};
    return { label: info.label, command, env: this.providers.env(this.id, model), cwd, signInHint: `${info.install}.`, hasKey: info.keyEnvs.some((k) => Boolean(saved[k] || forModel[k])) };
  }

  start(o: SessionOptions): LiveSession {
    return startAcpSession(this.launch(o.cwd, o.model), o, this.bridge, { onModels: (models) => this.providers.rememberModels(this.id, models) });
  }

  /** Opens a connection, runs `fn`, and always ends the process. */
  private async withConnection<T>(cwd: string, fn: (conn: AcpConnection) => Promise<T>): Promise<T> {
    const conn = new AcpConnection(this.launch(cwd));
    const timer = setTimeout(() => conn.kill(), COMPLETE_TIMEOUT_MS);
    try {
      await conn.initialize();
      return await fn(conn);
    } finally {
      clearTimeout(timer);
      conn.kill();
    }
  }

  async complete(prompt: string, o: { cwd: string; model: string; system: string }): Promise<string> {
    return this.withConnection(o.cwd, async (conn) => {
      const { sessionId } = await conn.withAuth(() => conn.peer.request<{ sessionId: string }>("session/new", { cwd: o.cwd, mcpServers: [] }));
      if (o.model && o.model !== "default") await conn.peer.request("session/set_model", { sessionId, modelId: o.model }).catch(() => undefined);
      let text = "";
      conn.peer.on("session/update", (p: { update: { sessionUpdate: string; content?: { type: string; text?: string } } }) => {
        if (p.update.sessionUpdate === "agent_message_chunk" && p.update.content?.type === "text") text += p.update.content.text ?? "";
      });
      // A one-shot answer never needs tools.
      conn.peer.on("session/request_permission", (p: { options: { optionId: string; kind: string }[] }) => ({
        outcome: { outcome: "selected", optionId: p.options.find((x) => x.kind.startsWith("reject"))?.optionId ?? p.options[0]?.optionId },
      }));
      await conn.peer.request("session/prompt", { sessionId, prompt: [{ type: "text", text: `${o.system}\n\nAnswer directly without using tools.\n\n${prompt}` }] });
      return text.trim();
    });
  }

  /** A fresh session id, so the harness's CLI has a session to resume. */
  private newSession(cwd: string): Promise<string> {
    return this.withConnection(cwd, async (conn) => (await conn.withAuth(() => conn.peer.request<{ sessionId: string }>("session/new", { cwd, mcpServers: [] }))).sessionId);
  }

  /**
   * The session's history, by asking the harness to reload it: it replays
   * every message as updates. Message ids are derived from position and
   * content, so the same history always yields the same ids.
   */
  private async transcript(sessionId: string, cwd: string): Promise<{ id: string; items: ChatItemData[] }[]> {
    return this.withConnection(cwd, async (conn) => {
      if (!conn.capabilities.loadSession) return [];
      const messages: { role: "user" | "assistant"; items: ChatItemData[] }[] = [];
      const current = (role: "user" | "assistant") => {
        const last = messages.at(-1);
        if (last?.role === role) return last;
        const fresh = { role, items: [] as ChatItemData[] };
        messages.push(fresh);
        return fresh;
      };
      const appendText = (role: "user" | "assistant", text: string) => {
        const m = current(role);
        const last = m.items.at(-1);
        if (last && (last.kind === "user" || last.kind === "assistant")) last.text += text;
        else m.items.push(role === "user" ? { kind: "user", text, attachments: [], author: "user", steer: false } : { kind: "assistant", text });
      };
      conn.peer.on("session/update", (p: { sessionId: string; update: Record<string, any> }) => {
        if (p.sessionId !== sessionId) return;
        const u = p.update;
        if (u.sessionUpdate === "user_message_chunk" && u.content?.type === "text") appendText("user", u.content.text ?? "");
        else if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") appendText("assistant", u.content.text ?? "");
        else if (u.sessionUpdate === "tool_call") current("assistant").items.push({ kind: "tool_use", toolUseId: u.toolCallId, name: String(u.title ?? u.kind ?? "tool"), input: (u.rawInput as Record<string, unknown>) ?? {} });
      });
      try {
        await conn.withAuth(() => conn.peer.request("session/load", { sessionId, cwd, mcpServers: [] }));
      } catch {
        return [];
      }
      return messages.map((m, i) => ({ id: `${i}:${createHash("sha1").update(JSON.stringify(m.items)).digest("hex").slice(0, 12)}`, items: m.items }));
    });
  }
}
