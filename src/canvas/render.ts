import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { NotFoundError } from "../core/errors";
import type { WorkspaceService } from "../workspaces/service";
import type { HeadlessBrowser } from "./browser";
import type { CanvasDevServers, DevServerInfo } from "./devserver";
import type { CanvasSummary } from "./service";
import type { CanvasService } from "./service";
import type { Frame, Storyboard } from "./parse";
import type { CanvasApps } from "./apps";

export type VrtStatus = "pass" | "fail" | "new" | "size_changed" | "disabled";

export interface VrtResult {
  storyId: string;
  status: VrtStatus;
  diffPixels: number;
  diffRatio: number;
  /** Repo-relative path of the baseline image (committed with the canvas). */
  baseline: string;
  /** Data-dir file with the current render and the highlighted diff, for review. */
  currentFile: string | null;
  diffFile: string | null;
}

/** Fraction of differing pixels above which a frame fails. */
const FAIL_RATIO = 0.001;

/** Where a frame renders. Route frames use the app's own server when it has one (`appUrl`). */
export function storyUrl(dev: DevServerInfo, canvas: Pick<CanvasSummary, "path">, story: Storyboard, appUrl: string | null = null): string {
  if (story.kind === "route") return `${appUrl ?? dev.url}${story.route!.startsWith("/") ? "" : "/"}${story.route}`;
  if (story.kind === "html") return `${dev.url}/${story.html!.replace(/^\/+/, "")}`;
  return `${dev.url}/__cadence/story?canvas=${encodeURIComponent(canvas.path)}&story=${encodeURIComponent(story.id)}`;
}

export const baselinePath = (canvasPath: string, storyId: string) => `.cadence/vrt/${canvasPath.replace(/\.canvas\.[jt]sx?$/, "")}/${storyId}.png`;

function blank(png: PNG, regions: Frame[]): void {
  for (const r of regions) {
    for (let y = Math.max(0, Math.floor(r.y)); y < Math.min(png.height, r.y + r.height); y++) {
      for (let x = Math.max(0, Math.floor(r.x)); x < Math.min(png.width, r.x + r.width); x++) {
        const i = (png.width * y + x) << 2;
        png.data[i] = png.data[i + 1] = png.data[i + 2] = 0;
        png.data[i + 3] = 255;
      }
    }
  }
}

/** Compares two PNGs, ignoring regions; returns the differing pixel count and a diff image. */
export function comparePngs(baseline: Buffer, current: Buffer, threshold: number, ignore: Frame[]): { diffPixels: number; ratio: number; diff: Buffer | null; sizeChanged: boolean } {
  const a = PNG.sync.read(baseline);
  const b = PNG.sync.read(current);
  if (a.width !== b.width || a.height !== b.height) return { diffPixels: a.width * a.height, ratio: 1, diff: null, sizeChanged: true };
  blank(a, ignore);
  blank(b, ignore);
  const out = new PNG({ width: a.width, height: a.height });
  const diffPixels = pixelmatch(a.data, b.data, out.data, a.width, a.height, { threshold });
  return { diffPixels, ratio: diffPixels / (a.width * a.height), diff: PNG.sync.write(out), sizeChanged: false };
}

/** Screenshots, thumbnails, and visual regression for frames. */
export class CanvasRenderer {
  constructor(
    private canvases: CanvasService,
    private dev: CanvasDevServers,
    private browser: HeadlessBrowser,
    private workspaces: WorkspaceService,
    private dataDir: string,
    private apps?: CanvasApps,
  ) {}

  private async story(workspaceId: string, canvasPath: string, storyId: string) {
    const canvas = this.canvases.read(workspaceId, canvasPath);
    const story = canvas.storyboards.find((s) => s.id === storyId);
    if (!story) throw new NotFoundError(`Frame ${storyId} not found in ${canvasPath}`);
    const dev = await this.dev.ensure(workspaceId);
    const appUrl = story.kind === "route" ? ((await this.apps?.appUrl(workspaceId, canvas)) ?? canvas.appUrl) : null;
    return { canvas, story, url: storyUrl(dev, canvas, story, appUrl) };
  }

  /** Renders a frame at its size. */
  async screenshot(workspaceId: string, canvasPath: string, storyId: string): Promise<Buffer> {
    const { story, url } = await this.story(workspaceId, canvasPath, storyId);
    return this.browser.capture(url, story.frame.width, story.frame.height);
  }

  /** Saves a screenshot in the data dir (outside the repo) and returns its path, for agents to look at. */
  async screenshotFile(workspaceId: string, canvasPath: string, storyId: string): Promise<string> {
    const png = await this.screenshot(workspaceId, canvasPath, storyId);
    const file = join(this.dataDir, "canvas-shots", workspaceId, `${canvasPath.replace(/[\\/]/g, "_")}-${storyId}-${Date.now()}.png`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, png);
    return file;
  }

