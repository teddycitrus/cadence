import type { Attachment, ChatMode } from "../../core/types";

// Shapes from the Agent Client Protocol (protocol version 1) that Cadence uses.

export interface AcpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  resource?: { uri: string; text?: string; blob?: string; mimeType?: string };
}

export interface AcpToolCallContent {
  type: "content" | "diff" | "terminal";
  content?: AcpContentBlock;
  path?: string;
  oldText?: string | null;
  newText?: string;
  terminalId?: string;
}

export interface AcpToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: AcpToolCallContent[];
  locations?: { path: string; line?: number }[];
}

export interface AcpMode {
  id: string;
  name: string;
  description?: string;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

const KIND_NAMES: Record<string, string> = { read: "Read", edit: "Edit", delete: "Delete", move: "Move", search: "Grep", execute: "Bash", think: "Think", fetch: "WebFetch" };

/** A tool name the chat view understands: the Claude Code names where the kinds line up. */
export function toolName(call: Pick<AcpToolCall, "kind" | "title" | "rawInput">): string {
  const mcp = mcpCall(call);
  if (mcp) return `mcp__${mcp.server}__${mcp.tool}`;
  if (call.kind && KIND_NAMES[call.kind]) return KIND_NAMES[call.kind]!;
  return (call.title ?? "tool").slice(0, 80);
}

/** An MCP tool call, which some harnesses report as a plain command with server and tool fields. */
export function mcpCall(call: Pick<AcpToolCall, "rawInput">): { server: string; tool: string; args: Record<string, unknown> } | null {
  const raw = call.rawInput as { server?: unknown; tool?: unknown; arguments?: unknown } | undefined;
  if (!raw || typeof raw.server !== "string" || typeof raw.tool !== "string") return null;
  return { server: raw.server, tool: raw.tool, args: raw.arguments && typeof raw.arguments === "object" ? (raw.arguments as Record<string, unknown>) : {} };
}

/** The tool's input as the chat view renders it: commands, file paths, and edits in Claude Code's field names. */
export function toolInput(call: AcpToolCall): Record<string, unknown> {
  const mcp = mcpCall(call);
  if (mcp) return mcp.args;
  const raw = call.rawInput && typeof call.rawInput === "object" ? { ...(call.rawInput as Record<string, unknown>) } : {};
  const diff = call.content?.find((c) => c.type === "diff");
  if (diff) Object.assign(raw, { file_path: diff.path, old_string: diff.oldText ?? "", new_string: diff.newText ?? "" });
  const path = call.locations?.[0]?.path;
  if (path && raw.file_path === undefined && raw.path === undefined) raw.file_path = path;
  if (call.title && raw.description === undefined) raw.description = call.title;
  return raw;
}

function blockText(b: AcpContentBlock | undefined): string {
  if (!b) return "";
  if (b.type === "text") return b.text ?? "";
  if (b.type === "resource") return b.resource?.text ?? `[${b.resource?.uri ?? "resource"}]`;
  if (b.type === "resource_link") return `[${b.uri ?? "link"}]`;
  return `[${b.type}]`;
}

/** A finished tool call's output as plain text. */
export function toolOutput(call: AcpToolCall): string {
  const parts: string[] = [];
  for (const c of call.content ?? []) {
    if (c.type === "content") parts.push(blockText(c.content));
    else if (c.type === "diff") parts.push(`Edited ${c.path ?? "a file"}`);
    else if (c.type === "terminal") parts.push(`[terminal ${c.terminalId ?? ""}]`);
  }
  if (!parts.length && call.rawOutput !== undefined) parts.push(typeof call.rawOutput === "string" ? call.rawOutput : JSON.stringify(call.rawOutput, null, 2));
  return parts.join("\n").trim() || (call.status === "failed" ? "Failed" : "Done");
}

// Tried in order: the first pattern any mode matches wins. "Ask first" falls
// back to a read-only mode, which in harnesses like Codex asks before edits.
const MODE_PATTERNS: Record<ChatMode, RegExp[]> = {
  default: [/^(default|ask|normal|manual|suggest)/i, /read.?only/i],
  acceptEdits: [/accept.?edits/i, /(workspace.?write|edit|write)/i, /auto/i],
  plan: [/plan/i, /read.?only|architect/i],
  bypassPermissions: [/(bypass|yolo|danger|unrestricted)/i, /full/i],
};

/** The harness's own mode closest to a Cadence chat mode, if it has one. */
export function pickMode(mode: ChatMode, available: AcpMode[]): AcpMode | null {
  const exact = available.find((m) => m.id === mode);
  if (exact) return exact;
  for (const pattern of MODE_PATTERNS[mode]) {
    const hit = available.find((m) => pattern.test(m.id) || pattern.test(m.name));
    if (hit) return hit;
  }
  return null;
}

/** Edits and commands a chat mode lets through without asking. */
export function autoAllows(mode: ChatMode, kind: string | undefined): boolean | "reject" {
  if (mode === "bypassPermissions") return true;
  const reads = kind === "read" || kind === "search" || kind === "think" || kind === "fetch";
  if (mode === "plan") return reads ? true : "reject";
  if (mode === "acceptEdits") return reads || kind === "edit" || kind === "move";
  return reads;
}

/** A prompt in ACP content blocks, with attachments the harness can take. */
export function promptBlocks(text: string, attachments: Attachment[], caps: { image?: boolean; embeddedContext?: boolean }): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = [];
  for (const a of attachments) {
    if (a.data && a.mediaType.startsWith("image/")) {
      if (caps.image) blocks.push({ type: "image", data: a.data, mimeType: a.mediaType });
      else blocks.push({ type: "text", text: `[Attached image "${a.name}" left out: this harness does not accept images]` });
    } else if (a.text !== undefined) {
      if (caps.embeddedContext) blocks.push({ type: "resource", resource: { uri: `file:///${encodeURIComponent(a.name)}`, text: a.text, mimeType: a.mediaType || "text/plain" } });
      else blocks.push({ type: "text", text: `<attached_file name="${a.name}">\n${a.text}\n</attached_file>` });
    }
  }
  blocks.push({ type: "text", text });
  return blocks;
}

/**
 * The harness model to switch to. Harnesses that put the reasoning level in
 * the id (gpt-6-luna[high]) get the chat's effort; "default" keeps the
 * harness's own model and only adjusts its level.
 */
export function modelFor(model: string, effort: string, current: string | null, available: string[]): string | null {
  if (model !== "default" && /\[.+\]$/.test(model)) return available.includes(model) ? model : null;
  const base = model === "default" ? current?.replace(/\[.+\]$/, "") : model;
  if (!base) return null;
  const leveled = `${base}[${effort}]`;
  if (available.includes(leveled)) return leveled;
  return model !== "default" && available.includes(base) ? base : null;
}

/** Picks the permission option matching an answer. */
export function optionFor(options: AcpPermissionOption[], allow: boolean, always: boolean): string | null {
  const order: AcpPermissionOption["kind"][] = allow ? (always ? ["allow_always", "allow_once"] : ["allow_once", "allow_always"]) : ["reject_once", "reject_always"];
  for (const kind of order) {
    const o = options.find((x) => x.kind === kind);
    if (o) return o.optionId;
  }
  return null;
}
