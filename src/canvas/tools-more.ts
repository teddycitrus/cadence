import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";
import { z } from "zod";
import { define, type BoardTool, type ToolContext } from "../agents/board-tools";
import { appUrl as linkTo } from "../agents/tool-context";
import type { Queries } from "../core/queries";
import type { ShareService } from "../share/service";
import type { WorkspaceService } from "../workspaces/service";
import type { CanvasApps } from "./apps";
import type { CanvasDevServers } from "./devserver";
import type { CanvasEditingState } from "./editing";
import type { Frame } from "./parse";
import { comparePngs, type CanvasRenderer } from "./render";
import type { CanvasService } from "./service";
import { CANVAS_GUIDE } from "./guide";

const canvasPath = z.string().regex(/\.canvas\.[jt]sx?$/).describe("Repo-relative path, e.g. src/checkout.canvas.tsx");
const storyId = z.string().regex(/^[A-Za-z_$][\w$]*$/).describe("The frame's export name");
const ROW_WIDTH = 3000;
const GAP = 80;

export interface CanvasToolDeps {
  canvases: CanvasService;
  render: CanvasRenderer;
  dev: CanvasDevServers;
  apps: CanvasApps;
  editing: CanvasEditingState;
  shares: ShareService;
  workspaces: WorkspaceService;
  q: Queries;
}

function workspaceOf(ctx: ToolContext): string {
  if (!ctx.workspaceId) throw new Error("Canvas tools only work from a workspace session");
  return ctx.workspaceId;
}

/** Positions for new frames: rows left to right under what is there, wrapping at a fixed width. */
export function layoutFrames(existing: Frame[], sizes: { width: number; height: number }[]): Frame[] {
  let y = existing.length ? Math.max(...existing.map((f) => f.y + f.height)) + GAP : 0;
  let x = 0;
  let rowHeight = 0;
  return sizes.map((s) => {
    if (x > 0 && x + s.width > ROW_WIDTH) {
      y += rowHeight + GAP;
      x = 0;
      rowHeight = 0;
    }
    const frame = { x, y, width: s.width, height: s.height };
    x += s.width + GAP;
    rowHeight = Math.max(rowHeight, s.height);
    return frame;
  });
}

