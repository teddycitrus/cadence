import { lazy, Suspense } from "react";

// The Markdown renderer (parser, GFM, sanitizer) is a large part of the app, and
// nothing needs it before the first screen paints. It loads right after startup;
// anything shown before it arrives appears as plain text in the same style.
const load = () => import("./MarkdownView");
const MarkdownView = lazy(() => load().then((m) => ({ default: m.MarkdownView })));
if (typeof window !== "undefined") {
  const start = () => void load();
  if ("requestIdleCallback" in window) window.requestIdleCallback(start, { timeout: 1500 });
  else setTimeout(start, 200);
}

type Props = { children: string; embeds?: "preview" | "static"; workspaceId?: string };

/** Renders agent- or user-written markdown (see MarkdownView for what it supports). */
export function Markdown(props: Props) {
  return (
    <Suspense fallback={<div className="prose-doc whitespace-pre-wrap">{props.children}</div>}>
      <MarkdownView {...props} />
    </Suspense>
  );
}
