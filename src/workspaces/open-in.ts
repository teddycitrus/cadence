import { spawn } from "node:child_process";
import { findOnPath } from "../core/path-search";

// Opening a workspace's folder in another app on this machine: the system file
// manager or an installed editor. Only these fixed apps, and only the
// workspace's own folder, are ever launched.

export interface OpenTarget {
  id: string;
  label: string;
}

const EDITORS: { id: string; label: string; command: string }[] = [
  { id: "vscode", label: "VS Code", command: "code" },
  { id: "cursor", label: "Cursor", command: "cursor" },
  { id: "windsurf", label: "Windsurf", command: "windsurf" },
  { id: "zed", label: "Zed", command: "zed" },
  { id: "sublime", label: "Sublime Text", command: "subl" },
  { id: "webstorm", label: "WebStorm", command: "webstorm" },
  { id: "idea", label: "IntelliJ IDEA", command: "idea" },
];

const fileManager = (): OpenTarget => ({ id: "files", label: process.platform === "darwin" ? "Finder" : process.platform === "win32" ? "File Explorer" : "Files" });

let cache: { at: number; editors: (OpenTarget & { path: string })[] } | null = null;

function editors(): (OpenTarget & { path: string })[] {
  if (cache && Date.now() - cache.at < 60_000) return cache.editors;
  const found = EDITORS.flatMap((e) => {
    const path = findOnPath(e.command);
    return path ? [{ id: e.id, label: e.label, path }] : [];
  });
  cache = { at: Date.now(), editors: found };
  return found;
}

/** The file manager and every editor installed here. */
export function openTargets(): OpenTarget[] {
  return [fileManager(), ...editors().map(({ id, label }) => ({ id, label }))];
}

/** Opens `folder` in the chosen app; throws when that app is not available. */
export function openFolderIn(folder: string, target: string): void {
  if (target === "files") {
    const [cmd, args] = process.platform === "win32" ? ["explorer", [folder]] : process.platform === "darwin" ? ["open", [folder]] : ["xdg-open", [folder]];
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: false }).unref();
    return;
  }
  const editor = editors().find((e) => e.id === target);
  if (!editor) throw new Error(`${target} is not installed on this machine`);
  // Windows editors install a .cmd launcher, which needs the shell; the folder is quoted for it.
  const cmdShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(editor.path);
  const child = cmdShim ? spawn(`"${editor.path}" "${folder.replace(/"/g, "")}"`, { shell: true, detached: true, stdio: "ignore", windowsHide: true }) : spawn(editor.path, [folder], { detached: true, stdio: "ignore" });
  child.unref();
}