const overlaps = (a: Frame, b: Frame) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Canvas tools for the agent protocol (start and finish editing), checks, servers, stability, and sharing. */
export function moreCanvasTools(d: CanvasToolDeps): BoardTool[] {
  const { canvases, render, dev, apps, editing, shares, workspaces, q } = d;
  return [
    define({
      name: "canvas_guide",
      description: "How Cadence canvases work: the file format, frame kinds, frames, visual tests, route frames and the app's dev server, and the editing protocol. Read it before your first canvas change in a session.",
      shape: {},
      run: () => CANVAS_GUIDE,
    }),
    define({
      name: "canvas_start_working",
      description: "Say you are starting work on a canvas (or every canvas in the workspace when path is omitted). People viewing it see that you are editing, and it refreshes once when you finish instead of on every write. Call before your first canvas change, and canvas_finish_working once at the end.",
      shape: { path: canvasPath.optional() },
      run: (a, ctx) => {
        editing.start(workspaceOf(ctx), a.path ?? null, ctx.actor);
        return "Editing state on. Call canvas_finish_working when done.";
      },
    }),
    define({
      name: "canvas_finish_working",
      description: "Say you finished working on a canvas, at the same scope you started. Clears the editing state and refreshes everyone's view. Call exactly once at the end of every canvas session, even when the work failed.",
      shape: { path: canvasPath.optional() },
      run: (a, ctx) => (editing.finish(workspaceOf(ctx), a.path ?? null) ? "Done; views refreshed." : "No editing session was open at that scope; views refreshed anyway."),
    }),
    define({
      name: "canvas_delete",
      description: "Delete a canvas file from the workspace. Irreversible on disk (git still has it if committed). Ask the person first; set confirm: true.",
      shape: { path: canvasPath, confirm: z.literal(true) },
      run: (a, ctx) => {
        canvases.deleteCanvas(workspaceOf(ctx), a.path);
        return `Deleted ${a.path}.`;
      },
    }),
    define({
      name: "canvas_layout",
      description: "Positions for new frames on a canvas that do not overlap what is there: rows left to right below the existing ones, wrapping at 3000px. Read-only; pass the result as each frame's layout.",
      shape: { path: canvasPath, sizes: z.array(z.object({ width: z.number().min(20).max(10000), height: z.number().min(20).max(10000) })).min(1).max(50) },
      run: (a, ctx) => {
        const c = canvases.read(workspaceOf(ctx), a.path);
        return JSON.stringify(layoutFrames(c.storyboards.map((s) => s.frame), a.sizes));
      },
    }),
    define({
      name: "canvas_validate",
      description: "Check a canvas without rendering it: parse errors, frames that overlap, imports that do not resolve, html frames whose file is missing, and route frames with no app to load from. Read-only.",
      shape: { path: canvasPath },
      run: (a, ctx) => {
        const ws = workspaces.workspaceOrThrow(workspaceOf(ctx));
        const c = canvases.read(ws.id, a.path);
        const problems = [...c.errors];
        const stories = c.storyboards;
        stories.forEach((s, i) => {
          for (const t of stories.slice(i + 1)) if (overlaps(s.frame, t.frame)) problems.push(`${s.id} and ${t.id} overlap; use canvas_layout for free space`);
          if (s.kind === "html" && s.html && !existsSync(resolve(ws.path, s.html))) problems.push(`${s.id}: ${s.html} does not exist`);
          if (s.kind === "svelte" && s.svelte && !existsSync(resolve(ws.path, s.svelte))) problems.push(`${s.id}: ${s.svelte} does not exist`);
        });
        if (stories.some((s) => s.kind === "route") && !c.appCommand && !c.appUrl && !existsSync(join(ws.path, "index.html"))) problems.push("Route frames need the app: set appCommand (canvas_app_server action set) or an index.html at the root");
        const dir = dirname(resolve(ws.path, a.path));
        for (const m of c.source.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
          const base = resolve(dir, m[1]!);
          const found = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".css", ".svelte", "/index.ts", "/index.tsx", "/index.js"].some((ext) => existsSync(base + ext));
          if (!found) problems.push(`Import ${m[1]} does not resolve`);
        }
        return problems.length ? `${problems.length} problems:\n${problems.map((p) => `- ${p}`).join("\n")}` : `Valid: ${stories.length} frames.`;
      },
    }),
    define({
      name: "canvas_debug",
      description: "Diagnose a canvas that will not render: the canvas devserver's state, the app dev server's recent output for route frames, parse problems, and the error from rendering one frame. Call once after a failed screenshot instead of retrying.",
      shape: { path: canvasPath, story: storyId.optional() },
      run: async (a, ctx) => {
        const wsId = workspaceOf(ctx);
        const ws = workspaces.workspaceOrThrow(wsId);
        const c = canvases.read(wsId, a.path);
        const server = dev.get(wsId);
        const lines = [`Canvas devserver: ${server ? `running at ${server.url}${server.usesProjectConfig ? " (project's vite config)" : ""}` : "not running (starts on the next render)"}`, `Frames: ${c.storyboards.map((s) => `${s.id} (${s.kind})`).join(", ") || "none"}`];
        if (c.errors.length) lines.push(`Parse problems:\n${c.errors.map((e) => `- ${e}`).join("\n")}`);
        if (c.appCommand) {
          const url = apps.servers.urlOf(ws.path, c.appCommand);
          lines.push(`App command: ${c.appCommand} (${url ? `running at ${url}` : "not running"})`);
          const log = apps.servers.log(ws.path, c.appCommand).slice(-20);
          if (log.length) lines.push(`App output:\n${log.join("\n")}`);
        } else if (c.appUrl) lines.push(`App URL: ${c.appUrl}`);
        const story = a.story ?? c.storyboards[0]?.id;
        if (story) {
          try {
            const png = await render.screenshot(wsId, a.path, story);
            lines.push(`Rendering ${story}: ok (${PNG.sync.read(png).width}x${PNG.sync.read(png).height})`);
          } catch (err) {
            lines.push(`Rendering ${story} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return lines.join("\n");
      },
    }),
    define({
      name: "canvas_devserver",
      description: "Check, start, or stop this workspace's canvas devserver. Frames go blank while it is stopped; any render starts it again.",
      shape: { action: z.enum(["status", "start", "stop"]) },
      run: async (a, ctx) => {
        const wsId = workspaceOf(ctx);
        if (a.action === "start") return `Running at ${(await dev.ensure(wsId)).url}.`;
        if (a.action === "stop") {
          await dev.stop(wsId);
          return "Stopped.";
        }
        const s = dev.get(wsId);
        return s ? `Running at ${s.url}.` : "Not running.";
      },
    }),
    define({
      name: "canvas_app_server",
      description: "The app's own dev server for a canvas's route frames: status, start, stop, or set the command (Cadence runs it with PORT and CADENCE=1; {port} in it is replaced) or a URL of one already running on this machine.",
      shape: { path: canvasPath, action: z.enum(["status", "start", "stop", "set"]), command: z.string().max(300).optional(), url: z.string().url().optional() },
      run: async (a, ctx) => {
        const wsId = workspaceOf(ctx);
        const ws = workspaces.workspaceOrThrow(wsId);
        if (a.action === "set") {
          if (!a.command && !a.url) throw new Error("Pass command or url");
          if (a.command) canvases.setSetting(wsId, a.path, "appCommand", a.command);
          if (a.url) canvases.setSetting(wsId, a.path, "appUrl", a.url);
          return "Saved on the canvas.";
        }
        const c = canvases.read(wsId, a.path);
        if (!c.appCommand) return c.appUrl ? `The canvas loads ${c.appUrl}; Cadence does not run it.` : "No app command set; route frames use the canvas devserver.";
        if (a.action === "start") return `Running at ${await apps.appUrl(wsId, c)}.`;
        if (a.action === "stop") return apps.servers.stop(ws.path, c.appCommand) ? "Stopped." : "It was not running.";
        const url = apps.servers.urlOf(ws.path, c.appCommand);
        return url ? `Running at ${url}.` : "Not running.";
      },
    }),
    define({
      name: "canvas_verify_visual",
      description: "Check that a frame renders the same every time, so its visual baseline will not flake: renders it several times fresh and compares each to the first. Fix animation, time, randomness, or loading states it reports before tracking it.",
      shape: { path: canvasPath, story: storyId, runs: z.number().int().min(2).max(6).optional() },
      run: async (a, ctx) => {
        const wsId = workspaceOf(ctx);
        const story = canvases.read(wsId, a.path).storyboards.find((s) => s.id === a.story);
        if (!story) throw new Error(`No frame ${a.story}`);
        const first = await render.screenshot(wsId, a.path, a.story);
        const diffs: number[] = [];
        for (let n = 1; n < (a.runs ?? 3); n++) diffs.push(comparePngs(first, await render.screenshot(wsId, a.path, a.story), story.vrt.threshold, story.vrt.ignore).diffPixels);
        const worst = Math.max(...diffs);
        return worst === 0 ? `Stable: ${diffs.length + 1} renders matched.` : `Unstable: up to ${worst} pixels differ between renders (${diffs.join(", ")}). Remove the changing content or add ignore regions, then check again.`;
      },
    }),
    define({
      name: "canvas_set_visual",
      description: "Track a frame in visual tests (or stop tracking it). Written into the canvas source the same way the canvas's own toggle does; do not hand-edit it.",
      shape: { path: canvasPath, story: storyId, tracked: z.boolean() },
      run: (a, ctx) => {
        canvases.trackVisual(workspaceOf(ctx), a.path, a.story, a.tracked);
        return a.tracked ? `${a.story} is tracked. Check it with canvas_verify_visual, then save a baseline with canvas_accept_baseline.` : `${a.story} is no longer tracked.`;
      },
    }),
    define({
      name: "canvas_set_home",
      description: "Make an existing canvas the workspace's main canvas: the one the Run button opens beside the app. Usually the canvas with the app's home route (/). Others stop being home.",
      shape: { path: canvasPath },
      run: async (a, ctx) => {
        await canvases.setHome(workspaceOf(ctx), a.path);
        return `${a.path} is the main canvas.`;
      },
    }),
    define({
      name: "assets_list",
      description: "The project's reusable UI building blocks: components the canvases declare as assets, grouped into libraries (the design system, a component library), with when to use each. Call this BEFORE creating or restyling any UI, and reuse what fits instead of writing a new component.",
      shape: { library: z.string().optional(), query: z.string().optional() },
      run: async (a, ctx) => {
        const lib = await canvases.assets(workspaceOf(ctx));
        const needle = a.query?.toLowerCase();
        const shown = lib.assets.filter((x) => (!a.library || x.libraries.includes(a.library) || (a.library === "No library" && !x.libraries.length)) && (!needle || `${x.name} ${x.usage ?? ""}`.toLowerCase().includes(needle)));
        const libs = Object.entries(lib.libraries).map(([name, members]) => `- ${name}: ${members.length} assets`);
        const rows = shown.map((x) => `- ${x.name} (${x.file}; ${x.libraries.join(", ") || "no library"})${x.usage ? `: ${x.usage}` : ""}${x.variants.length ? ` [variants: ${x.variants.map((v) => v.name).join(", ")}]` : ""}`);
        const problems = Object.entries(lib.errors).flatMap(([p, errs]) => errs.map((e) => `- ${p}: ${e}`));
        return [`Libraries:\n${libs.join("\n") || "- none (no canvas declares assets yet)"}`, `Assets:\n${rows.join("\n") || "- none match"}`, ...(problems.length ? [`Declaration problems:\n${problems.join("\n")}`] : [])].join("\n\n");
      },
    }),
    define({
      name: "assets_get",
      description: "One asset in full: its file and export, libraries, usage note, every variant's props, the canvas that showcases it, and warnings. Read it before reusing the component.",
      shape: { name: z.string() },
      run: async (a, ctx) => {
        const asset = (await canvases.assets(workspaceOf(ctx))).assets.find((x) => x.name.toLowerCase() === a.name.toLowerCase());
        if (!asset) throw new Error(`No asset named ${a.name}. Call assets_list.`);
        return JSON.stringify(asset, null, 2);
      },
    }),
    define({
      name: "canvas_share",
      description: "A read-only link to a canvas anyone can open without signing in. Only when the person asks to share it.",
      shape: { path: canvasPath },
      run: (a, ctx) => {
        const wsId = workspaceOf(ctx);
        canvases.read(wsId, a.path);
        return linkTo(`/share/${shares.create("canvas", `${wsId}|${a.path}`, ctx.actor).id}`);
      },
    }),
  ];
}
