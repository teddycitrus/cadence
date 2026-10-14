import { useEffect, useState } from "react";
import type { Chat } from "../../../../core/types";
import { api, type McpServerView } from "../../api";

// Shared across composers: the server list rarely changes.
let cached: Promise<McpServerView[]> | null = null;
const servers = () => (cached ??= api.mcpServers().catch(() => ((cached = null), [])));

/** Turns the team's MCP servers on or off for one chat. Hidden when there are none. */
export function McpMenu({ chat, onChange }: { chat: Chat; onChange: (names: string[]) => void }) {
  const [list, setList] = useState<McpServerView[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    void servers().then(setList);
  }, []);
  if (!list.length) return null;
  const on = chat.mcpServers ?? list.filter((s) => s.defaultOn).map((s) => s.name);
  return (
    <div className="relative">
      <button className="rounded-md px-2 py-1 text-xs text-zinc-400 ring-1 ring-zinc-800 hover:text-zinc-200" onClick={() => setOpen(!open)} title="MCP servers for this chat">
        MCP {on.length}/{list.length}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute bottom-8 left-0 z-30 w-64 space-y-1 rounded-lg bg-zinc-900 p-2 shadow-2xl ring-1 ring-zinc-700">
            <p className="px-1 text-[11px] text-zinc-500">Applies from the next turn. Manage servers in Settings &gt; Integrations.</p>
            {list.map((s) => (
              <label key={s.name} className="flex items-center gap-2 rounded px-1 py-1 text-xs text-zinc-200 hover:bg-zinc-800">
                <input type="checkbox" checked={on.includes(s.name)} onChange={(e) => onChange(e.target.checked ? [...on, s.name] : on.filter((n) => n !== s.name))} />
                <span className="font-mono">{s.name}</span>
                <span className="ml-auto text-zinc-500">{s.transport === "stdio" ? "local" : "remote"}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
