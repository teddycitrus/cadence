import { useEffect } from "react";

// The desktop app's bridge (src/desktop/preload.cjs). Absent in a browser, so
// every use checks for it and the page works the same without the native parts.

export interface UpdateState {
  version: string;
  status: "idle" | "checking" | "available" | "downloading" | "ready" | "current" | "error" | "unsupported";
  next: string | null;
  percent: number;
  error: string | null;
}

export interface MemoryReport {
  processes: { type: string; mb: number }[];
  totalMb: number;
}

export type DesktopEvent = { type: "menu"; action: "settings" | "shortcuts" | "report" | "updates" } | { type: "update"; state: UpdateState };

interface DesktopBridge {
  platform: string;
  /** Which Cadence the window shows: this computer's, or a team's server it joined. */
  connection: { mode: "local" | "team"; url: string | null };
  joinServer: (address: string) => Promise<{ ok: boolean; error?: string }>;
  useThisComputer: () => Promise<void>;
  pickFolder: (title?: string) => Promise<string | null>;
  pathForFile: (file: File) => string | null;
  revealPath: (path: string) => Promise<boolean>;
  memory: () => Promise<MemoryReport>;
  updateState: () => Promise<UpdateState>;
  checkForUpdates: () => Promise<UpdateState>;
  installUpdate: () => Promise<void>;
  onEvent: (callback: (event: DesktopEvent) => void) => () => void;
}

/** The bridge when running in the desktop app, else null. */
export const desktop: DesktopBridge | null = (globalThis as { cadenceDesktop?: DesktopBridge }).cadenceDesktop ?? null;

/** The bridge while the window shows this computer's Cadence: its folder picker and file paths mean something there, not on a team's server. */
export const localDesktop: DesktopBridge | null = desktop?.connection?.mode === "local" ? desktop : null;

/** What the system file manager is called here, for "Reveal in ..." labels. */
export const fileManager = desktop?.platform === "darwin" ? "Finder" : desktop?.platform === "win32" ? "File Explorer" : "Files";

/** Runs `handler` for each event from the desktop app (menu commands, update news). */
export function useDesktopEvents(handler: (event: DesktopEvent) => void): void {
  useEffect(() => {
    if (!desktop) return;
    return desktop.onEvent(handler);
  }, [handler]);
}
