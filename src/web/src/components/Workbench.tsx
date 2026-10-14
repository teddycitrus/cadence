import { useCallback, useEffect, useRef, useState } from "react";
import { SHORTCUTS, sidebarVisible, toggleRightPanel, toggleSidebar } from "../shell";
import { openWelcome } from "./home/welcome";
import { desktop, useDesktopEvents, type DesktopEvent } from "../desktop";
import { DesktopAbout } from "./DesktopAbout";

// Window-level tools around the main view: history arrows and a split pane.

/** True inside the split pane's frame, which shows one view without the rail. */
export const IN_PANE = new URLSearchParams(window.location.search).has("pane");

export const OPEN_BESIDE_EVENT = "cadence:open-beside";

/** Shows a view (a hash like #/canvas/...) in the split pane next to the current one, opening the pane if needed. */
export function openBeside(hash: string) {
  if (IN_PANE) {
    window.location.hash = hash;
    return;
  }
  store("cadence.split.hash", hash);
  window.dispatchEvent(new CustomEvent<string>(OPEN_BESIDE_EVENT, { detail: hash }));
}

interface NavigationLike {
  canGoBack?: boolean;
  canGoForward?: boolean;
}

/** Back and forward through views. Browsers without the Navigation API keep both enabled. */
export function NavArrows() {
  const [, tick] = useState(0);
  useEffect(() => {
    const on = () => tick((n) => n + 1);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const nav = (window as unknown as { navigation?: NavigationLike }).navigation;
  const arrow = (dir: "back" | "forward") => (
    <button
      title={dir === "back" ? "Back (Alt+Left)" : "Forward (Alt+Right)"}
      disabled={(dir === "back" ? nav?.canGoBack : nav?.canGoForward) === false}
      className="grid size-5 place-items-center rounded text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200 disabled:opacity-30 disabled:hover:bg-transparent"
      onClick={() => (dir === "back" ? history.back() : history.forward())}
    >
      <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d={dir === "back" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
      </svg>
    </button>
  );
  return (
    <div className="mb-1 flex gap-0.5">
      {arrow("back")}
      {arrow("forward")}
    </div>
  );
}

const PANE_VIEWS: [string, string][] = [
  ["#/chats", "Chats"],
  ["#/issues", "Issues"],
  ["#/agents", "Agents"],
  ["#/docs", "Docs"],
  ["#/canvas", "Canvases"],
];

function stored(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable
  }
}

/**
 * A second view beside the main one (a chat next to its canvas, a doc next to
 * the board). It is the app itself in a frame, so everything in it works the same.
 */
export function SplitPane({ onClose }: { onClose: () => void }) {
  const [hash, setHash] = useState(() => stored("cadence.split.hash", "#/chats"));
  const [width, setWidth] = useState(() => Number(stored("cadence.split.width", "560")) || 560);
  const [dragging, setDragging] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const [src] = useState(() => `${window.location.pathname}?pane=1${hash}`);
  useEffect(() => store("cadence.split.hash", hash), [hash]);
  useEffect(() => store("cadence.split.width", String(width)), [width]);
  useEffect(() => {
    const on = (e: Event) => go((e as CustomEvent<string>).detail);
    window.addEventListener(OPEN_BESIDE_EVENT, on);
    return () => window.removeEventListener(OPEN_BESIDE_EVENT, on);
  }, []);

  const follow = () => {
    const win = frame.current?.contentWindow;
    if (!win) return;
    setHash(win.location.hash || "#/chats");
    win.addEventListener("hashchange", () => setHash(win.location.hash));
  };
  const go = (next: string) => {
    const win = frame.current?.contentWindow;
    if (win) win.location.hash = next;
    setHash(next);
  };
  const swap = () => {
    const main = window.location.hash || "#/home";
    window.location.hash = hash;
    go(main);
  };
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent) => setWidth(Math.min(window.innerWidth - 360, Math.max(320, startW + startX - ev.clientX)));
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const current = PANE_VIEWS.find(([h]) => hash.startsWith(h))?.[0] ?? "";
  return (
    <aside className="relative flex shrink-0 flex-col border-l border-zinc-800 bg-zinc-950" style={{ width }}>
      <div className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-violet-500/40" onPointerDown={startDrag} title="Drag to resize" />
      <div className="flex items-center gap-2 border-b border-zinc-900 px-2 py-1.5 text-xs">
        <select className="rounded bg-zinc-900 px-2 py-1 text-zinc-300 ring-1 ring-zinc-800" value={current} onChange={(e) => go(e.target.value)}>
          {!current && <option value="">{hash}</option>}
          {PANE_VIEWS.map(([h, label]) => (
            <option key={h} value={h}>
              {label}
            </option>
          ))}
        </select>
        <button className="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100" onClick={swap} title="Swap this pane with the main view">
          Swap
        </button>
        <button className="ml-auto rounded px-2 py-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-100" onClick={onClose} aria-label="Close split view">
          ×
        </button>
      </div>
      <iframe ref={frame} src={src} title="Split view" className="min-h-0 w-full flex-1 border-0" onLoad={follow} style={{ pointerEvents: dragging ? "none" : "auto" }} />
    </aside>
  );
}

/** Shortcuts, layout toggles, and where things are. */
export function HelpMenu({ onReportBug }: { onReportBug: () => void }) {
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState(false);
  const [keyQuery, setKeyQuery] = useState("");
  const [about, setAbout] = useState(false);
  // The desktop app's Help menu opens these too.
  useDesktopEvents(
    useCallback((e: DesktopEvent) => {
      if (e.type !== "menu") return;
      if (e.action === "shortcuts") setKeys(true);
      if (e.action === "updates") setAbout(true);
    }, []),
  );
  return (
    <div className="relative">
      <button title="Help" onClick={() => setOpen(!open)} className="grid size-8 place-items-center rounded-lg text-sm text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200">
        ?
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-0 left-10 z-50 w-56 rounded-lg bg-zinc-900 py-1 text-sm shadow-2xl ring-1 ring-zinc-700">
            {(
              [
                ["Keyboard shortcuts", () => setKeys(true)],
                [sidebarVisible() ? "Hide sidebar" : "Show sidebar", toggleSidebar],
                ["Toggle workspace side panel", toggleRightPanel],
                ["Welcome tour", () => void openWelcome(null)],
                ["Report a problem", onReportBug],
                ...(desktop ? ([["About Cadence", () => setAbout(true)]] as [string, () => void][]) : []),
              ] as [string, () => void][]
            ).map(([label, run]) => (
              <button
                key={label}
                className="block w-full px-3 py-1.5 text-left text-zinc-200 hover:bg-zinc-800"
                onClick={() => {
                  setOpen(false);
                  run();
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
      {about && <DesktopAbout onClose={() => setAbout(false)} />}
      {keys && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60" onClick={() => setKeys(false)}>
          <div className="w-[28rem] space-y-3 rounded-xl bg-zinc-900 p-5 ring-1 ring-zinc-700" onClick={(e) => e.stopPropagation()}>
            <p className="font-display text-lg">Keyboard shortcuts</p>
            <input autoFocus className="w-full rounded-md bg-zinc-950 px-2.5 py-1.5 text-sm ring-1 ring-zinc-800 outline-none placeholder:text-zinc-500 focus:ring-violet-500" placeholder="Search shortcuts" value={keyQuery} onChange={(e) => setKeyQuery(e.target.value)} />
            <table className="w-full text-sm">
              <tbody>
                {SHORTCUTS.filter(([k, what]) => !keyQuery || `${k} ${what}`.toLowerCase().includes(keyQuery.toLowerCase())).map(([k, what]) => (
                  <tr key={k} className="border-b border-zinc-800">
                    <td className="py-1.5 pr-4 font-mono text-xs whitespace-nowrap text-zinc-300">{k}</td>
                    <td className="py-1.5 text-zinc-400">{what}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
