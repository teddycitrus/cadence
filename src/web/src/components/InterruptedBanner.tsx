import { useState } from "react";
import type { Snapshot } from "../../../core/types";
import { api } from "../api";
import { useAction } from "./ui";

const KEY = "cadence.dismissedInterrupted";

function dismissed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

/** Chats Cadence was running when it stopped: continue them all, or leave them. */
export function InterruptedBanner({ snapshot }: { snapshot: Snapshot }) {
  const [hidden, setHidden] = useState(dismissed);
  const action = useAction();
  if (snapshot.viewer.role === "member") return null;
  const chats = snapshot.chats.filter((c) => c.stoppedByRestart && c.status === "interrupted" && !c.archived && !hidden.includes(c.id));
  if (!chats.length) return null;
  const dismiss = () => {
    const next = [...hidden, ...chats.map((c) => c.id)].slice(-200);
    setHidden(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // storage unavailable: hidden for this page only
    }
  };
  return (
    <div className="absolute top-3 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-lg bg-zinc-900 px-4 py-2 text-sm shadow-2xl ring-1 ring-amber-800">
      <span className="text-amber-200">
        {chats.length} chat{chats.length === 1 ? " was" : "s were"} interrupted when Cadence stopped.
      </span>
      <button
        className="text-violet-300 hover:underline disabled:opacity-50"
        disabled={action.busy}
        onClick={() =>
          void action.run(async () => {
            for (const c of chats) await api.sendMessage(c.id, { text: "Continue where you left off.", attachments: [], mentions: [], steer: false });
          })
        }
      >
        Continue {chats.length === 1 ? "it" : "all"}
      </button>
      {chats.length === 1 && (
        <a className="text-zinc-400 hover:underline" href={`#/chats/${chats[0]!.id}`}>
          Open
        </a>
      )}
      <button className="text-zinc-500 hover:text-zinc-200" onClick={dismiss}>
        Dismiss
      </button>
      {action.error && <span className="text-red-400">{action.error}</span>}
    </div>
  );
}
