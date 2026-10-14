import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { DOC_COLORS, type DocColor } from "./colors";

const BLOCKS: { id: string; label: string; active: (e: Editor) => boolean; run: (e: Editor) => void }[] = [
  { id: "p", label: "Text", active: (e) => e.isActive("paragraph"), run: (e) => e.chain().focus().setParagraph().run() },
  ...([1, 2, 3, 4] as const).map((level) => ({ id: `h${level}`, label: `Heading ${level}`, active: (e: Editor) => e.isActive("heading", { level }), run: (e: Editor) => e.chain().focus().setHeading({ level }).run() })),
  { id: "ul", label: "Bullet list", active: (e) => e.isActive("bulletList"), run: (e) => e.chain().focus().toggleBulletList().run() },
  { id: "ol", label: "Numbered list", active: (e) => e.isActive("orderedList"), run: (e) => e.chain().focus().toggleOrderedList().run() },
  { id: "task", label: "Task list", active: (e) => e.isActive("taskList"), run: (e) => e.chain().focus().toggleTaskList().run() },
  { id: "quote", label: "Quote", active: (e) => e.isActive("blockquote"), run: (e) => e.chain().focus().toggleBlockquote().run() },
  { id: "code", label: "Code block", active: (e) => e.isActive("codeBlock"), run: (e) => e.chain().focus().toggleCodeBlock().run() },
];

/** "Change to": change the current block to another kind. */
export function TurnInto({ editor }: { editor: Editor }) {
  const current = BLOCKS.find((b) => b.active(editor))?.id ?? "p";
  return (
    <select
      className="rounded bg-zinc-800 px-1 py-0.5 text-xs text-zinc-200 hover:bg-zinc-700"
      title="Change to"
      value={current}
      onChange={(e) => BLOCKS.find((b) => b.id === e.target.value)?.run(editor)}
    >
      {BLOCKS.map((b) => (
        <option key={b.id} value={b.id}>
          {b.label}
        </option>
      ))}
    </select>
  );
}

/** Text color and background color, from the doc palette; plus clearing all formatting. */
export function ColorMenu({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const text = editor.getAttributes("textColor").color as DocColor | undefined;
  const bg = editor.getAttributes("highlight").color as DocColor | undefined;
  const setText = (c: DocColor | null) => (c ? editor.chain().focus().setMark("textColor", { color: c }).run() : editor.chain().focus().unsetMark("textColor").run());
  const setBg = (c: DocColor | null) => (c ? editor.chain().focus().setHighlight({ color: c }).run() : editor.chain().focus().unsetHighlight().run());
  return (
    <span className="relative">
      <button className="rounded px-1.5 py-0.5 text-xs text-zinc-200 hover:bg-zinc-700" title="Text and background color" onClick={() => setOpen((o) => !o)}>
        <span className="doc-text-color" data-color={text}>A</span>
        <span className="ml-0.5 text-[10px] text-zinc-400">▾</span>
      </button>
      {open && (
        <div className="absolute top-7 left-0 z-50 w-56 space-y-2 rounded-lg bg-zinc-900 p-2 shadow-2xl ring-1 ring-zinc-700" onMouseDown={(e) => e.preventDefault()}>
          <Palette title="Text" current={text ?? null} onPick={(c) => (setText(c), setOpen(false))} kind="text" />
          <Palette title="Background" current={bg ?? null} onPick={(c) => (setBg(c), setOpen(false))} kind="bg" />
          <button className="w-full rounded px-2 py-1 text-left text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" onClick={() => (editor.chain().focus().unsetAllMarks().clearNodes().run(), setOpen(false))}>
            Clear formatting
          </button>
        </div>
      )}
    </span>
  );
}

function Palette({ title, current, onPick, kind }: { title: string; current: DocColor | null; onPick: (c: DocColor | null) => void; kind: "text" | "bg" }) {
  return (
    <div>
      <p className="mb-1 text-[10px] tracking-wide text-zinc-500 uppercase">{title}</p>
      <div className="flex flex-wrap gap-1">
        <button className={`grid size-6 place-items-center rounded text-xs text-zinc-300 ring-1 ${current ? "ring-zinc-700" : "ring-violet-500"}`} title="Default" onClick={() => onPick(null)}>
          A
        </button>
        {DOC_COLORS.map((c) => (
          <button key={c} title={c} onClick={() => onPick(c)} className={`grid size-6 place-items-center rounded text-xs ring-1 ${current === c ? "ring-violet-500" : "ring-zinc-700"}`}>
            {kind === "text" ? (
              <span className="doc-text-color font-semibold" data-color={c}>
                A
              </span>
            ) : (
              <mark className="doc-highlight rounded px-1 text-zinc-100" data-color={c}>
                A
              </mark>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
