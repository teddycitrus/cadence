import { useEffect, useState } from "react";
import type { Snapshot } from "../../../../core/types";
import { api } from "../../api";
import { ChatView } from "../chat/ChatView";

/** A chat beside the board with the board tools: triage, planning, and bulk changes in words. */
export function BoardAssistant({ snapshot, onClose }: { snapshot: Snapshot; onClose: () => void }) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.boardAssistant().then((c) => setChatId(c.id), (e: Error) => setError(e.message));
  }, []);
  const ready = chatId && snapshot.chats.some((c) => c.id === chatId);
  return (
    <aside className="flex w-[30rem] shrink-0 flex-col border-l border-zinc-900">
      <header className="flex items-center justify-between border-b border-zinc-900 px-4 py-2.5">
        <h2 className="text-sm font-semibold">Ask AI about the board</h2>
        <span className="flex items-center gap-3">
          {chatId && (
            <a href={`#/chats/${chatId}`} className="text-xs text-violet-300 hover:underline">
              Open in Chats
            </a>
          )}
          <button className="text-zinc-500 hover:text-zinc-100" onClick={onClose} aria-label="Close assistant">
            ×
          </button>
        </span>
      </header>
      {error && <p className="p-4 text-sm text-red-400">{error}</p>}
      {ready ? <ChatView chatId={chatId} snapshot={snapshot} /> : !error && <p className="p-4 text-sm text-zinc-500">Starting...</p>}
    </aside>
  );
}
