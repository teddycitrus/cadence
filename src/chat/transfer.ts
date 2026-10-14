import { currentActor } from "../auth/context";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import type { EventStore } from "../core/event-store";
import type { Queries } from "../core/queries";
import type { Actor, Chat, ChatItem } from "../core/types";
import type { ChatEngine } from "./engine";
import { restoreTree } from "./checkpoints";

const TRANSCRIPT_CHARS = 40_000;

/**
 * Moves a person's chat to another workspace. A harness session is tied to
 * its working directory and cannot be resumed elsewhere, so the chat drops
 * its session id; the next session there starts fresh with the transcript.
 */
export function transferChat(d: { engine: ChatEngine; store: EventStore; q: Queries }, chatId: string, toWorkspaceId: string, actor: Actor = currentActor()): Chat {
  const chat = d.engine.chatOrThrow(chatId);
  const target = d.q.workspace(toWorkspaceId);
  if (!target) throw new NotFoundError(`Workspace ${toWorkspaceId} not found`);
  if (target.id === chat.workspaceId) throw new ValidationError("The chat is already in that workspace");
  if (target.archived) throw new ConflictError("That workspace is archived");
  if (chat.agentId) throw new ConflictError("Agent chats stay with their run's workspace");
  if (chat.docId) throw new ConflictError("A doc's assistant chat cannot be moved");
  if (chat.status === "running" || chat.status === "waiting") throw new ConflictError("Wait for the current turn to finish, or stop it, first");
  if (d.engine.isLocked(chatId)) throw new ConflictError("Leave CLI mode before moving this chat");
  if (d.q.queued(chatId).length) throw new ConflictError("Send or remove the queued messages first");
  d.engine.close(chatId);
  d.store.append({ aggregate: "chat", type: "ChatTransferred", aggregateId: chatId, payload: { fromWorkspaceId: chat.workspaceId, toWorkspaceId: target.id } }, actor);
  d.store.append(
    { aggregate: "chat", type: "ChatItemAdded", aggregateId: chatId, payload: { item: { kind: "notice", tone: "info", text: `Moved to ${target.name}${target.branch ? ` (${target.branch})` : ""}. The next message starts a new session there with this conversation as context.` } } },
    actor,
  );
  return d.engine.chatOrThrow(chatId);
}

function line(item: ChatItem): string | null {
  switch (item.kind) {
    case "user":
      return item.text.trim() ? `Person: ${item.text.trim()}` : null;
    case "assistant":
      return item.text.trim() ? `You: ${item.text.trim()}` : null;
    case "tool_use":
      return `(you used ${item.name})`;
    default:
      return null;
  }
}

/** The conversation so far, for the first session after a chat moves workspaces. */
export function carryOverContext(q: Queries, chat: Pick<Chat, "id" | "carryOver">): string {
  if (!chat.carryOver) return "";
  const lines = q
    .chatItems(chat.id)
    .map(line)
    .filter((l): l is string => l !== null);
  if (!lines.length) return "";
  let text = lines.join("\n\n");
  if (text.length > TRANSCRIPT_CHARS) text = `[earlier messages omitted]\n\n${text.slice(-TRANSCRIPT_CHARS)}`;
  const why = (chat as Chat).forkedFrom ? "This chat is a fork of an earlier conversation, copied up to the point below. Continue from there." : "This chat was moved here from another workspace, so files and branches mentioned below may differ in this one. Continue from where it left off.";
  return `\n\n## Conversation so far\n\n${why}\n\n${text}`;
}

/** A new chat in the same workspace with this one's transcript up to `upToSeq`; its first session picks up from there. */
export function forkChat(d: { engine: ChatEngine; store: EventStore; q: Queries }, chatId: string, upToSeq: number, actor: Actor = currentActor()): Chat {
  const chat = d.engine.chatOrThrow(chatId);
  if (chat.docId) throw new ConflictError("A doc's assistant chat cannot be forked");
  const items = d.q.chatItems(chatId).filter((i) => i.seq <= upToSeq && i.kind !== "interaction");
  if (!items.length) throw new ValidationError("Nothing to fork at that point");
  const fork = d.engine.createChat({ workspaceId: chat.workspaceId!, title: `${chat.title} (fork)`.slice(0, 120), provider: chat.provider as never, model: chat.model, effort: chat.effort, mode: chat.mode }, actor);
  d.store.append(
    items.map(({ seq: _s, chatId: _c, ts: _t, ...item }) => ({ aggregate: "chat" as const, type: "ChatItemAdded" as const, aggregateId: fork.id, payload: { item } })),
    actor,
  );
  d.store.append(
    [
      { aggregate: "chat", type: "ChatForked", aggregateId: fork.id, payload: { fromChatId: chat.id, upToSeq } },
      { aggregate: "chat", type: "ChatItemAdded", aggregateId: fork.id, payload: { item: { kind: "notice", tone: "info", text: `Forked from "${chat.title}". The next message starts a new session with the conversation above as context.` } } },
    ],
    actor,
  );
  return d.engine.chatOrThrow(fork.id);
}

/** The conversation as Markdown, for saving or sharing outside Cadence. */
export function exportChat(q: Queries, chatId: string): string {
  const chat = q.chat(chatId);
  if (!chat) throw new NotFoundError("Chat not found");
  const out = [`# ${chat.title}`, "", `Exported ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC, ${chat.provider}, ${chat.model}`, ""];
  for (const item of q.chatItems(chatId)) {
    if (item.kind === "user" && item.text.trim()) out.push("## You", "", item.text.trim(), "");
    else if (item.kind === "assistant" && item.text.trim()) out.push("## Assistant", "", item.text.trim(), "");
    else if (item.kind === "tool_use") out.push(`> Used ${item.name}`, "");
    else if (item.kind === "notice") out.push(`_${item.text}_`, "");
  }
  return out.join("\n");
}

/** Puts the workspace's files back to how they were just before one of the chat's messages. */
export async function restoreCheckpoint(d: { engine: ChatEngine; store: EventStore; q: Queries }, chatId: string, seq: number, actor: Actor = currentActor()): Promise<{ restored: number; removed: number }> {
  const chat = d.engine.chatOrThrow(chatId);
  if (chat.status === "running" || chat.status === "waiting") throw new ConflictError("Stop the turn in progress before restoring files");
  const item = d.q.chatItems(chatId).find((i) => i.seq === seq);
  if (!item || item.kind !== "user" || !item.checkpoint) throw new ValidationError("There is no checkpoint at that message");
  const ws = chat.workspaceId ? d.q.workspace(chat.workspaceId) : null;
  if (!ws) throw new NotFoundError("The chat's workspace is gone");
  const result = await restoreTree(ws.path, item.checkpoint);
  d.store.append({ aggregate: "chat", type: "ChatItemAdded", aggregateId: chatId, payload: { item: { kind: "notice", tone: "info", text: `Files restored to just before "${item.text.trim().slice(0, 60)}"${result.removed ? `; ${result.removed} file${result.removed === 1 ? "" : "s"} added since were removed` : ""}.` } } }, actor);
  return result;
}
