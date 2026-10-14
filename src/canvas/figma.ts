import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ValidationError } from "../core/errors";
import type { SecretStore } from "../integrations/secrets";
import type { WorkspaceService } from "../workspaces/service";
import { appendStory } from "./edit";
import { parseCanvas, type Frame } from "./parse";
import { CANVAS_FILE, type CanvasService, type CanvasSummary } from "./service";

export class FigmaError extends Error {}

/** fileKey and node id from a Figma link (design/file/proto URLs; node-id uses "-" or ":"). */
export function parseFigmaUrl(url: string): { fileKey: string; nodeId: string } | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (!/(^|\.)figma\.com$/.test(u.hostname)) return null;
  const key = /^\/(?:design|file|proto)\/([A-Za-z0-9]+)/.exec(u.pathname)?.[1];
  const node = u.searchParams.get("node-id");
  if (!key || !node || !/^\d+[-:]\d+$/.test(node)) return null;
  return { fileKey: key, nodeId: node.replace("-", ":") };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "frame";

/**
 * Imports a Figma frame as a reference frame: the frame's PNG and a small
 * HTML wrapper are saved in the repo under .cadence/figma, and an html
 * frame at the frame's size is added to the canvas.
 */
export class FigmaImporter {
  constructor(
    private secrets: SecretStore,
    private canvases: CanvasService,
    private workspaces: WorkspaceService,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  connected(): boolean {
    return this.secrets.has("figmaToken");
  }

  private async api<T>(path: string, token: string): Promise<T> {
    const res = await this.fetchImpl(`https://api.figma.com/v1${path}`, { headers: { "X-Figma-Token": token } });
    if (!res.ok) throw new FigmaError(res.status === 403 ? "Figma rejected the token, or it cannot see that file" : `Figma ${res.status}`);
    return (await res.json()) as T;
  }

  async saveToken(token: string | null): Promise<string | null> {
    if (!token) {
      this.secrets.set("figmaToken", null);
      return null;
    }
    const me = await this.api<{ handle: string }>("/me", token);
    this.secrets.set("figmaToken", token);
    return me.handle;
  }

  async import(workspaceId: string, canvasPath: string, url: string): Promise<CanvasSummary> {
    const token = this.secrets.get("figmaToken");
    if (!token) throw new ValidationError("Add a Figma personal access token in Settings > Integrations first");
    const ref = parseFigmaUrl(url);
    if (!ref) throw new ValidationError("That is not a link to a Figma frame (it needs a node-id)");
    const ws = this.workspaces.workspaceOrThrow(workspaceId);
    const canvasFile = this.canvases.resolve(ws, canvasPath, CANVAS_FILE);
    const source = readFileSync(canvasFile, "utf8");

    const nodes = await this.api<{ nodes: Record<string, { document: { name: string; absoluteBoundingBox?: { width: number; height: number } } } | null> }>(`/files/${ref.fileKey}/nodes?ids=${encodeURIComponent(ref.nodeId)}`, token);
    const node = nodes.nodes[ref.nodeId]?.document;
    if (!node) throw new FigmaError("Figma did not return that frame");
    const images = await this.api<{ images: Record<string, string | null> }>(`/images/${ref.fileKey}?ids=${encodeURIComponent(ref.nodeId)}&format=png&scale=2`, token);
    const imageUrl = images.images[ref.nodeId];
    if (!imageUrl || !/^https:\/\/[^/]+\.(amazonaws\.com|figma\.com)\//.test(imageUrl)) throw new FigmaError("Figma did not render that frame");
    const png = Buffer.from(await (await this.fetchImpl(imageUrl)).arrayBuffer());

    const base = `${slug(node.name)}-${ref.nodeId.replace(":", "-")}`;
    const dir = join(ws.path, ".cadence", "figma");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${base}.png`), png);
    writeFileSync(
      join(dir, `${base}.html`),
      `<!doctype html>\n<html><head><meta charset="utf-8"><title>${node.name.replace(/</g, "&lt;")}</title></head>\n<body style="margin:0"><img src="./${base}.png" alt="" style="display:block;width:100%"></body></html>\n`,
    );

    const box = node.absoluteBoundingBox ?? { width: 800, height: 600 };
    const stories = parseCanvas(source).storyboards;
    const right = stories.reduce((m, s) => Math.max(m, s.frame.x + s.frame.width), -40);
    const frame: Frame = { x: right + 40, y: 0, width: Math.round(box.width), height: Math.round(box.height) };
    let id = `Figma${node.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 30) || "Frame"}`;
    for (let n = 2; stories.some((s) => s.id === id); n++) id = `${id.replace(/\d+$/, "")}${n}`;
    const next = appendStory(source, id, { name: `${node.name} (Figma)`, html: `.cadence/figma/${base}.html`, frame });
    writeFileSync(canvasFile, next);
    return { path: canvasPath, ...parseCanvas(next, canvasPath) };
  }
}
