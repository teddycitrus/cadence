import type { Snapshot } from "../../../../core/types";
import { api } from "../../api";

interface Step {
  id: string;
  label: string;
  hint: string;
  href: string;
  done: boolean;
}

/** What a team does in its first days, ticked off by doing it. Hidden once dismissed or finished. */
export function GettingStarted({ snapshot }: { snapshot: Snapshot }) {
  const me = snapshot.members.find((m) => m.id === snapshot.viewer.memberId);
  const myActor = snapshot.viewer.memberId === "me" ? "user" : `member:${snapshot.viewer.memberId}`;
  const admin = snapshot.viewer.role !== "member";
  const steps: Step[] = [
    ...(admin ? [{ id: "project", label: "Bring in a project", hint: "Generate one, open a folder, or import a repository", href: "#/home", done: snapshot.projects.length > 0 }] : []),
    { id: "chat", label: "Start a chat with an agent", hint: "Ask for a change on its own branch", href: "#/chats", done: snapshot.chats.some((c) => c.createdBy === myActor && !c.agentId) },
    { id: "issue", label: "Put work on the board", hint: "File an issue or let triage do it", href: "#/issues", done: snapshot.issues.length > 0 },
    ...(admin ? [{ id: "agent", label: "Set up an agent", hint: "Start from a template; nothing runs until you enable it", href: "#/agents", done: snapshot.agents.length > 0 }] : []),
    { id: "doc", label: "Write a doc", hint: "Specs and plans live next to the work", href: "#/docs", done: snapshot.docs.length > 0 },
    ...(admin ? [{ id: "team", label: "Invite your team", hint: "Settings > Members", href: "#/settings", done: snapshot.members.length > 1 }] : []),
    ...(admin ? [{ id: "github", label: "Connect GitHub", hint: "Pull requests, checks, and reviews in Cadence", href: "#/settings", done: snapshot.github.connected }] : []),
  ];
  const left = steps.filter((s) => !s.done).length;
  if (!me || me.gettingStartedHidden || left === 0) return null;
  return (
    <section className="space-y-2 rounded-xl bg-zinc-900/60 p-4 ring-1 ring-zinc-800">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium">Getting started</h2>
        <span className="text-xs text-zinc-500">
          {steps.length - left} of {steps.length} done
        </span>
        <button className="ml-auto text-xs text-zinc-500 hover:text-zinc-200" onClick={() => void api.hideGettingStarted()}>
          Hide
        </button>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-zinc-800">
        <div className="h-full bg-violet-500" style={{ width: `${((steps.length - left) / steps.length) * 100}%` }} />
      </div>
      <ul className="grid gap-1 sm:grid-cols-2">
        {steps.map((s) => (
          <li key={s.id}>
            <a href={s.href} className={`flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-zinc-800/60 ${s.done ? "opacity-50" : ""}`}>
              <span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full text-[10px] ring-1 ${s.done ? "bg-emerald-600 text-zinc-950 ring-emerald-600" : "ring-zinc-600"}`}>{s.done ? "✓" : ""}</span>
              <span>
                <span className={`block text-sm ${s.done ? "text-zinc-400 line-through" : "text-zinc-200"}`}>{s.label}</span>
                <span className="block text-xs text-zinc-500">{s.hint}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
