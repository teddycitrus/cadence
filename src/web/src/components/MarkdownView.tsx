import { memo, useEffect, useState } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { docSanitizeSchema, hasDocColorTags } from "./docs/color-names";
import { parseCanvasEmbed } from "../../../docs/canvas-embed";
import { CanvasEmbedView } from "./docs/CanvasEmbed";
import { openWorkspaceFile, runInWorkspace } from "./chat/RunButton";

const isCanvas = (className: unknown) => Array.isArray(className) ? className.includes("language-canvas") : className === "language-canvas";
const languageOf = (className: unknown) => String((Array.isArray(className) ? className.find((c) => String(c).startsWith("language-")) : className) ?? "").replace(/^language-/, "");
const SHELL = new Set(["bash", "sh", "shell", "zsh", "console", "powershell", "ps1", "pwsh", "cmd", "bat"]);
/** A repo-relative file path like src/app/page.tsx (not a URL, not a bare word). */
const FILE_PATH = /^(?:\.\/)?(?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]{1,8}$/;

function CodeBlock({ text, language, workspaceId, children }: { text: string; language: string; workspaceId?: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const runnable = workspaceId && (SHELL.has(language) || (!language && !text.includes("\n") && text.length < 300));
  return (
    <div className="group relative">
      <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 transition group-hover:opacity-100">
        {language && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">{language}</span>}
        <button
          className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-700"
          onClick={() =>
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? "Copied" : "Copy"}
        </button>
        {runnable && (
          <button className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-700" title="Run in this workspace's terminal" onClick={() => runInWorkspace({ workspaceId: workspaceId!, name: "snippet", command: text.trim() })}>
            ▶ Run
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

// Parsing raw HTML pulls in a full HTML parser, and the only raw HTML views
// render is doc color tags, so it loads the first time a text has one.
let rehypeRaw: Pluggable | null = null;
let loadingRaw: Promise<void> | null = null;
type Pluggable = NonNullable<Options["rehypePlugins"]>[number];

function useRawHtml(text: string): Pluggable | null {
  const needed = hasDocColorTags(text);
  const [, loaded] = useState(0);
  useEffect(() => {
    if (!needed || rehypeRaw) return;
    loadingRaw ??= import("rehype-raw").then((m) => void (rehypeRaw = m.default));
    let live = true;
    void loadingRaw.then(() => live && loaded((n) => n + 1));
    return () => void (live = false);
  }, [needed]);
  return needed ? rehypeRaw : null;
}

/**
 * Renders agent- or user-written markdown. Raw HTML is sanitized: only safe tags render.
 * ```canvas blocks become canvas previews; on public pages (`embeds: "static"`)
 * they only say which canvas they are, since previews need a signed-in viewer.
 * Inside a workspace chat (`workspaceId`), code blocks can run in its terminal
 * and file paths open in its Files panel (canvases open on the board).
 */
// Memoized: re-renders of a list (comments, a transcript) skip parsing text that did not change.
export const MarkdownView = memo(function MarkdownView({ children, embeds = "preview", workspaceId }: { children: string; embeds?: "preview" | "static"; workspaceId?: string }) {
  const raw = useRawHtml(children);
  const components: Components = {
    pre({ node, children: inner, ...rest }) {
      const first = node?.children[0];
      if (first && first.type === "element" && first.tagName === "code" && isCanvas(first.properties.className)) {
        const text = first.children.map((c) => (c.type === "text" ? c.value : "")).join("");
        return <CanvasEmbedView embed={parseCanvasEmbed(text)} mode={embeds} />;
      }
      if (first && first.type === "element" && first.tagName === "code" && embeds === "preview") {
        const text = first.children.map((c) => (c.type === "text" ? c.value : "")).join("");
        return (
          <CodeBlock text={text} language={languageOf(first.properties.className)} workspaceId={workspaceId}>
            <pre {...rest}>{inner}</pre>
          </CodeBlock>
        );
      }
      return <pre {...rest}>{inner}</pre>;
    },
    code({ node, children: inner, className, ...rest }) {
      const text = typeof inner === "string" ? inner : Array.isArray(inner) && inner.every((x) => typeof x === "string") ? inner.join("") : null;
      // Inline code only (blocks have a language class or sit inside <pre>).
      const inline = !className && node?.position?.start.line === node?.position?.end.line;
      if (workspaceId && inline && text && FILE_PATH.test(text)) {
        const path = text.replace(/^\.\//, "");
        const canvas = /\.canvas\.[jt]sx?$/.test(path);
        return (
          <button
            className="rounded bg-zinc-800 px-1 font-mono text-[0.9em] text-violet-300 hover:bg-zinc-700 hover:underline"
            title={canvas ? "Open this canvas" : "Open in the Files panel"}
            onClick={() => (canvas ? (window.location.hash = `/canvas/${encodeURIComponent(`${workspaceId}|${path}`)}`) : openWorkspaceFile({ workspaceId, path }))}
          >
            {text}
          </button>
        );
      }
      return (
        <code className={className} {...rest}>
          {inner}
        </code>
      );
    },
    // ![label](/api/assets/id "video") is a recording; only our own uploads play inline.
    img({ node: _node, src, alt, title, ...rest }) {
      if (title === "video" && typeof src === "string" && src.startsWith("/api/assets/")) return <video src={src} controls className="my-2 max-h-96 max-w-full rounded-lg bg-black" aria-label={alt} />;
      return <img src={src} alt={alt} title={title} {...rest} />;
    },
  };
  return (
    <div className="prose-doc">
      {/* Raw HTML passes only through the sanitizer: doc colors and GitHub's safe tags. */}
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[...(raw ? [raw] : []), [rehypeSanitize, docSanitizeSchema]]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
