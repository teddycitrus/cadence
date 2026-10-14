import { forwardRef, useEffect, useRef, useState } from "react";
import type { CanvasFrame, StoryboardInfo } from "../../api";

/** Interact uses the frame like the real app: clicks reach it and nothing gets selected. */
export type Tool = "move" | "select" | "interact" | "comment" | "div" | "rectangle" | "text";

/** The canvas toolbar, with keyboard shortcuts. */
export const CANVAS_TOOLS: { id: Tool; key: string; label: string }[] = [
  { id: "move", key: "v", label: "Move" },
  { id: "select", key: "s", label: "Select" },
  { id: "interact", key: "i", label: "Interact" },
  { id: "div", key: "d", label: "Div" },
  { id: "rectangle", key: "r", label: "Rectangle" },
  { id: "text", key: "t", label: "Text" },
  { id: "comment", key: "c", label: "Comment" },
];

/** Tools that click an element to act on it (select it, or draw a new element inside it). */
export const PICKS_ELEMENTS = (tool: Tool) => tool === "select" || tool === "div" || tool === "rectangle" || tool === "text";

const KIND: Record<StoryboardInfo["kind"], string> = { component: "Component", route: "Route", html: "HTML", svelte: "Svelte" };

/** Frame sizes by kind of screen or format, in CSS pixels. */
export const PRESET_GROUPS: { group: string; sizes: [string, number, number][] }[] = [
  { group: "Phone", sizes: [["iPhone 16", 393, 852], ["iPhone 16 Pro Max", 440, 956], ["iPhone SE", 375, 667], ["Android small", 360, 640], ["Android large", 412, 915]] },
  { group: "Tablet", sizes: [["iPad mini", 744, 1133], ["iPad Pro 11", 834, 1210], ["iPad Pro 13", 1032, 1376], ["Surface Pro", 1368, 912]] },
  { group: "Desktop", sizes: [["MacBook Air", 1280, 832], ["Laptop", 1366, 768], ["Desktop", 1440, 900], ["Wide", 1920, 1080], ["Ultrawide", 2560, 1080]] },
  { group: "Watch", sizes: [["Watch 41mm", 176, 215], ["Watch 45mm", 198, 242]] },
  { group: "Social", sizes: [["Instagram post", 1080, 1080], ["Instagram story", 1080, 1920], ["X post", 1600, 900], ["X header", 1500, 500], ["LinkedIn cover", 1584, 396], ["Facebook cover", 820, 312], ["YouTube thumbnail", 1280, 720], ["Dribbble shot", 1600, 1200]] },
  { group: "Slides and print", sizes: [["Slide 16:9", 1920, 1080], ["Slide 4:3", 1024, 768], ["A4", 794, 1123], ["Letter", 816, 1056], ["Tabloid", 1056, 1632]] },
];

/**
 * One frame on the board: a title bar to drag, a corner to resize, and
 * the live page in an iframe. Moves and resizes are committed (written to
 * source) when the pointer is released.
 */
