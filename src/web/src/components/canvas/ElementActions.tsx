import { api } from "../../api";
import { addComposerContext } from "../chat/composer-context";
import type { SelectedElement } from "./InspectPanel";

const ACTIONS: { op: "back" | "backward" | "forward" | "front" | "duplicate" | "delete"; label: string; title: string }[] = [
  { op: "back", label: "⤓", title: "Send to back (first among its siblings)" },
  { op: "backward", label: "↓", title: "Send backward" },
  { op: "forward", label: "↑", title: "Bring forward" },
  { op: "front", label: "⤒", title: "Bring to front (last among its siblings)" },
  { op: "duplicate", label: "Duplicate", title: "Duplicate this element in its source" },
  { op: "delete", label: "Delete", title: "Delete this element from its source" },
];

/** Stacking order, duplicate, delete, and "send to chat" for the selected element. */
export function ElementActions({ workspaceId, element, run }: { workspaceId: string; element: SelectedElement; run: (fn: () => Promise<unknown>) => unknown }) {
  const context = () => {
    const where = element.ancestors?.length ? ` inside ${element.ancestors.slice(0, 3).map((a) => `<${a.tag}>`).join(" in ")}` : "";
    addComposerContext(workspaceId, `The selected <${element.tag}> at ${element.loc}${where}${element.className ? ` (classes: ${element.className})` : ""}${element.text ? `, text "${element.text.slice(0, 80)}"` : ""}: `);
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      {ACTIONS.map((a) => (
        <button
          key={a.op}
          title={a.title}
          className={`rounded bg-zinc-900 px-1.5 py-0.5 text-[11px] ring-1 ring-zinc-800 hover:bg-zinc-800 ${a.op === "delete" ? "text-red-400" : "text-zinc-300"}`}
          onClick={() => (a.op !== "delete" || confirm(`Delete this <${element.tag}> from ${element.loc.replace(/:\d+:\d+$/, "")}?`)) && void run(() => api.elementOp(workspaceId, element.loc, a.op))}
        >
          {a.label}
        </button>
      ))}
      <button className="ml-auto rounded bg-violet-950 px-1.5 py-0.5 text-[11px] text-violet-200 ring-1 ring-violet-900 hover:bg-violet-900" title="Put this element in the canvas chat's message, to ask for a change" onClick={context}>
        Send to chat
      </button>
    </div>
  );
}
