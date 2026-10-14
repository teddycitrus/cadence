import { useState } from "react";
import type { Project, Snapshot, Workspace } from "../../../../core/types";
import { navigate } from "../../App";
import { api } from "../../api";
import { openBeside } from "../Workbench";

export const RUN_EVENT = "cadence:run-command";
export interface RunDetail {
  workspaceId: string;
  name: string;
  command: string;
}

/** Shared Run commands plus the viewer's own; a personal name replaces the shared one. */
export function runCommands(project: Project | null | undefined, memberId: string | null): { name: string; command: string; mine: boolean }[] {
  if (!project) return [];
  const mine = (memberId && project.personal?.[memberId]?.commands) || [];
  const names = new Set(mine.map((c) => c.name));
  return [...project.commands.filter((c) => !names.has(c.name)).map((c) => ({ ...c, mine: false })), ...mine.map((c) => ({ ...c, mine: true }))];
}

export const runInWorkspace = (detail: RunDetail) => window.dispatchEvent(new CustomEvent<RunDetail>(RUN_EVENT, { detail }));

export const OPEN_FILE_EVENT = "cadence:open-file";
export interface OpenFileDetail {
  workspaceId: string;
  path: string;
}
/** Opens a file in the workspace side panel's Files tab. */
export const openWorkspaceFile = (detail: OpenFileDetail) => window.dispatchEvent(new CustomEvent<OpenFileDetail>(OPEN_FILE_EVENT, { detail }));

/** The workspace's Run button: runs a project command in a terminal, or sets one up. */
export function RunButton({ ws, snapshot }: { ws: Workspace; snapshot: Snapshot }) {
  const [open, setOpen] = useState(false);
  const [home, setHome] = useState<string | null>(null);
  // The main canvas opens beside the app when it runs.
  const toggle = () => {
    if (!open) void api.workspaceCanvases(ws.id).then((r) => setHome(r.canvases.find((c) => c.home)?.path ?? null), () => setHome(null));
    setOpen((o) => !o);
  };
  const project = ws.projectId ? snapshot.projects.find((p) => p.id === ws.projectId) : null;
  if (!project || ws.archived) return null;
  const commands = runCommands(project, snapshot.viewer.memberId);
  const run = (c: { name: string; command: string }) => {
    setOpen(false);
    runInWorkspace({ workspaceId: ws.id, name: c.name, command: c.command });
  };
  if (commands.length === 0) {
    return (
      <button className="rounded px-1.5 py-0.5 text-xs whitespace-nowrap text-zinc-500 hover:bg-zinc-900 hover:text-zinc-100" title="Set up a run action" onClick={() => navigate("settings", "projects")}>
        ▶ Run
      </button>
    );
  }
  return (
    <span className="relative">
      <span className="flex items-center rounded bg-zinc-900 text-xs whitespace-nowrap">
        <button className="px-1.5 py-0.5 text-zinc-300 hover:text-zinc-100" title={`Run ${commands[0]!.name}: ${commands[0]!.command}`} onClick={() => run(commands[0]!)}>
          ▶ {commands[0]!.name}
        </button>
        <button className="border-l border-zinc-800 px-1 py-0.5 text-zinc-500 hover:text-zinc-100" title="More run actions" onClick={toggle}>
          ▾
        </button>
      </span>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1 w-64 rounded-lg bg-zinc-900 py-1 text-sm shadow-2xl ring-1 ring-zinc-700">
            {commands.map((c) => (
              <button key={c.name} className="block w-full px-3 py-1.5 text-left hover:bg-zinc-800" onClick={() => run(c)}>
                <span className="text-zinc-200">{c.name}</span>
                {c.mine && <span className="ml-1 text-[10px] text-zinc-500">mine</span>}
                <span className="block truncate font-mono text-[10px] text-zinc-500">{c.command}</span>
              </button>
            ))}
            {home && (
              <button className="block w-full border-t border-zinc-800 px-3 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800" onClick={() => (setOpen(false), run(commands[0]!), openBeside(`#/canvas/${encodeURIComponent(`${ws.id}|${home}`)}`))}>
                Run {commands[0]!.name} with the main canvas beside
              </button>
            )}
            <button className="block w-full border-t border-zinc-800 px-3 py-1.5 text-left text-xs text-zinc-400 hover:bg-zinc-800" onClick={() => (setOpen(false), navigate("settings", "projects"))}>
              Edit run scripts...
            </button>
          </div>
        </>
      )}
    </span>
  );
}
