import { useState } from "react";
import type { ChatItem } from "../../../../core/types";

interface Task {
  id: string;
  label: string;
  kind: "shell" | "subagent";
  started: string;
  done: boolean;
}

/** Background shells and sub-agents the agent started in this chat, newest first. */
export function backgroundTasks(items: ChatItem[]): Task[] {
  const results = new Set(items.filter((i): i is Extract<ChatItem, { kind: "tool_result" }> => i.kind === "tool_result").map((i) => i.toolUseId));
  const tasks: Task[] = [];
  for (const i of items) {
    if (i.kind !== "tool_use") continue;
    const input = i.input as { run_in_background?: boolean; description?: string; command?: string; prompt?: string };
    if (i.name === "Bash" && input.run_in_background) tasks.push({ id: i.toolUseId, label: input.description || String(input.command ?? "").slice(0, 80), kind: "shell", started: i.ts, done: false });
    else if (i.name === "Task" || i.name === "Agent") tasks.push({ id: i.toolUseId, label: input.description || String(input.prompt ?? "").slice(0, 80), kind: "subagent", started: i.ts, done: results.has(i.toolUseId) });
  }
  return tasks.reverse();
}

/** The composer's task pill: how many background jobs this chat started, with a list on click. */
export function BackgroundTasks({ items }: { items: ChatItem[] }) {
  const [open, setOpen] = useState(false);
  const tasks = backgroundTasks(items);
  if (!tasks.length) return null;
  const running = tasks.filter((t) => t.kind === "subagent" && !t.done).length;
  return (
    <span className="relative">
      <button className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200" onClick={() => setOpen((o) => !o)} title="Background shells and sub-agents in this chat">
        <span className={`size-1.5 rounded-full ${running ? "animate-pulse bg-violet-400" : "bg-zinc-600"}`} />
        {tasks.length} task{tasks.length === 1 ? "" : "s"}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-7 left-0 z-50 w-80 rounded-lg bg-zinc-900 py-1 text-xs shadow-2xl ring-1 ring-zinc-700">
            {tasks.map((t) => (
              <div key={t.id} className="flex items-center gap-2 px-3 py-1.5">
                <span className="rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">{t.kind === "shell" ? "shell" : "agent"}</span>
                <span className="min-w-0 flex-1 truncate text-zinc-200">{t.label || "(no description)"}</span>
                <span className="text-zinc-500">{t.kind === "subagent" ? (t.done ? "done" : "running") : new Date(t.started).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </span>
  );
}
