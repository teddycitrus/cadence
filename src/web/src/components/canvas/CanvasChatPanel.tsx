import { useState } from "react";
import type { Snapshot } from "../../../../core/types";
import { api } from "../../api";
import { ChatView } from "../chat/ChatView";
import { ErrorText, useAction } from "../ui";

/** A workspace chat beside the canvas, so you can ask for changes and watch them land. */
export function CanvasChatPanel({ workspaceId, snapshot, onClose }: { workspaceId: string; snapshot: Snapshot; onClose: () => void }) {
  const chats = snapshot.chats.filter((c) => c.workspaceId === workspaceId && !c.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const [chatId, setChatId] = useState<string | null>(chats[0]?.id ?? null);
  const action = useAction();
  const current = chats.some((c) => c.id === chatId) ? chatId : (chats[0]?.id ?? null);
  const start = () => action.run(async () => setChatId((await api.createChat({ workspaceId })).id));
  return (
    <aside className="flex w-[28rem] shrink-0 flex-col border-l border-zinc-900 bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-900 px-3 py-2 text-xs">
        <select className="min-w-0 flex-1 rounded bg-zinc-900 px-2 py-1 text-zinc-200 ring-1 ring-zinc-800" value={current ?? ""} onChange={(e) => (e.target.value === "new" ? void start() : setChatId(e.target.value))}>
          {chats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
          <option value="new">+ New chat</option>
        </select>
        <button className="text-zinc-500 hover:text-zinc-100" onClick={onClose} aria-label="Close chat">
          ×
        </button>
      </div>
      <ErrorText>{action.error}</ErrorText>
      {current ? (
        <ChatView key={current} chatId={current} snapshot={snapshot} />
      ) : (
        <div className="grid flex-1 place-items-center p-6 text-center text-sm text-zinc-500">
          <button className="text-violet-300 hover:underline" onClick={() => void start()}>
            Start a chat in this workspace
          </button>
        </div>
      )}
    </aside>
  );
}
