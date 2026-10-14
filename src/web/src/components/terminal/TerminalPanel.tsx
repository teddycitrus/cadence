import { runCommands } from "../chat/RunButton";
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { Snapshot, Workspace } from "../../../../core/types";
import { api, type TerminalInfo } from "../../api";
import { ErrorText, useAction } from "../ui";
import { THEME_EVENT, isDark } from "../../theme";

/** The terminal in the current theme's colors, read from styles.css, with an earthy ANSI set. */
function terminalTheme() {
  const css = getComputedStyle(document.documentElement);
  const c = (name: string) => css.getPropertyValue(`--color-${name}`).trim();
  const dark = isDark();
  return {
    background: c("zinc-950"),
    foreground: c("zinc-200"),
    cursor: c("violet-400"),
    cursorAccent: c("zinc-950"),
    selectionBackground: dark ? "#4f453a" : "#d3c19e",
    black: dark ? "#2a241f" : "#4b2434",
    red: c("red-400"),
    green: c("emerald-400"),
    yellow: c("amber-400"),
    blue: c("sky-400"),
    magenta: dark ? "#c494b4" : "#7a3e5a",
    cyan: dark ? "#8fbab2" : "#3f6f68",
    white: dark ? "#ccb99c" : "#98806e",
    brightBlack: c("zinc-500"),
    brightRed: c("red-300"),
    brightGreen: c("emerald-300"),
    brightYellow: c("amber-300"),
    brightBlue: c("sky-300"),
    brightMagenta: dark ? "#ddb3cf" : "#5e2a45",
    brightCyan: dark ? "#aed2ca" : "#2f5953",
    brightWhite: dark ? "#f6ebda" : "#3c1b29",
  };
}

function socketUrl(id: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/api/terminals/${id}/socket`;
}

/** One xterm bound to a server-side shell over a WebSocket. */
export function TerminalView({ term, visible }: { term: Pick<TerminalInfo, "id" | "alive" | "exitCode">; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [ended, setEnded] = useState<number | null>(term.alive ? null : term.exitCode);

  useEffect(() => {
    const xterm = new Terminal({
      fontFamily: '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
      theme: terminalTheme(),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    xterm.loadAddon(fit);
    xterm.open(host.current!);
    const restyle = () => (xterm.options.theme = terminalTheme());
    window.addEventListener(THEME_EVENT, restyle);
    const ws = new WebSocket(socketUrl(term.id));
    const send = (m: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
    const resize = () => {
      try {
        fit.fit();
        send({ type: "resize", cols: xterm.cols, rows: xterm.rows });
      } catch {
        // hidden panes have no size
      }
    };
    ws.onopen = resize;
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as { type: string; data?: string; code?: number; alive?: boolean; exitCode?: number | null };
      if (m.type === "snapshot") {
        xterm.reset();
        xterm.write(m.data ?? "");
        if (m.alive === false) setEnded(m.exitCode ?? 0);
      } else if (m.type === "output") xterm.write(m.data ?? "");
      else if (m.type === "exit") setEnded(m.code ?? 0);
    };
    const input = xterm.onData((data) => send({ type: "input", data }));
    const observer = new ResizeObserver(resize);
    observer.observe(host.current!);
    return () => {
      window.removeEventListener(THEME_EVENT, restyle);
      observer.disconnect();
      input.dispose();
      ws.close();
      xterm.dispose();
    };
  }, [term.id]);

  useEffect(() => {
    if (visible) requestAnimationFrame(() => fitRef.current?.fit());
  }, [visible]);

  return (
    <div className={`relative min-h-0 flex-1 ${visible ? "flex" : "hidden"} flex-col`}>
      <div ref={host} className="min-h-0 flex-1 bg-zinc-950 p-1.5" />
      {ended !== null && <p className="border-t border-zinc-900 px-3 py-1 text-[11px] text-zinc-500">Process exited with code {ended}.</p>}
    </div>
  );
}

const handledRuns = new Map<string, number>();

/** Terminals in the workspace folder, plus one-click project commands. */
export function TerminalPanel({ ws, snapshot, run }: { ws: Workspace; snapshot: Snapshot; run?: { name: string; command: string; n: number } | null }) {
  const [terms, setTerms] = useState<TerminalInfo[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const action = useAction();
  const project = ws.projectId ? snapshot.projects.find((p) => p.id === ws.projectId) : null;
  const commands = runCommands(project, snapshot.viewer.memberId);

  useEffect(() => {
    api.terminals(ws.id).then((list) => {
      setTerms(list);
      setActive(list[0]?.id ?? null);
    }, (e: Error) => action.setError(e.message));
  }, [ws.id]);

  const open = (command?: string, title?: string) =>
    action.run(async () => {
      const t = await api.openTerminal({ workspaceId: ws.id, command: command ?? null, title });
      setTerms((list) => [...(list ?? []), t]);
      setActive(t.id);
    });

  // A Run button press opens a terminal on that command, once (the panel can remount).
  useEffect(() => {
    if (!run || !terms || handledRuns.get(ws.id) === run.n) return;
    handledRuns.set(ws.id, run.n);
    void open(run.command, run.name);
  }, [run?.n, terms === null]);

  const close = (id: string) =>
    action.run(async () => {
      await api.closeTerminal(id);
      setTerms((list) => {
        const next = (list ?? []).filter((t) => t.id !== id);
        if (active === id) setActive(next.at(-1)?.id ?? null);
        return next;
      });
    });

  if (ws.archived) return <p className="p-4 text-sm text-zinc-500">Restore this workspace to use a terminal.</p>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-zinc-900 px-2 py-1">
        {(terms ?? []).map((t) => (
          <span key={t.id} className={`group flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-xs ${t.id === active ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900"}`}>
            <button
              className="max-w-28 truncate"
              onClick={() => setActive(t.id)}
              onDoubleClick={() => {
                const title = prompt("Rename terminal", t.title);
                if (!title) return;
                void action.run(async () => {
                  const renamed = await api.renameTerminal(t.id, title);
                  setTerms((l) => (l ?? []).map((x) => (x.id === renamed.id ? renamed : x)));
                });
              }}
            >
              {t.title}
            </button>
            <button className="text-zinc-600 hover:text-red-400" title="Close terminal" onClick={() => void close(t.id)}>
              ×
            </button>
          </span>
        ))}
        <button className="shrink-0 rounded px-1.5 text-sm text-zinc-500 hover:bg-zinc-900 hover:text-zinc-100" title="New terminal" disabled={action.busy} onClick={() => void open()}>
          +
        </button>
        {commands.length ? (
          <select
            className="ml-auto shrink-0 rounded bg-zinc-900 px-1 py-0.5 text-xs text-zinc-300"
            value=""
            onChange={(e) => {
              const cmd = commands.find((c) => c.name === e.target.value);
              if (cmd) void open(cmd.command, cmd.name);
            }}
          >
            <option value="">Run...</option>
            {commands.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <ErrorText>{action.error}</ErrorText>
      {terms?.length === 0 && (
        <div className="grid flex-1 place-items-center p-6 text-center text-sm text-zinc-500">
          <div className="space-y-2">
            <p>A shell in this workspace's folder, on its branch.</p>
            <button className="text-violet-300 hover:underline" onClick={() => void open()}>
              Open a terminal
            </button>
          </div>
        </div>
      )}
      {(terms ?? []).map((t) => (
        <TerminalView key={t.id} term={t} visible={t.id === active} />
      ))}
    </div>
  );
}
