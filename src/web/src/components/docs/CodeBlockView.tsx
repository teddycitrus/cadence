import { CodeBlock } from "@tiptap/extension-code-block";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import { useEffect, useId, useState } from "react";
import { canvasEmbedText, parseCanvasEmbed } from "../../../../docs/canvas-embed";
import { CanvasEmbedView } from "./CanvasEmbed";

let mermaidReady: Promise<typeof import("mermaid").default> | null = null;
let mermaidTheme = "";

/** Mermaid in the current theme's colors (set again when the theme changes). */
function loadMermaid() {
  mermaidReady ??= import("mermaid").then((m) => m.default);
  return mermaidReady.then((m) => {
    const theme = document.documentElement.dataset.theme ?? "light";
    if (theme !== mermaidTheme) {
      mermaidTheme = theme;
      const css = getComputedStyle(document.documentElement);
      const c = (name: string) => css.getPropertyValue(`--color-${name}`).trim();
      m.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        fontFamily: css.getPropertyValue("--font-sans").trim(),
        themeVariables: {
          darkMode: theme === "dark",
          background: c("zinc-950"),
          primaryColor: c("zinc-900"),
          primaryTextColor: c("zinc-100"),
          primaryBorderColor: c("violet-500"),
          secondaryColor: c("violet-950"),
          tertiaryColor: c("zinc-800"),
          lineColor: c("zinc-500"),
          textColor: c("zinc-200"),
          noteBkgColor: c("amber-950"),
          noteTextColor: c("zinc-100"),
          noteBorderColor: c("amber-500"),
        },
      });
    }
    return m;
  });
}

/** Renders a mermaid source string to SVG (strict mode: no scripts, no HTML labels). */
export function MermaidDiagram({ source }: { source: string }) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const id = `mmd-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      loadMermaid()
        .then((m) => m.render(id, source))
        .then((r) => !cancelled && (setSvg(r.svg), setError(null)))
        .catch((e: Error) => !cancelled && setError(e.message.split("\n")[0] ?? "Invalid diagram"));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [source, id]);
  if (error) return <p className="text-xs text-red-400">Diagram error: {error}</p>;
  return <div className="overflow-x-auto [&_svg]:mx-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** A ```canvas block: the embedded canvas, with its reference text behind "Edit reference". */
function CanvasBlock({ node, editor, getPos }: ReactNodeViewProps) {
  const [editing, setEditing] = useState(false);
  const embed = parseCanvasEmbed(node.textContent);
  const setText = (text: string) => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.replaceWith(pos + 1, pos + node.nodeSize - 1, editor.schema.text(text));
        return true;
      })
      .run();
  };
  return (
    <NodeViewWrapper className="my-3 rounded-lg bg-zinc-950 p-3 ring-1 ring-zinc-800">
      <div contentEditable={false}>
        <CanvasEmbedView embed={embed} onPick={editor.isEditable ? (e) => setText(canvasEmbedText(e)) : undefined} />
        {editor.isEditable && (
          <button className="mt-1 text-[11px] text-zinc-500 hover:text-zinc-200" onClick={() => setEditing(!editing)}>
            {editing ? "Done" : "Edit reference"}
          </button>
        )}
      </div>
      <pre className={`m-0 mt-1 overflow-x-auto rounded bg-zinc-900 p-2 font-mono text-xs ${editing ? "" : "hidden"}`}>
        <NodeViewContent<"code"> as="code" />
      </pre>
    </NodeViewWrapper>
  );
}

function CodeBlockComponent(props: ReactNodeViewProps) {
  const { node, updateAttributes, editor } = props;
  const language = (node.attrs.language as string | null) ?? "";
  const isMermaid = language === "mermaid";
  if (language === "canvas") return <CanvasBlock {...props} />;
  return (
    <NodeViewWrapper className="my-3 rounded-lg bg-zinc-900 ring-1 ring-zinc-800">
      <div className="flex items-center justify-between border-b border-zinc-800 px-2 py-1" contentEditable={false}>
        <input
          className="w-28 bg-transparent font-mono text-[11px] text-zinc-500 focus:text-zinc-200 focus:outline-none"
          placeholder="language"
          value={language}
          disabled={!editor.isEditable}
          onChange={(e) => updateAttributes({ language: e.target.value.trim() || null })}
        />
        {isMermaid && <span className="text-[11px] text-zinc-500">diagram preview below</span>}
      </div>
      <pre className="m-0 overflow-x-auto bg-transparent p-3 font-mono text-xs">
        <NodeViewContent<"code"> as="code" />
      </pre>
      {isMermaid && (
        <div className="border-t border-zinc-800 bg-zinc-950 p-3" contentEditable={false}>
          <MermaidDiagram source={node.textContent} />
        </div>
      )}
    </NodeViewWrapper>
  );
}

/** Code blocks with an editable language label and live mermaid diagrams. */
export const CodeBlockWithPreview = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockComponent);
  },
});
