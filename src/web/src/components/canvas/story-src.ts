import type { AppFrame, CanvasInfo, DevServer, StoryboardInfo } from "../../api";

/** Shown in a route frame when there is no app for it to load. */
export const NO_APP = "No app to show here yet. Set the app's dev command in the canvas settings (or apps[0].start in the project's settings file) and Cadence starts it for this route.";

/** Where a frame loads. Route frames of apps with their own dev server go through Cadence's bridge proxy. */
export function storySrc(dev: DevServer | null, canvas: CanvasInfo, s: StoryboardInfo, app: AppFrame | null): string | null {
  if (!dev) return null;
  if (s.kind === "route") {
    if ((canvas.appUrl || canvas.appCommand) && !app) return null;
    if (!canvas.appUrl && !canvas.appCommand && dev.hasPage === false) return null;
    return `${app?.proxyUrl ?? dev.url}${s.route!.startsWith("/") ? "" : "/"}${s.route}`;
  }
  if (s.kind === "html") return `${dev.url}/${s.html!.replace(/^\/+/, "")}`;
  return `${dev.url}/__cadence/story?canvas=${encodeURIComponent(canvas.path)}&story=${encodeURIComponent(s.id)}`;
}
