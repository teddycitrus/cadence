import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import type { ChatItemData, ChatMode } from "../core/types";
import type { CliSupport } from "./runtime";
import { claudeBinary } from "./claude-binary";
import { defaultShell } from "../terminal/service";

const SESSION_ID = /^[0-9a-f-]{36}$/i;
const MODEL = /^[A-Za-z0-9._:\[\]-]+$/;
const MODE_FLAG: Record<ChatMode, string> = { default: "default", acceptEdits: "acceptEdits", plan: "plan", bypassPermissions: "bypassPermissions" };

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b: Block) => (b.type === "text" ? (b.text ?? "") : "")).join("");
  return "";
}

/** Harness bookkeeping the CLI writes as user messages, which are not things a person typed. */
function isBookkeeping(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("<command-") || t.startsWith("<local-command") || t.startsWith("<system-reminder>") || t.startsWith("Caveat: The messages below");
}

/** Converts one transcript message to chat items. */
export function toItems(message: { type: string; message: unknown }): ChatItemData[] {
  const m = message.message as { role?: string; content?: unknown } | undefined;
  if (!m) return [];
  const blocks: Block[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? (m.content as Block[]) : [];
  const items: ChatItemData[] = [];
  for (const b of blocks) {
    if (message.type === "user") {
      if (b.type === "text" && b.text?.trim() && !isBookkeeping(b.text)) items.push({ kind: "user", text: b.text, attachments: [], author: "user", steer: false });
      if (b.type === "tool_result") items.push({ kind: "tool_result", toolUseId: b.tool_use_id ?? "", content: blockText(b.content).slice(0, 20_000), isError: Boolean(b.is_error) });
    } else if (message.type === "assistant") {
      if (b.type === "text" && b.text?.trim()) items.push({ kind: "assistant", text: b.text });
      if (b.type === "tool_use") items.push({ kind: "tool_use", toolUseId: b.id ?? "", name: b.name ?? "tool", input: (b.input as Record<string, unknown>) ?? {} });
    }
  }
  return items;
}

/** CLI mode for Claude Code: the `claude` terminal UI on the chat's own session. */
export const claudeCli: CliSupport = {
  command({ sessionId, resume, model, mode }) {
    if (!SESSION_ID.test(sessionId)) throw new Error("Invalid session id");
    const bin = claudeBinary();
    // A path with spaces (the bundled copy under Program Files) is quoted, and PowerShell runs a
    // quoted path only through its call operator.
    const powershell = process.platform === "win32" && /powershell|pwsh/i.test(defaultShell().file);
    const exe = /\s/.test(bin) ? `${powershell ? "& " : ""}"${bin}"` : bin;
    const args = [resume ? "--resume" : "--session-id", sessionId, "--permission-mode", MODE_FLAG[mode]];
    if (MODEL.test(model)) args.push("--model", model);
    return [exe, ...args].join(" ");
  },
  async transcript(sessionId, cwd) {
    const messages = await getSessionMessages(sessionId, { dir: cwd });
    return messages.filter((m) => !m.parent_tool_use_id).map((m) => ({ id: m.uuid, items: toItems(m) }));
  },
};