  /** A cached thumbnail of a canvas's first frame, refreshed when the canvas file changes. */
  async thumbnail(workspaceId: string, canvasPath: string): Promise<Buffer | null> {
    const canvas = this.canvases.read(workspaceId, canvasPath);
    const first = canvas.storyboards.find((s) => s.id === canvas.cover) ?? canvas.storyboards[0];
    if (!first) return null;
    const key = createHash("sha1").update(canvas.source).digest("hex").slice(0, 16);
    const file = join(this.dataDir, "canvas-thumbs", workspaceId, `${canvasPath.replace(/[\\/]/g, "_")}-${key}.png`);
    if (existsSync(file)) return readFileSync(file);
    const png = await this.screenshot(workspaceId, canvasPath, first.id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, png);
    return png;
  }

  async check(workspaceId: string, canvasPath: string, storyId: string): Promise<VrtResult> {
    const ws = this.workspaces.workspaceOrThrow(workspaceId);
    const { story } = await this.story(workspaceId, canvasPath, storyId);
    const baseline = baselinePath(canvasPath, storyId);
    const empty: VrtResult = { storyId, status: "disabled", diffPixels: 0, diffRatio: 0, baseline, currentFile: null, diffFile: null };
    if (!story.vrt.enabled) return empty;
    const current = await this.screenshot(workspaceId, canvasPath, storyId);
    const dir = join(this.dataDir, "vrt", workspaceId);
    mkdirSync(dir, { recursive: true });
    const stem = `${canvasPath.replace(/[\\/]/g, "_")}-${storyId}`;
    const currentFile = join(dir, `${stem}.current.png`);
    writeFileSync(currentFile, current);
    const basePath = join(ws.path, baseline);
    if (!existsSync(basePath)) return { ...empty, status: "new", currentFile };
    const r = comparePngs(readFileSync(basePath), current, story.vrt.threshold, story.vrt.ignore);
    let diffFile: string | null = null;
    if (r.diff) {
      diffFile = join(dir, `${stem}.diff.png`);
      writeFileSync(diffFile, r.diff);
    }
    const status: VrtStatus = r.sizeChanged ? "size_changed" : r.ratio > FAIL_RATIO ? "fail" : "pass";
    return { storyId, status, diffPixels: r.diffPixels, diffRatio: r.ratio, baseline, currentFile, diffFile };
  }

  async checkCanvas(workspaceId: string, canvasPath: string): Promise<VrtResult[]> {
    const canvas = this.canvases.read(workspaceId, canvasPath);
    const out: VrtResult[] = [];
    for (const s of canvas.storyboards) out.push(await this.check(workspaceId, canvasPath, s.id));
    return out;
  }

  /** Checks the canvas and accepts every frame that changed or has no baseline. */
  async acceptAll(workspaceId: string, canvasPath: string): Promise<string[]> {
    const accepted: string[] = [];
    for (const r of await this.checkCanvas(workspaceId, canvasPath)) {
      if (r.status === "fail" || r.status === "size_changed" || r.status === "new") accepted.push(await this.accept(workspaceId, canvasPath, r.storyId));
    }
    return accepted;
  }

  /**
   * Freezes a frame as rendered into a static HTML file beside the canvas
   * (snapshots/<Story>.html) and adds it as an HTML frame to its right,
   * for mocking up changes without touching the live component.
   */
  async snapshot(workspaceId: string, canvasPath: string, storyId: string): Promise<CanvasSummary> {
    const ws = this.workspaces.workspaceOrThrow(workspaceId);
    const { canvas, story, url } = await this.story(workspaceId, canvasPath, storyId);
    const html = await this.browser.snapshotHtml(url, story.frame.width, story.frame.height);
    const dir = canvasPath.includes("/") ? canvasPath.slice(0, canvasPath.lastIndexOf("/") + 1) : "";
    const ids = new Set(canvas.storyboards.map((s) => s.id));
    let id = `${storyId}Snapshot`;
    for (let n = 2; ids.has(id); n++) id = `${storyId}Snapshot${n}`;
    const rel = `${dir}snapshots/${id}.html`;
    const file = join(ws.path, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, html);
    const { x, y, width, height } = story.frame;
    return this.canvases.addHtmlStory(workspaceId, canvasPath, id, { name: `${story.name} (snapshot)`, html: rel, frame: { x: x + width + 80, y, width, height } });
  }

  /** Makes the current render the baseline (written into the repo so it is reviewed with the change). */
  async accept(workspaceId: string, canvasPath: string, storyId: string): Promise<string> {
    const ws = this.workspaces.workspaceOrThrow(workspaceId);
    const png = await this.screenshot(workspaceId, canvasPath, storyId);
    const rel = baselinePath(canvasPath, storyId);
    const file = join(ws.path, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, png);
    return rel;
  }
}
