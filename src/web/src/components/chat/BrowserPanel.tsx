import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type WheelEvent } from "react";
import type { Workspace } from "../../../../core/types";
import { api } from "../../api";
import { navigate } from "../../App";

interface BrowserState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  width: number;
  height: number;
}

const socketUrl = (ws: string, tab: number) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/workspaces/${ws}/browser/socket${tab ? `?tab=${tab}` : ""}`;
const MAX_TABS = 8;

/** CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
const modifiers = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const BUTTONS = ["left", "middle", "right"] as const;

/**
 * The workspace's built-in browser: a Chrome tab on the host, streamed here.
 * Agents in this workspace use the same tab, so you can watch them test.
 */
export function BrowserPanel({ ws, open }: { ws: Workspace; open?: { url: string; n: number } | null }) {
  const [state, setState] = useState<BrowserState | null>(null);
  const [address, setAddress] = useState("");
  const [frame, setFrame] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [finding, setFinding] = useState(false);
  const [findText, setFindText] = useState("");
  const [found, setFound] = useState<number | null>(null);
  // Tab 0 is the one agents use; more can be opened beside it.
  const [tabs, setTabs] = useState<number[]>([0]);
  const [active, setActive] = useState(0);
  const [titles, setTitles] = useState<Record<number, string>>({});
  const socket = useRef<WebSocket | null>(null);
  const view = useRef<HTMLDivElement>(null);
  const editing = useRef(false);
  const lastMove = useRef(0);

  const send = (m: unknown) => socket.current?.readyState === WebSocket.OPEN && socket.current.send(JSON.stringify(m));
  // A link sent here from the chat: go there now, or as soon as the tab is connected.
  const pending = useRef<string | null>(null);
  useEffect(() => {
    if (!open) return;
    if (socket.current?.readyState === WebSocket.OPEN) send({ type: "navigate", url: open.url });
    else pending.current = open.url;
  }, [open?.n]);

  useEffect(() => {
    const s = new WebSocket(socketUrl(ws.id, active));
    setFrame(null);
    setState(null);
    s.binaryType = "blob";
    socket.current = s;
    let url: string | null = null;
    s.onopen = () => {
      setConnected(true);
      setError(null);
      const box = view.current?.getBoundingClientRect();
      if (box) send({ type: "resize", width: box.width, height: box.height });
      send({ type: "tabs" });
      if (pending.current) send({ type: "navigate", url: pending.current });
      pending.current = null;
    };
    s.onclose = () => setConnected(false);
    s.onmessage = (e) => {
      if (e.data instanceof Blob) {
        const next = URL.createObjectURL(e.data);
        setFrame(next);
        if (url) URL.revokeObjectURL(url);
        url = next;
        return;
      }
      const m = JSON.parse(String(e.data)) as { type: string; state?: BrowserState; message?: string; open?: number[] };
      if (m.type === "tabs" && m.open) setTabs([...new Set([0, active, ...m.open])].sort((a, b) => a - b));
      else if (m.type === "state" && m.state) {
        const title = m.state.title;
        setTitles((t) => (t[active] === title ? t : { ...t, [active]: title }));
        setState(m.state);
        if (!editing.current) setAddress(m.state.url === "about:blank" ? "" : m.state.url);
      } else if (m.type === "found") setFound((m as unknown as { count: number }).count);
      else if (m.type === "error") setError(m.message ?? "Error");
    };
    return () => {
      s.close();
      if (url) URL.revokeObjectURL(url);
    };
  }, [ws.id, active]);
  useEffect(() => {
    setTabs([0]);
    setActive(0);
    setTitles({});
  }, [ws.id]);

  const newTab = () => {
    const free = Array.from({ length: MAX_TABS }, (_, i) => i).find((i) => !tabs.includes(i));
    if (free === undefined) return;
    setTabs([...tabs, free].sort((a, b) => a - b));
    setActive(free);
  };
  const closeTab = (i: number) => {
    if (i === active) send({ type: "close" });
    else new WebSocket(socketUrl(ws.id, i)).onopen = function (this: WebSocket) {
      this.send(JSON.stringify({ type: "close" }));
    };
    setTabs(tabs.filter((t) => t !== i));
    if (i === active) setActive(0);
  };

  // The tab's viewport follows the panel's size.
  useEffect(() => {
    const el = view.current;
    if (!el) return;
    let timer: number | undefined;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const box = el.getBoundingClientRect();
        send({ type: "resize", width: box.width, height: box.height });
      }, 150);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Page coordinates for a pointer event (frames are drawn at the tab's size). */
  const point = (e: { clientX: number; clientY: number }) => {
    const box = view.current!.getBoundingClientRect();
    const sx = (state?.width ?? box.width) / box.width;
    const sy = (state?.height ?? box.height) / box.height;
    return { x: Math.round((e.clientX - box.left) * sx), y: Math.round((e.clientY - box.top) * sy) };
  };
  const mouse = (event: "mousePressed" | "mouseReleased" | "mouseMoved") => (e: ReactMouseEvent) => {
    if (event === "mouseMoved") {
      const now = performance.now();
      if (now - lastMove.current < 33) return;
      lastMove.current = now;
    }
    if (event === "mousePressed") view.current?.focus();
    send({ type: "mouse", event, ...point(e), button: event === "mouseMoved" ? "none" : BUTTONS[e.button] ?? "left", clickCount: event === "mouseMoved" ? 0 : e.detail || 1, modifiers: modifiers(e) });
  };
  const wheel = (e: WheelEvent) => send({ type: "wheel", ...point(e), deltaX: e.deltaX, deltaY: e.deltaY });
  const key = (event: "down" | "up") => (e: KeyboardEvent) => {
    e.preventDefault();
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
    if (event === "down") send({ type: "key", event: printable ? "keyDown" : "rawKeyDown", key: e.key, code: e.code, keyCode: e.keyCode, modifiers: modifiers(e), ...(printable ? { text: e.key } : e.key === "Enter" ? { text: "\r" } : {}) });
    else send({ type: "key", event: "keyUp", key: e.key, code: e.code, keyCode: e.keyCode, modifiers: modifiers(e) });
  };

  const nav = "rounded px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-0.5 overflow-x-auto border-b border-zinc-900 px-1 pt-1 text-xs">
        {tabs.map((i) => (
          <span key={i} className={`group flex max-w-44 items-center gap-1 rounded-t px-2 py-1 ${i === active ? "bg-zinc-900 text-zinc-100" : "text-zinc-500 hover:text-zinc-200"}`}>
            <button className="truncate" onClick={() => setActive(i)} title={i === 0 ? "Agents in this workspace use this tab" : undefined}>
              {titles[i] || (i === 0 ? "Agent tab" : "New tab")}
            </button>
            {i > 0 && (
              <button className="text-zinc-500 opacity-0 group-hover:opacity-100 hover:text-zinc-100" onClick={() => closeTab(i)} title="Close tab">
                x
              </button>
            )}
          </span>
        ))}
        {tabs.length < MAX_TABS && (
          <button className="px-2 py-1 text-zinc-500 hover:text-zinc-100" onClick={newTab} title="New tab">
            +
          </button>
        )}
      </div>
      <form
        className="flex items-center gap-1 border-b border-zinc-900 px-2 py-1.5 text-xs"
        onSubmit={(e) => {
          e.preventDefault();
          editing.current = false;
          setError(null);
          send({ type: "navigate", url: address });
        }}
      >
        <button type="button" className={nav} disabled={!state?.canGoBack} onClick={() => send({ type: "back" })} title="Back">
          ←
        </button>
        <button type="button" className={nav} disabled={!state?.canGoForward} onClick={() => send({ type: "forward" })} title="Forward">
          →
        </button>
        <button type="button" className={nav} onClick={() => send({ type: "reload" })} title="Reload">
          {state?.loading ? "×" : "↻"}
        </button>
        <input
          className="min-w-0 flex-1 rounded bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-200 ring-1 ring-zinc-800 focus:ring-zinc-600 focus:outline-none"
          placeholder="localhost:3000 or any address"
          value={address}
          onFocus={() => (editing.current = true)}
          onBlur={() => (editing.current = false)}
          onChange={(e) => setAddress(e.target.value)}
        />
        <button type="button" className={nav} onClick={() => setFinding(!finding)} title="Find in page">
          Find
        </button>
        <button type="button" className={nav} disabled={!state?.url || state.url === "about:blank"} onClick={() => state && window.open(state.url, "_blank", "noopener")} title="Open in your own browser">
          Open
        </button>
        <button
          type="button"
          className={nav}
          disabled={!state?.url || !/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(state.url)}
          onClick={() => state && void api.addPageToCanvas(ws.id, state.url).then((c) => navigate("canvas", `${ws.id}|${c.path}`), (e: Error) => setError(e.message))}
          title="Add this page to a canvas as a live frame"
        >
          + Canvas
        </button>
      </form>
      {finding && (
        <div className="flex items-center gap-2 border-b border-zinc-900 px-2 py-1 text-xs">
          <input
            autoFocus
            className="w-48 rounded bg-zinc-900 px-2 py-0.5 text-zinc-200 ring-1 ring-zinc-800 outline-none"
            placeholder="Find in page"
            value={findText}
            onChange={(e) => setFindText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && findText) send({ type: "find", text: findText, backwards: e.shiftKey });
              if (e.key === "Escape") setFinding(false);
            }}
          />
          <span className="text-zinc-500">{found === null ? "Enter to find" : found ? `${found} match${found === 1 ? "" : "es"}` : "No matches"}</span>
          <button className="text-zinc-500 hover:text-zinc-100" onClick={() => findText && send({ type: "find", text: findText, backwards: true })}>
            Previous
          </button>
          <button className="text-zinc-500 hover:text-zinc-100" onClick={() => findText && send({ type: "find", text: findText })}>
            Next
          </button>
          <button className="ml-auto text-zinc-500 hover:text-zinc-100" onClick={() => setFinding(false)} aria-label="Close find">
            ×
          </button>
        </div>
      )}
      {error && <p className="bg-red-950/50 px-3 py-1 text-xs text-red-300">{error}</p>}
      <div
        ref={view}
        tabIndex={0}
        className="relative min-h-0 flex-1 cursor-default overflow-hidden bg-white outline-none focus:ring-1 focus:ring-violet-500/60"
        onMouseDown={mouse("mousePressed")}
        onMouseUp={mouse("mouseReleased")}
        onMouseMove={mouse("mouseMoved")}
        onWheel={wheel}
        onKeyDown={(e) => ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" ? (e.preventDefault(), setFinding(true)) : key("down")(e))}
        onKeyUp={key("up")}
        onPaste={(e) => send({ type: "text", text: e.clipboardData.getData("text/plain") })}
        onContextMenu={(e) => e.preventDefault()}
      >
        {frame ? <img src={frame} alt={state?.title || "Browser"} draggable={false} className="pointer-events-none block h-full w-full object-fill select-none" /> : <p className="grid h-full place-items-center bg-zinc-950 text-xs text-zinc-500">{connected ? "Enter an address to start browsing." : "Starting the browser..."}</p>}
      </div>
      <p className="truncate border-t border-zinc-900 px-3 py-1 text-[11px] text-zinc-500">{state?.title ? `${state.title} · ` : ""}Agents in this workspace use this same browser.</p>
    </div>
  );
}
