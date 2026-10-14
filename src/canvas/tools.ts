import { z } from "zod";
import { define, type BoardTool, type ToolContext } from "../agents/board-tools";
import type { Queries } from "../core/queries";
import type { CanvasRenderer } from "./render";
import type { CanvasService } from "./service";

const canvasPath = z.string().regex(/\.canvas\.[jt]sx?$/).describe("Repo-relative path, e.g. src/checkout.canvas.tsx");
const storyId = z.string().regex(/^[A-Za-z_$][\w$]*$/).describe("The frame's export name");

function workspaceOf(ctx: ToolContext): string {
  if (!ctx.workspaceId) throw new Error("Canvas tools only work from a workspace chat");
  return ctx.workspaceId;
}

/** Tools for agents working on canvases in their workspace. */
export function canvasTools(canvases: CanvasService, render: CanvasRenderer, q: Queries): BoardTool[] {
  return [
    define({
      name: "canvas_list",
      description:
        "List this workspace's canvases (*.canvas.tsx files) and their frames. A canvas is a file of exported objects: { name, render: () => <Component/>, frame: { x, y, width, height } } for a component state, { name, route: '/path', frame } for a live app route, or { name, html: 'mocks/x.html', frame } for a static mock. The default export holds { name, background }.",
      shape: {},
      run: async (_a, ctx) => {
        const list = await canvases.list(workspaceOf(ctx));
        if (!list.length) return "No canvases yet. Create one with canvas_create, or write a *.canvas.tsx file.";
        return list.map((c) => [`${c.path} "${c.name}"${c.errors.length ? " (has syntax errors)" : ""}`, ...c.storyboards.map((s) => `  - ${s.id} "${s.name}" ${s.kind}${s.route ? ` ${s.route}` : ""}${s.html ? ` ${s.html}` : ""} at ${s.frame.x},${s.frame.y} ${s.frame.width}x${s.frame.height}`)].join("\n")).join("\n");
      },
    }),
    define({
      name: "canvas_create",
      description:
        "Create a canvas file with one frame per component state. Each frame renders an existing component, so designs stay real code. Edit the file afterwards to add props, more states, or imports of global CSS.",
      shape: {
        name: z.string().min(1).max(80),
        storyboards: z
          .array(z.object({ id: storyId, name: z.string().min(1).max(80), import: z.string().min(1).describe("Import path relative to the canvas file, e.g. ../components/Cart"), component: z.string().regex(/^[A-Z][\w]*$/) }))
          .max(30)
          .optional(),
      },
      run: (a, ctx) => {
        const c = canvases.create(workspaceOf(ctx), { name: a.name, storyboards: a.storyboards });
        return `Created ${c.path} with ${c.storyboards.length} frame(s). People can open it under Canvases.`;
      },
    }),
    define({
      name: "canvas_screenshot",
      description: "Render one frame exactly as people see it on the canvas and return the image. Use it to check UI work visually.",
      shape: { path: canvasPath, story: storyId },
      run: async (a, ctx) => {
        const png = await render.screenshot(workspaceOf(ctx), a.path, a.story);
        return { text: `Frame ${a.story} from ${a.path}:`, images: [{ data: png.toString("base64"), mimeType: "image/png" }] };
      },
    }),
    define({
      name: "canvas_check_visuals",
      description: "Run visual regression for a canvas (or one frame): compares renders to the baselines in .cadence/vrt and reports which changed.",
      shape: { path: canvasPath, story: storyId.optional() },
      run: async (a, ctx) => {
        const ws = workspaceOf(ctx);
        const results = a.story ? [await render.check(ws, a.path, a.story)] : await render.checkCanvas(ws, a.path);
        return results.map((r) => `- ${r.storyId}: ${r.status}${r.status === "fail" ? ` (${r.diffPixels} px, ${(r.diffRatio * 100).toFixed(2)}%)` : ""}`).join("\n") || "No frames.";
      },
    }),
    define({
      name: "canvas_accept_baseline",
      description: "Save a frame's current render as its visual baseline. Only when the visual change is intended; the baseline file is committed with your change.",
      shape: { path: canvasPath, story: storyId },
      run: async (a, ctx) => `Baseline saved to ${await render.accept(workspaceOf(ctx), a.path, a.story)}.`,
    }),
    define({
      name: "canvas_comments",
      description: "Open comment threads people pinned on this workspace's canvases (design feedback to address).",
      shape: { path: canvasPath.optional(), include_resolved: z.boolean().optional() },
      run: (a, ctx) => {
        const all = canvases.comments(workspaceOf(ctx)).filter((c) => !a.path || c.canvasPath === a.path);
        const roots = all.filter((c) => !c.parentId && (a.include_resolved || !c.resolved));
        const who = (actor: string) => (actor === "user" ? "teammate" : actor.startsWith("agent:") ? `agent ${q.agent(actor.slice(6))?.name ?? ""}`.trim() : actor);
        return (
          roots
            .map((r) => [`[${r.id}] ${r.canvasPath}${r.storyId ? ` on ${r.storyId}` : ""}${r.resolved ? " (resolved)" : ""}`, ...[r, ...all.filter((x) => x.parentId === r.id)].map((c) => `  ${who(c.author)}: ${c.body}`)].join("\n"))
            .join("\n") || "No open comments."
        );
      },
    }),
    define({
      name: "canvas_reply",
      description: "Reply in a canvas comment thread, e.g. to say what you changed. Set resolve to close the thread when the feedback is addressed.",
      shape: { comment_id: z.string().min(1), body: z.string().min(1).max(4000), resolve: z.boolean().optional() },
      run: (a, ctx) => {
        const ws = workspaceOf(ctx);
        const root = canvases.comments(ws).find((c) => c.id === a.comment_id);
        if (!root) throw new Error("Comment not found");
        canvases.comment(ws, { canvasPath: root.canvasPath, storyId: root.storyId, x: root.x, y: root.y, parentId: root.parentId ?? root.id, body: a.body }, ctx.actor);
        if (a.resolve) canvases.resolveComment(root.parentId ?? root.id, true);
        return a.resolve ? "Replied and resolved." : "Replied.";
      },
    }),
  ];
}
