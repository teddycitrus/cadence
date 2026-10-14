import { z } from "zod";
import { define, type BoardTool, type ToolOutput } from "../agents/board-tools";
import { actingMember } from "../agents/tool-context";
import type { Queries } from "../core/queries";
import { cropPng, type DesignContext, type DesignTarget } from "./design-context";
import type { CanvasRenderer } from "./render";

/** Lets an agent see what the person it works for has selected on an open canvas. */
export function designContextTools(context: DesignContext, render: CanvasRenderer, q: Queries): BoardTool[] {
  const mine = (ctx: Parameters<BoardTool["run"]>[1]) => {
    const member = actingMember(q, ctx);
    if (!member) throw new Error("Selection context belongs to a person; this session has none");
    return context.list(member);
  };
  const label = (t: DesignTarget) => {
    const ws = q.workspace(t.workspaceId);
    return `${t.id}: ${t.path} in workspace ${ws?.name ?? t.workspaceId}${ws?.branch ? ` (${ws.branch})` : ""}; ${t.element ? `selected <${t.element.tag}> at ${t.element.loc}` : t.storyId ? `frame ${t.storyId}` : "nothing selected"}`;
  };
  return [
    define({
      name: "design_context_targets",
      description: "The canvases the person you work for has open in Cadence right now, and what is selected in each. Use before design_context_get when more than one is open.",
      shape: {},
      run: (_a, ctx) => mine(ctx).map((t) => `- ${label(t)}`).join("\n") || "No open canvases. Ask the person to open the canvas and select the element.",
    }),
    define({
      name: "design_context_get",
      description: "What the person has selected on an open canvas: the element's source location, tag, classes, text, ancestors, and the frame, with a screenshot of the frame and a close-up of the element. Pass target when several canvases are open.",
      shape: { target: z.string().optional() },
      run: async (a, ctx): Promise<ToolOutput> => {
        const list = mine(ctx);
        if (!list.length) throw new Error("No open canvases. Ask the person to open the canvas and select the element.");
        const t = a.target ? list.find((x) => x.id === a.target) : list.length === 1 ? list[0] : null;
        if (!t) throw new Error(a.target ? `No open canvas ${a.target}` : `Several canvases are open; pass target:\n${list.map((x) => `- ${label(x)}`).join("\n")}`);
        if (!t.element && !t.storyId) throw new Error("Nothing is selected on that canvas. Ask the person to select an element or a frame.");
        const lines = [`Canvas ${t.path} (workspace ${t.workspaceId})`, `Frame: ${t.storyId ?? "(none)"}`];
        if (t.element) {
          const e = t.element;
          lines.push(`Element: <${e.tag}> at ${e.loc}${e.count > 1 ? ` (renders ${e.count} times)` : ""}`, `Classes: ${e.className || "(none)"}`);
          if (e.text) lines.push(`Text: ${e.text}`);
          if (e.ancestors.length) lines.push(`Ancestors (nearest first):\n${e.ancestors.map((x) => `- <${x.tag}> ${x.loc}${x.className ? ` .${x.className.split(/\s+/).join(".")}` : ""}`).join("\n")}`);
        }
        const images: ToolOutput["images"] = [];
        if (t.storyId) {
          try {
            const png = await render.screenshot(t.workspaceId, t.path, t.storyId);
            images.push({ data: png.toString("base64"), mimeType: "image/png" });
            const crop = t.element ? cropPng(png, t.element.rect) : null;
            if (crop) images.push({ data: crop.toString("base64"), mimeType: "image/png" });
          } catch (err) {
            lines.push(`Screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return { text: lines.join("\n"), images };
      },
    }),
  ];
}
