import { Image } from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor, type Editor, type JSONContent } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { StarterKit } from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import type { CollabProvider } from "./collab";
import { CodeBlockWithPreview } from "./CodeBlockView";
import { ColorHighlight, TextColor } from "./colors";
import { ColorMenu, TurnInto } from "./FormatMenu";
import { askAboutPrompt, askDocAi, continueWritingPrompt } from "./doc-ai";

interface Block {
  label: string;
  hint: string;
  run: (e: Editor) => void;
}

const BLOCKS: Block[] = [
  { label: "Heading 1", hint: "Big section title", run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() },
  { label: "Heading 2", hint: "Section title", run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { label: "Heading 3", hint: "Subsection", run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
  { label: "Heading 4", hint: "Small heading", run: (e) => e.chain().focus().toggleHeading({ level: 4 }).run() },
  { label: "Bullet list", hint: "Unordered list", run: (e) => e.chain().focus().toggleBulletList().run() },
  { label: "Numbered list", hint: "Ordered list", run: (e) => e.chain().focus().toggleOrderedList().run() },
  { label: "Task list", hint: "Checklist", run: (e) => e.chain().focus().toggleTaskList().run() },
  { label: "Quote", hint: "Blockquote", run: (e) => e.chain().focus().toggleBlockquote().run() },
  { label: "Code block", hint: "Monospaced code", run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { label: "Diagram", hint: "Mermaid flowchart", run: (e) => e.chain().focus().insertContent({ type: "codeBlock", attrs: { language: "mermaid" }, content: [{ type: "text", text: "flowchart LR\n  A[Idea] --> B[Spec] --> C[Build]" }] }).run() },
  { label: "Canvas", hint: "Embed a canvas or frame", run: (e) => e.chain().focus().insertContent({ type: "codeBlock", attrs: { language: "canvas" } }).run() },
  { label: "Table", hint: "3 x 3 table", run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { label: "Divider", hint: "Horizontal rule", run: (e) => e.chain().focus().setHorizontalRule().run() },
  { label: "Keep writing", hint: "The assistant drafts the next part from here", run: (e) => askDocAi(continueWritingPrompt(e.state.doc.textBetween(0, e.state.selection.from, "\n"))) },
  { label: "Table of contents", hint: "A list of this doc's headings", run: (e) => e.chain().focus().insertContent(tableOfContents(e)).run() },
  {
    label: "Emoji",
    hint: "Insert an emoji",
    run: (e) => {
      const at = e.view.coordsAtPos(e.state.selection.from);
      window.dispatchEvent(new CustomEvent("cadence:emoji", { detail: { top: at.bottom + 6, left: at.left } }));
    },
  },
];

/** The "/query" the cursor sits at the end of, if the current block starts with one. */
/** The doc's headings as a nested bullet list (a snapshot; insert it again to refresh). */
function tableOfContents(editor: Editor): JSONContent {
  const headings: { level: number; text: string }[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "heading" && node.textContent.trim()) headings.push({ level: Number(node.attrs.level), text: node.textContent.trim() });
  });
  const item = (text: string) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
  if (!headings.length) return { type: "paragraph", content: [{ type: "text", text: "Add headings, then insert the table of contents again." }] };
  const top = Math.min(...headings.map((h) => h.level));
  return { type: "bulletList", content: headings.map((h) => item(`${"  ".repeat(h.level - top)}${h.text}`)) };
}

const EMOJI = ["\u{1F44D}", "\u{1F44E}", "\u{1F389}", "\u{1F680}", "\u{2705}", "\u{274C}", "\u{26A0}\u{FE0F}", "\u{1F4A1}", "\u{1F4CC}", "\u{1F4DD}", "\u{1F41B}", "\u{1F525}", "\u{2728}", "\u{1F914}", "\u{1F440}", "\u{2764}\u{FE0F}", "\u{1F600}", "\u{1F642}", "\u{1F622}", "\u{1F4C8}", "\u{1F4C9}", "\u{1F512}", "\u{1F511}", "\u{1F6A7}", "\u{1F3AF}", "\u{1F4E6}", "\u{1F527}", "\u{1F9EA}", "\u{23F3}", "\u{1F4C5}", "\u{1F465}", "\u{1F4AC}"];

/** The anchor a heading's link points at: its text, lowercased and dashed. */
export const headingSlug = (text: string) =>
  text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");

function slashQuery(editor: Editor): { query: string; from: number } | null {
  const { $from, empty } = editor.state.selection;
  if (!empty || $from.parent.type.name !== "paragraph") return null;
  const text = $from.parent.textBetween(0, $from.parentOffset);
  const m = /^\/([\w ]*)$/.exec(text);
  return m ? { query: m[1]!.toLowerCase(), from: $from.start() } : null;
}

const fmt = "rounded px-2 py-1 text-xs hover:bg-zinc-700";

export function RichEditor({
  markdown,
  editable,
  onChange,
  uploadImage,
  collab,
  onLoaded,
}: {
  markdown: string;
  editable: boolean;
  onChange: (markdown: string) => void;
  uploadImage: (file: File) => Promise<string>;
  /** Live co-editing: the room's shared document and this person's caret. */
  collab?: { provider: CollabProvider; user: { name: string; color: string } };
  /** In a room, after content was loaded from markdown (seed or outside edit), with the editor's markdown. */
  onLoaded?: (markdown: string, version: number) => void;
}) {
  const [slash, setSlash] = useState<{ query: string; from: number; top: number; caretTop: number; left: number } | null>(null);
  const [emoji, setEmoji] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    const on = (e: Event) => setEmoji((e as CustomEvent<{ top: number; left: number }>).detail);
    window.addEventListener("cadence:emoji", on);
    return () => window.removeEventListener("cadence:emoji", on);
  }, []);
  const [active, setActive] = useState(0);
  const lastEmitted = useRef(markdown);
  // Only edits a person makes count. Loading content (and the editor normalizing
  // it, e.g. fixing tables) also fires updates, and those must never be saved.
  const touched = useRef(false);
  const touch = () => {
    touched.current = true;
    return false;
  };
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Editor callbacks are created once; they reach the live editor through this ref.
  const editorRef = useRef<Editor | null>(null);
  // Turning the whole doc into Markdown costs time that grows with its length, so a burst
  // of typing is converted once, shortly after; anything pending is flushed before the editor
  // loses focus, unmounts, or the page goes away, and before outside content is loaded.
  const pending = useRef<number | null>(null);
  const flush = () => {
    if (pending.current === null) return;
    window.clearTimeout(pending.current);
    pending.current = null;
    const e = editorRef.current;
    if (!e || e.isDestroyed) return;
    const md = e.getMarkdown();
    lastEmitted.current = md;
    onChangeRef.current(md);
  };

  const insertImages = (editor: Editor, files: File[], pos?: number) => {
    for (const file of files.filter((f) => f.type.startsWith("image/"))) {
      void uploadImage(file).then((src) => {
        const chain = editor.chain().focus();
        (pos !== undefined ? chain.insertContentAt(pos, { type: "image", attrs: { src, alt: file.name } }) : chain.setImage({ src, alt: file.name })).run();
      });
    }
  };

  const editor = useEditor({
    extensions: [
      // Yjs keeps its own undo history in a shared room.
      StarterKit.configure({ codeBlock: false, link: { openOnClick: false, autolink: true }, ...(collab ? { undoRedo: false as const } : {}) }),
      ...(collab ? [Collaboration.configure({ document: collab.provider.doc }), CollaborationCaret.configure({ provider: collab.provider, user: collab.user })] : []),
      CodeBlockWithPreview,
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: false } }),
      Image,
      // Saved as ==text== (or <mark data-color> with a color) and <span data-color> in the markdown.
      ColorHighlight,
      TextColor,
      Placeholder.configure({ placeholder: "Write, or type / for blocks" }),
      Markdown,
    ],
    // In a room the shared document is the content; it is seeded by the server.
    ...(collab ? {} : { content: markdown, contentType: "markdown" as const }),
    editable,
    editorProps: {
      attributes: { class: "prose-doc tiptap min-h-[50vh] focus:outline-none" },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])];
        if (!files.some((f) => f.type.startsWith("image/")) || !editorRef.current) return false;
        insertImages(editorRef.current, files);
        return true;
      },
      handleDrop: (view, event) => {
        const files = [...(event.dataTransfer?.files ?? [])];
        if (!files.some((f) => f.type.startsWith("image/")) || !editorRef.current) return false;
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        insertImages(editorRef.current, files, pos);
        return true;
      },
      handleDOMEvents: { keydown: touch, beforeinput: touch, input: touch, compositionstart: touch, paste: touch, drop: touch, mousedown: touch, cut: touch },
      handleKeyDown: (_view, event) => {
        if (!slashRef.current) return false;
        const items = filtered(slashRef.current.query);
        if (event.key === "ArrowDown") return (setActive((a) => (a + 1) % Math.max(items.length, 1)), true);
        if (event.key === "ArrowUp") return (setActive((a) => (a - 1 + items.length) % Math.max(items.length, 1)), true);
        if (event.key === "Enter" && items.length) return (choose(items[activeRef.current % items.length]!), true);
        if (event.key === "Escape") return (setSlash(null), true);
        return false;
      },
    },
    onUpdate: ({ editor: e }) => {
      // In a room, others' edits count too (the saver writes them back).
      if (!collab && !touched.current) return;
      const q = slashQuery(e);
      if (q) {
        // A half-typed "/command" is not content; wait until a block is picked.
        const coords = e.view.coordsAtPos(e.state.selection.from);
        setSlash({ ...q, top: coords.bottom + 6, caretTop: coords.top, left: coords.left });
        return;
      }
      setSlash(null);
      editorRef.current = e;
      if (pending.current !== null) window.clearTimeout(pending.current);
      pending.current = window.setTimeout(flush, 150);
    },
    onBlur: () => flush(),
    onSelectionUpdate: ({ editor: e }) => {
      if (!slashQuery(e)) setSlash(null);
    },
  });

  editorRef.current = editor;
  const slashRef = useRef(slash);
  slashRef.current = slash;
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => setActive(0), [slash?.query]);

  function filtered(query: string) {
    return BLOCKS.filter((b) => b.label.toLowerCase().includes(query));
  }
  function choose(block: Block) {
    const s = slashRef.current;
    const ed = editorRef.current;
    if (!ed || !s) return;
    ed.chain().focus().deleteRange({ from: s.from, to: ed.state.selection.from }).run();
    block.run(ed);
    setSlash(null);
  }

  // In a room, the server says when to load markdown: once when the room is
  // empty, and when the doc changed outside the room.
  useEffect(() => {
    if (!editor || !collab) return;
    const apply = () => {
      const c = collab.provider.takeLoad();
      if (!c) return;
      editor.commands.setContent(c.markdown, { contentType: "markdown", emitUpdate: false });
      onLoadedRef.current?.(editor.getMarkdown(), c.version);
    };
    apply();
    return collab.provider.on((c) => (c.type === "seed" || c.type === "reset" ? apply() : undefined));
  }, [editor, collab]);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  // Content changed outside the editor (an agent edit, a restore): load it.
  useEffect(() => {
    if (collab) return;
    if (!editor || markdown === lastEmitted.current) return;
    flush();
    if (markdown === lastEmitted.current) return;
    lastEmitted.current = markdown;
    touched.current = false;
    editor.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false });
  }, [markdown, editor]);

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editable, editor]);

  useEffect(() => {
    const hide = () => flush();
    window.addEventListener("pagehide", hide);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("pagehide", hide);
      document.removeEventListener("visibilitychange", hide);
      flush();
    };
  }, []);

  if (!editor) return null;
  const items = slash ? filtered(slash.query) : [];

  return (
    <div className="relative">
      <BubbleMenu editor={editor} onMouseDown={touch} className="flex items-center gap-0.5 rounded-lg bg-zinc-800 p-1 shadow-xl ring-1 ring-zinc-700">
        <button className={`${fmt} font-bold ${editor.isActive("bold") ? "bg-zinc-700" : ""}`} onClick={() => editor.chain().focus().toggleBold().run()}>
          B
        </button>
        <button className={`${fmt} italic ${editor.isActive("italic") ? "bg-zinc-700" : ""}`} onClick={() => editor.chain().focus().toggleItalic().run()}>
          I
        </button>
        <button className={`${fmt} line-through ${editor.isActive("strike") ? "bg-zinc-700" : ""}`} onClick={() => editor.chain().focus().toggleStrike().run()}>
          S
        </button>
        <button className={`${fmt} font-mono ${editor.isActive("code") ? "bg-zinc-700" : ""}`} onClick={() => editor.chain().focus().toggleCode().run()}>
          {"<>"}
        </button>
        {editor.isActive("heading") && (
          <button
            className={fmt}
            title="Copy a link to this heading"
            onClick={() => {
              const text = editor.state.selection.$from.parent.textContent;
              void navigator.clipboard.writeText(`${location.origin}${location.pathname}${location.hash.split("?")[0]}?h=${encodeURIComponent(headingSlug(text))}`);
            }}
          >
            #
          </button>
        )}
        <button className={`${fmt} ${editor.isActive("highlight") ? "bg-zinc-700" : ""}`} onClick={() => editor.chain().focus().toggleHighlight().run()} title="Highlight">
          <span className="rounded-sm bg-yellow-300/60 px-0.5 text-zinc-950">H</span>
        </button>
        <ColorMenu editor={editor} />
        <button
          className={fmt}
          title="Ask the doc's AI about the selected text"
          onClick={() => {
            const { from, to } = editor.state.selection;
            askDocAi(askAboutPrompt(editor.state.doc.textBetween(from, to, "\n")));
          }}
        >
          Ask the assistant
        </button>
        <TurnInto editor={editor} />
        <button
          className={`${fmt} ${editor.isActive("link") ? "bg-zinc-700" : ""}`}
          onClick={() => {
            const url = window.prompt("Link URL", editor.getAttributes("link").href ?? "https://");
            if (url === null) return;
            if (!url) editor.chain().focus().unsetLink().run();
            else if (/^(https?:|mailto:|#|\/)/.test(url)) editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
          }}
        >
          Link
        </button>
      </BubbleMenu>
      <EditorContent editor={editor} />
      {emoji && editor && (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={() => setEmoji(null)} />
          <div className="fixed z-50 grid w-64 grid-cols-8 gap-0.5 rounded-lg bg-zinc-900 p-1.5 shadow-2xl ring-1 ring-zinc-700" style={{ top: Math.min(emoji.top, window.innerHeight - 160), left: emoji.left }}>
            {EMOJI.map((em) => (
              <button
                key={em}
                className="rounded p-1 text-lg hover:bg-zinc-800"
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  editor.chain().focus().insertContent(em).run();
                  setEmoji(null);
                }}
              >
                {em}
              </button>
            ))}
          </div>
        </>
      )}
      {slash && items.length > 0 && (
        <ul className="fixed z-50 w-64 rounded-lg bg-zinc-900 p-1 shadow-2xl ring-1 ring-zinc-700" style={slash.top + 360 > window.innerHeight ? { bottom: window.innerHeight - slash.caretTop + 6, left: slash.left } : { top: slash.top, left: slash.left }}>
          {items.map((b, i) => (
            <li key={b.label}>
              <button onMouseDown={(e) => (e.preventDefault(), choose(b))} className={`flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm ${i === active % items.length ? "bg-zinc-800" : ""}`}>
                {b.label}
                <span className="text-xs text-zinc-500">{b.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
