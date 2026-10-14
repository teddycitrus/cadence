import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { APP_COMMAND } from "./app-command";
import { JSX_PROJECT_CONFIG } from "./jsx-compat";
import { parseCanvas, type CanvasFile } from "./parse";

// Projects whose canvases use the component format can name their app (the dev
// server route frames load) in a project settings file, as `apps[0].start`
// (the dev command) and `apps[0].url`, rather than in each canvas. Those
// canvases read it from there unless the canvas sets its own.

const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/;

/** The nearest settings file from the canvas's folder up to the project root. */
function findConfig(root: string, canvasPath: string): string | null {
  let dir = dirname(join(root, canvasPath));
  for (;;) {
    const file = join(dir, JSX_PROJECT_CONFIG);
    if (existsSync(file)) return file;
    if (relative(root, dir) === "" || relative(root, dir).startsWith("..")) return null;
    dir = dirname(dir);
  }
}

/** The app the settings file names: its dev command and URL, when they are safe to use. */
export function configuredApp(root: string, canvasPath: string): Pick<CanvasFile, "appCommand" | "appUrl"> {
  const file = findConfig(root, canvasPath);
  if (!file) return { appCommand: null, appUrl: null };
  try {
    const app = (JSON.parse(readFileSync(file, "utf8")) as { apps?: { start?: unknown; url?: unknown }[] }).apps?.[0];
    const start = typeof app?.start === "string" && APP_COMMAND.test(app.start) ? app.start : null;
    const url = typeof app?.url === "string" && LOCAL_URL.test(app.url) ? app.url.replace(/\/$/, "") : null;
    return { appCommand: start, appUrl: url };
  } catch {
    return { appCommand: null, appUrl: null };
  }
}

/** A canvas as the editor sees it: parsed, with a component-format project's app filled in from its settings. */
export function canvasSummary(root: string, path: string, source: string): CanvasFile {
  const canvas = parseCanvas(source, path);
  if (canvas.format === "jsx" && !canvas.appCommand && !canvas.appUrl) Object.assign(canvas, configuredApp(root, path));
  return canvas;
}
