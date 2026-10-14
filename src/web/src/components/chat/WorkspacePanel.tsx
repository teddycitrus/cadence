import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { BROWSE_EVENT, type BrowseDetail } from "../../links";
import type { Snapshot, Workspace } from "../../../../core/types";
import type { RunDetail } from "./RunButton";
import { ChangesPanel } from "./ChangesPanel";
import { LogoLoader } from "../Logo";

// The editor (CodeMirror) and terminal (xterm) are large; they load when their tab first opens.
// Each tab's code loads when its tab is pointed at (just before the click), so it is usually ready on arrival.
const LOADERS = {
  files: () => import("./FilesPanel"),
  terminal: () => import("../terminal/TerminalPanel"),
  git: () => import("../git/SourceControl"),
  browser: () => import("./BrowserPanel"),
} as const;
const FilesPanel = lazy(() => LOADERS.files().then((m) => ({ default: m.FilesPanel })));
const TerminalPanel = lazy(() => LOADERS.terminal().then((m) => ({ default: m.TerminalPanel })));
const SourceControl = lazy(() => LOADERS.git().then((m) => ({ default: m.SourceControl })));
const BrowserPanel = lazy(() => LOADERS.browser().then((m) => ({ default: m.BrowserPanel })));
const prefetch = (t: string) => void (LOADERS as Record<string, (() => Promise<unknown>) | undefined>)[t]?.();
const loading = <LogoLoader />;

type Tab = "review" | "git" | "files" | "terminal" | "browser";
const WIDTH_KEY = "cadence.panelWidth";

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: "review", label: "Review", hint: "Everything this branch changes against its base" },
  { id: "git", label: "Source control", hint: "Stage, commit, sync, and open a pull request" },
  { id: "files", label: "Files", hint: "Browse and edit this workspace's files" },
  { id: "terminal", label: "Terminal", hint: "Shells in this workspace's folder" },
  { id: "browser", label: "Browser", hint: "A browser for trying the app; agents here use it too" },
];

/** The workspace side panel. The terminal stays mounted while hidden so its shells keep streaming. */
export function WorkspacePanel({
  ws,
  snapshot,
  run,
  openPath,
  overlay = false,
  onClose,
}: {
  ws: Workspace;
  snapshot: Snapshot;
  run?: (RunDetail & { n: number }) | null;
  openPath?: { path: string; n: number } | null;
  /** Opened over the chat (narrow windows) rather than beside it. */
  overlay?: boolean;
  onClose?: () => void;
}) {
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (localStorage.getItem("cadence.panelTab") as Tab | null) ?? "review";
    } catch {
      return "review";
    }
  });
  const [terminalSeen, setTerminalSeen] = useState(tab === "terminal");
  const chatIds = useMemo(() => new Set(snapshot.chats.filter((c) => c.workspaceId === ws.id).map((c) => c.id)), [snapshot.chats, ws.id]);
  // Source control is the most used tab; fetch it once the workspace view has settled.
  useEffect(() => {
    const t = window.setTimeout(() => prefetch("git"), 1500);
    return () => window.clearTimeout(t);
  }, []);
  const [browse, setBrowse] = useState<{ url: string; n: number } | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<BrowseDetail>).detail;
      if (d.workspaceId !== ws.id) return;
      pick("browser");
      setBrowse((b) => ({ url: d.url, n: (b?.n ?? 0) + 1 }));
    };
    window.addEventListener(BROWSE_EVENT, on);
    return () => window.removeEventListener(BROWSE_EVENT, on);
  }, [ws.id]);
  useEffect(() => {
    const on = () => pick("terminal");
    window.addEventListener("cadence:open-terminal", on);
    return () => window.removeEventListener("cadence:open-terminal", on);
  }, []);
  useEffect(() => {
    if (run) pick("terminal");
  }, [run?.n]);
  useEffect(() => {
    if (openPath) pick("files");
  }, [openPath?.n]);
  const pick = (t: Tab) => {
    setTab(t);
    if (t === "terminal") setTerminalSeen(true);
    try {
      localStorage.setItem("cadence.panelTab", t);
    } catch {
      // storage unavailable
    }
  };

  // Each tab has a natural width until the panel is dragged; it never takes more than 60% of the row.
  const [width, setWidth] = useState<number | null>(() => {
    try {
      return Number(localStorage.getItem(WIDTH_KEY)) || null;
    } catch {
      return null;
    }
  });
  const resize = (e: React.PointerEvent<HTMLDivElement>) => {
    const aside = e.currentTarget.parentElement!;
    const start = e.clientX;
    const from = aside.getBoundingClientRect().width;
    let last = from;
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      last = Math.max(288, from + start - m.clientX);
      setWidth(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(WIDTH_KEY, String(Math.round(last)));
      } catch {
        // storage unavailable
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const resetWidth = () => {
    setWidth(null);
    try {
      localStorage.removeItem(WIDTH_KEY);
    } catch {
      // storage unavailable
    }
  };

  return (
    <aside
      className={`flex min-w-72 shrink-0 flex-col border-l border-zinc-800 ${overlay ? "absolute inset-y-0 right-0 z-30 max-w-[92%] bg-zinc-950 shadow-2xl" : "relative max-w-[50%]"} ${width ? "" : tab === "terminal" ? "w-[34rem]" : tab === "browser" ? "w-[38rem]" : tab === "files" ? "w-[40rem]" : "w-96"}`}
      style={width ? { width } : undefined}
    >
      <div className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-violet-500/30" title="Drag to resize; double-click to reset" onPointerDown={resize} onDoubleClick={resetWidth} />
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-900 px-2 py-1.5 [scrollbar-width:none]">
        {TABS.map((t) => (
          <button key={t.id} title={t.hint} onClick={() => pick(t.id)} onPointerEnter={() => prefetch(t.id)} onFocus={() => prefetch(t.id)} className={`shrink-0 rounded-md px-2 py-1 text-xs whitespace-nowrap ${tab === t.id ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900"}`}>
            {t.label}
          </button>
        ))}
        {overlay && onClose && (
          <button className="ml-auto shrink-0 rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100" onClick={onClose} aria-label="Close the side panel">
            Close
          </button>
        )}
      </div>
      {tab === "review" && <ChangesPanel workspaceId={ws.id} root={ws.path} chatIds={chatIds} />}
      {tab === "files" && (
        <Suspense fallback={loading}>
          <FilesPanel workspaceId={ws.id} openPath={openPath} root={ws.path} intelligence={snapshot.viewer.role !== "member"} />
        </Suspense>
      )}
      {tab === "git" &&
        (ws.branch ? (
          <Suspense fallback={loading}>
            <SourceControl workspaceId={ws.id} chatIds={chatIds} />
          </Suspense>
        ) : (
          <p className="p-4 text-sm text-zinc-500">This workspace is a scratch folder without git.</p>
        ))}
      {tab === "browser" &&
        (snapshot.viewer.role === "member" ? (
          <p className="p-4 text-sm text-zinc-500">The built-in browser runs on the host machine, so only the owner and admins can use it.</p>
        ) : (
          <Suspense fallback={loading}>
            <BrowserPanel ws={ws} open={browse} />
          </Suspense>
        ))}
      {terminalSeen && (
        <div className={tab === "terminal" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <Suspense fallback={loading}>
            <TerminalPanel ws={ws} snapshot={snapshot} run={run} />
          </Suspense>
        </div>
      )}
    </aside>
  );
}
