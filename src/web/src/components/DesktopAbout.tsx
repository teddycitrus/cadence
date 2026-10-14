import { useCallback, useEffect, useState } from "react";
import { desktop, useDesktopEvents, type DesktopEvent, type MemoryReport, type UpdateState } from "../desktop";
import { Button } from "./ui";

const STATUS: Record<UpdateState["status"], (s: UpdateState) => string> = {
  idle: () => "Checks for updates in the background.",
  checking: () => "Checking for updates...",
  available: (s) => `Version ${s.next} found; downloading.`,
  downloading: (s) => `Downloading version ${s.next ?? ""} (${s.percent}%).`,
  ready: (s) => `Version ${s.next} is ready. Restart to install it.`,
  current: () => "You have the latest version.",
  error: (s) => `Could not check for updates: ${s.error ?? "unknown error"}.`,
  unsupported: () => "Updates install only in the installed app, not a development build.",
};

/** The desktop app's version, updates, and how much memory it is using. */
export function DesktopAbout({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [memory, setMemory] = useState<MemoryReport | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (!desktop) return;
    void desktop.updateState().then(setState);
    const read = () => void desktop!.memory().then(setMemory, () => undefined);
    read();
    const timer = window.setInterval(read, 3000);
    return () => window.clearInterval(timer);
  }, []);
  useDesktopEvents(
    useCallback((e: DesktopEvent) => {
      if (e.type === "update") setState(e.state);
    }, []),
  );
  if (!desktop) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60" onClick={onClose}>
      <div className="w-[26rem] space-y-4 rounded-xl bg-zinc-900 p-5 ring-1 ring-zinc-700" onClick={(e) => e.stopPropagation()}>
        <div>
          <p className="font-display text-lg">Cadence {state?.version ?? ""}</p>
          <p className="mt-1 text-sm text-zinc-400">{state ? STATUS[state.status](state) : "..."}</p>
        </div>
        <div className="flex gap-2">
          {state?.status === "ready" ? (
            <Button variant="primary" onClick={() => void desktop!.installUpdate()}>
              Restart and update
            </Button>
          ) : (
            <Button
              disabled={checking || state?.status === "unsupported" || state?.status === "downloading"}
              onClick={() => {
                setChecking(true);
                void desktop!.checkForUpdates().then(setState).finally(() => setChecking(false));
              }}
            >
              {checking ? "Checking..." : "Check for updates"}
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </div>
        <div>
          <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase">Memory used</p>
          {memory ? (
            <table className="mt-1 w-full text-sm">
              <tbody>
                {memory.processes.map((p, i) => (
                  <tr key={`${p.type}${i}`} className="border-b border-zinc-800/60">
                    <td className="py-1 text-zinc-400">{p.type}</td>
                    <td className="py-1 text-right font-mono text-xs text-zinc-300">{p.mb} MB</td>
                  </tr>
                ))}
                <tr>
                  <td className="py-1 font-medium">Total</td>
                  <td className="py-1 text-right font-mono text-xs">{memory.totalMb} MB</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p className="mt-1 text-sm text-zinc-500">Reading...</p>
          )}
        </div>
      </div>
    </div>
  );
}
