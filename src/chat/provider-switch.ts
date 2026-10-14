import { currentActor } from "../auth/context";
import { ConflictError } from "../core/errors";
import type { EventStore } from "../core/event-store";
import { chooseHarness } from "../core/providers";
import type { Queries } from "../core/queries";
import type { Actor, Chat } from "../core/types";
import type { ChatEngine } from "./engine";

/**
 * Moves a chat that has not started yet to another harness. Once a session
 * exists its history lives in that harness, so later switches need a new chat.
 */
export function switchProvider(d: { engine: ChatEngine; store: EventStore; q: Queries }, chatId: string, provider: string, actor: Actor = currentActor()): Chat {
  const chat = d.engine.chatOrThrow(chatId);
  if (chat.provider === provider) return chat;
  if (chat.agentId) throw new ConflictError("An agent's chats use the agent's harness; change it on the agent");
  if (chat.sessionId || d.q.chatItems(chatId).some((i) => i.kind === "user")) throw new ConflictError("This chat has already started; start a new chat to use another harness");
  const { provider: next, model } = chooseHarness(d.q.settings(), { provider });
  d.engine.close(chatId);
  d.store.append({ aggregate: "chat", type: "ChatUpdated", aggregateId: chatId, payload: { provider: next, model } }, actor);
  return d.engine.chatOrThrow(chatId);
}