export const FrameView = forwardRef<HTMLIFrameElement, {
  story: StoryboardInfo;
  src: string | null;
  /** Shown in place of the frame when there is nothing to load (and why). */
  notice?: string;
  zoom: number;
  tool: Tool;
  selected: boolean;
  /** Part of a multi-selection (Shift+click on the title). */
  picked?: boolean;
  onPick?: () => void;
  error: string | null;
  vrt: string | null;
  onCommit: (frame: CanvasFrame) => void;
  onMenu: (action: "duplicate" | "remove" | "check" | "open" | "lock" | "detach" | "cover" | "track" | "copy" | "props" | "snapshot") => void;
  onComment: (x: number, y: number) => void;
}>(function FrameView({ story, src, notice, zoom, tool, selected, picked = false, onPick, error, vrt, onCommit, onMenu, onComment }, iframeRef) {
  const [frame, setFrame] = useState(story.frame);
  const [menu, setMenu] = useState(false);
  // Route frames get a browser bar: where the page is, and back, forward, reload, go.
  const local = useRef<HTMLIFrameElement | null>(null);
  const setRef = (el: HTMLIFrameElement | null) => {
    local.current = el;
    if (typeof iframeRef === "function") iframeRef(el);
    else if (iframeRef) iframeRef.current = el;
  };
  const [where, setWhere] = useState(story.route ?? "/");
  useEffect(() => {
    if (story.kind !== "route") return;
    const on = (e: MessageEvent) => {
      if (e.source !== local.current?.contentWindow || e.data?.source !== "cadence-canvas" || e.data.type !== "location") return;
      setWhere(String(e.data.path));
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [story.kind]);
  const nav = (action: "back" | "forward" | "reload" | "go", path?: string) => {
    const w = local.current?.contentWindow;
    if (w && src) w.postMessage({ source: "cadence-host", type: "nav", action, path }, new URL(src, window.location.href).origin);
  };
  const drag = useRef<{ kind: "move" | "resize"; x: number; y: number; start: CanvasFrame } | null>(null);
  useEffect(() => {
    if (!drag.current) setFrame(story.frame);
  }, [story.frame.x, story.frame.y, story.frame.width, story.frame.height]);

  const start = (kind: "move" | "resize") => (e: React.PointerEvent) => {
    if (e.button === 0 && e.shiftKey && kind === "move" && onPick) {
      e.stopPropagation();
      return onPick();
    }
    if (e.button !== 0 || story.locked) return;
    e.stopPropagation();
    drag.current = { kind, x: e.clientX, y: e.clientY, start: frame };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.x) / zoom;
    const dy = (e.clientY - d.y) / zoom;
    setFrame(d.kind === "move" ? { ...d.start, x: Math.round(d.start.x + dx), y: Math.round(d.start.y + dy) } : { ...d.start, width: Math.max(40, Math.round(d.start.width + dx)), height: Math.max(40, Math.round(d.start.height + dy)) });
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    if (d && (frame.x !== d.start.x || frame.y !== d.start.y || frame.width !== d.start.width || frame.height !== d.start.height)) onCommit(frame);
  };

  return (
    <div className="absolute" style={{ left: frame.x, top: frame.y, width: frame.width }}>
      <div
        className={`absolute -top-7 left-0 flex h-6 max-w-full items-center gap-2 text-xs ${tool === "move" && !story.locked ? "cursor-move" : ""}`}
        style={{ transform: `scale(${1 / zoom})`, transformOrigin: "bottom left", width: frame.width * zoom }}
        onPointerDown={start("move")}
        onPointerMove={move}
        onPointerUp={end}
      >
        <span className={`min-w-0 shrink truncate font-medium ${selected || picked ? "text-violet-300" : "text-zinc-300"} ${picked ? "rounded bg-violet-500/20 px-1" : ""}`}>{story.name}</span>
        <span className="min-w-0 truncate text-zinc-500">
          {KIND[story.kind]} · {frame.width}×{frame.height}
        </span>
        {story.kind === "route" && (
          <span className="flex shrink-0 items-center gap-0.5 text-zinc-500" onPointerDown={(e) => e.stopPropagation()}>
            <button className="rounded px-1 hover:bg-zinc-800 hover:text-zinc-100" title="Back" onClick={() => nav("back")}>
              ‹
            </button>
            <button className="rounded px-1 hover:bg-zinc-800 hover:text-zinc-100" title="Forward" onClick={() => nav("forward")}>
              ›
            </button>
            <button className="rounded px-1 hover:bg-zinc-800 hover:text-zinc-100" title="Reload" onClick={() => nav("reload")}>
              ↻
            </button>
            <input
              className="w-32 rounded bg-zinc-900 px-1 font-mono text-[10px] text-zinc-300 ring-1 ring-zinc-800 focus:outline-none"
              title="This frame's URL path; Enter to go"
              value={where}
              onChange={(e) => setWhere(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && nav("go", where.startsWith("/") ? where : `/${where}`)}
            />
          </span>
        )}
        {story.locked && <span className="shrink-0 rounded bg-amber-950 px-1 text-[10px] text-amber-300">locked</span>}
        {vrt && <span className={`shrink-0 rounded px-1 text-[10px] ${vrt === "pass" ? "bg-emerald-950 text-emerald-300" : vrt === "new" ? "bg-zinc-800 text-zinc-300" : "bg-red-950 text-red-300"}`}>{vrt}</span>}
        <button
          className="ml-auto shrink-0 rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setMenu(!menu)}
        >
          •••
        </button>
        {menu && (
          <div className="absolute top-6 right-0 z-20 w-40 rounded-md bg-zinc-900 py-1 shadow-xl ring-1 ring-zinc-700" onPointerDown={(e) => e.stopPropagation()}>
            {(
              [
                ["open", "Open in new tab"],
                ["check", "Check visuals"],
                ["track", story.vrt.enabled ? "Untrack visual test" : "Track visual test"],
                ...(story.kind === "component" || story.kind === "svelte" ? [["props", "Edit props"] as const] : []),
                ["copy", "Copy as image"],
                ...(story.kind !== "html" ? [["snapshot", "Freeze as HTML"] as const] : []),
                ["duplicate", "Duplicate"],
                ["cover", "Use as cover"],
                ["lock", story.locked ? "Unlock position" : "Lock position"],
                ...(story.kind === "component" ? ([["detach", "Fork a component..."]] as const) : []),
                ["remove", "Delete frame"],
              ] as const
            ).map(([a, label]) => (
              <button
                key={a}
                className={`block w-full px-3 py-1 text-left hover:bg-zinc-800 ${a === "remove" ? "text-red-400" : "text-zinc-200"}`}
                onClick={() => {
                  setMenu(false);
                  onMenu(a);
                }}
              >
                {label}
              </button>
            ))}
            <div className="my-1 border-t border-zinc-800" />
            <select
              className="mx-2 mb-1 w-[calc(100%-1rem)] rounded bg-zinc-800 px-1 py-1 text-zinc-300"
              value=""
              disabled={story.locked}
              title="Resize to a device or format"
              onChange={(e) => {
                const [width, height] = e.target.value.split("x").map(Number) as [number, number];
                setMenu(false);
                const next = { ...frame, width, height };
                setFrame(next);
                onCommit(next);
              }}
            >
              <option value="">Frame size...</option>
              {PRESET_GROUPS.map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.sizes.map(([name, w, h]) => (
                    <option key={name} value={`${w}x${h}`}>
                      {name} ({w}×{h})
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className={`relative bg-white shadow-2xl ${selected ? "outline-2 outline-violet-500" : "outline outline-zinc-700/60"}`} style={{ width: frame.width, height: frame.height }}>
        {src ? (
          <iframe ref={setRef} src={src} title={story.name} className="block h-full w-full border-0" style={{ pointerEvents: (PICKS_ELEMENTS(tool) || tool === "interact") && !drag.current ? "auto" : "none" }} />
        ) : (
          <div className={`grid h-full place-items-center bg-zinc-900 p-8 text-center text-zinc-500 ${notice ? "text-2xl leading-relaxed" : "text-xs"}`}>{notice ?? "Starting canvas server..."}</div>
        )}
        {tool === "comment" && (
          <div
            className="absolute inset-0 cursor-crosshair"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onComment(frame.x + (e.clientX - r.left) / zoom, frame.y + (e.clientY - r.top) / zoom);
            }}
          />
        )}
        {error && <div className="absolute inset-x-0 bottom-0 max-h-1/2 overflow-auto bg-red-950/90 p-2 font-mono text-[11px] text-red-200">{error}</div>}
        {!story.locked && <div className="absolute -right-1.5 -bottom-1.5 size-3 cursor-nwse-resize rounded-sm bg-violet-500" style={{ transform: `scale(${1 / zoom})` }} onPointerDown={start("resize")} onPointerMove={move} onPointerUp={end} />}
      </div>
    </div>
  );
});
