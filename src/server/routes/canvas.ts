import { git } from "../../git/git";
import { ARRANGE_OPS, type ArrangeOp } from "../../canvas/arrange";
import { currentActor } from "../../auth/context";
import { branchCanvases } from "../../canvas/branches";
import { addressedLocally, hostActions, identityOf } from "../auth-middleware";
import { REACTIONS } from "../../core/types";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Container } from "../container";
import { ForbiddenError, NotFoundError, ValidationError } from "../../core/errors";
import { baselinePath } from "../../canvas/render";
import { CANVAS_FILE, describeContext } from "../../canvas/service";
import { STYLE_PROPS, STYLE_VARIANTS, validImage, type StyleProp } from "../../canvas/tailwind";
import { buildStatus, setUpBuildPlugin } from "../../canvas/build-setup";
import { projectTokens, writeToken } from "../../canvas/tokens";
import { postVisualsToPr } from "../../canvas/vrt-report";
import { DESIGN_TOOL_INFO, DESIGN_TOOLS, designToolPrompt } from "../../canvas/design-tools";
import { NEW_ELEMENTS } from "../../canvas/compose";
import { deleteElement, duplicateElement, ORDER_MOVES, reorderElement } from "../../canvas/element-ops";

const Frame = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const PathInput = z.object({ path: z.string().min(1).max(500) });
const StoryInput = PathInput.extend({ storyId: z.string().regex(/^[A-Za-z_$][\w$]*$/) });
const StyleProps = z.enum(STYLE_PROPS as [StyleProp, ...StyleProp[]]);
const EditContext = z.object({ canvasPath: z.string().max(500), storyId: z.string().max(200), storyName: z.string().max(200), copies: z.number().int().min(0).max(100_000).optional() });
const ElementInput = z.object({
  loc: z.string().min(5).max(600),
  context: EditContext.optional(),
  change: z.object({
    // Gradients with several stops run long; everything else is short.
    styles: z
      .partialRecord(StyleProps, z.string().max(2000))
      .refine((s) => s.backgroundImage === undefined || validImage(s.backgroundImage), "Fill images must be a gradient, an image URL, or none")
      // Values become class names in source: nothing that could close the attribute or the class.
      .refine((s) => Object.entries(s).every(([k, v]) => k === "backgroundImage" || !/["'`<>{};\\[\]]/.test(v ?? "")), "Style values cannot contain quotes, brackets, braces, or semicolons")
      .optional(),
    text: z.string().max(5000).optional(),
    variant: z.enum(STYLE_VARIANTS).optional(),
  }),
});
const ImageUpload = z.object({ name: z.string().min(1).max(200), mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/avif"]), data: z.string().min(1).max(14_000_000) });
const CommentInput = z.object({
  canvasPath: z.string().min(1).max(500),
  storyId: z.string().max(200).nullable().default(null),
  x: z.number(),
  y: z.number(),
  parentId: z.string().max(100).nullable().default(null),
  body: z.string().trim().max(10_000).default(""),
  // Only this Cadence's own uploads.
  attachments: z.array(z.object({ url: z.string().regex(/^\/api\/assets\/[\w-]{1,100}$/), name: z.string().max(200) })).max(10).default([]),
}).refine((c) => c.body.length > 0 || c.attachments.length > 0, "Write something or attach an image");

const wsId = (req: Request) => String((req.params as Record<string, string>).id);

function png(res: Response, data: Buffer | null) {
  if (!data) throw new NotFoundError("Nothing to show");
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-store");
  res.end(data);
}

/** The Cadence address a request's page is open on, for frames to talk back to. */
function viewerOrigin(req: Request): string {
  const origin = req.headers.origin;
  if (origin && origin !== "null") return origin;
  const proto = String(req.headers["x-forwarded-proto"] ?? req.protocol).split(",")[0]!.trim();
  return `${proto}://${req.headers["x-forwarded-host"] ?? req.headers.host}`;
}

/** Canvases in one workspace, mounted at /api/workspaces/:id/canvas. */
export function canvasRoutes(c: Container): Router {
  const r = Router({ mergeParams: true });

  /**
   * A frame server's address for the person asking. On this computer that is the server itself;
   * someone on another computer gets a public address of its own (a site apart from Cadence's,
   * so the project's code never runs where their sign-in does).
   */
  const forViewer = async (req: Request, url: string): Promise<string> => {
    if (addressedLocally(req)) return url;
    if (!c.sharing) throw new ValidationError("Canvas previews can only be opened on the computer running Cadence");
    c.allowParent(viewerOrigin(req));
    return c.sharing.frameUrl(Number(new URL(url).port));
  };

  r.get("/", async (req, res) => {
    const dev = c.canvasDev.get(wsId(req));
    res.json({ canvases: await c.canvases.list(wsId(req)), dev: dev && { ...dev, url: await forViewer(req, dev.url).catch(() => dev.url) } });
  });

  r.post("/", (req, res) => {
    const input = z.object({ name: z.string().trim().min(1).max(80), dir: z.string().max(200).optional() }).parse(req.body);
    res.status(201).json(c.canvases.create(wsId(req), input));
  });

  /** Starts (or returns) the workspace's canvas devserver. */
  r.post("/dev", async (req, res) => {
    const dev = await c.canvasDev.ensure(wsId(req));
    res.json({ ...dev, url: await forViewer(req, dev.url) });
  });

  // The editor re-reads its canvas every few seconds to catch edits on disk; an unchanged file
  // answers 304 from its modification time and size, without being read or parsed.
  r.get("/file", (req, res) => {
    const path = String(req.query.path ?? "");
    const tag = c.canvases.version(wsId(req), path);
    if (tag) {
      res.setHeader("ETag", tag);
      res.setHeader("Cache-Control", "no-cache");
      if (req.headers["if-none-match"] === tag) return void res.status(304).end();
    }
    res.json(c.canvases.read(wsId(req), path));
  });

  r.post("/snapshot", async (req, res) => {
    const input = StoryInput.parse(req.body);
    res.status(201).json(await c.canvasRender.snapshot(wsId(req), input.path, input.storyId));
  });

  r.get("/props", (req, res) => {
    const input = StoryInput.parse({ path: req.query.path, storyId: req.query.story });
    res.json(c.canvases.props(wsId(req), input.path, input.storyId));
  });

  r.put("/props", (req, res) => {
    const input = StoryInput.extend({ name: z.string().regex(/^[A-Za-z_$][\w$-]{0,100}$/), value: z.union([z.string().max(10_000), z.number().finite(), z.boolean()]) }).parse(req.body);
    res.json(c.canvases.setProp(wsId(req), input.path, input.storyId, input.name, input.value));
  });

  r.post("/arrange", (req, res) => {
    const input = z.object({ path: z.string().min(1), storyIds: z.array(z.string().min(1).max(200)).min(2).max(200), op: z.enum(ARRANGE_OPS as [ArrangeOp, ...ArrangeOp[]]) }).parse(req.body);
    res.json(c.canvases.arrange(wsId(req), input.path, input.storyIds, input.op));
  });

  r.put("/frame", (req, res) => {
    const input = StoryInput.extend({ frame: Frame }).parse(req.body);
    res.json(c.canvases.setFrame(wsId(req), input.path, input.storyId, input.frame));
  });

  r.post("/duplicate", (req, res) => {
    const input = StoryInput.parse(req.body);
    res.json(c.canvases.duplicate(wsId(req), input.path, input.storyId));
  });

  r.post("/remove-story", (req, res) => {
    const input = StoryInput.parse(req.body);
    res.json(c.canvases.removeStory(wsId(req), input.path, input.storyId));
  });

  r.post("/element", (req, res) => {
    const input = ElementInput.parse(req.body);
    res.json(c.canvases.editElement(wsId(req), input.loc, input.change, currentActor(), input.context));
  });

  /** Where this canvas's route frames load from in a frame: the app's own dev server, through the bridge proxy. */
  r.post("/app", async (req, res) => {
    const { path } = PathInput.parse(req.body);
    const frame = await c.canvasApps.frameUrl(wsId(req), c.canvases.read(wsId(req), path));
    res.json(frame && { ...frame, proxyUrl: await forViewer(req, frame.proxyUrl) });
  });

  /** Whether the project's build stamps source locations for its own dev server (Next.js, Expo). */
  r.get("/build", (req, res) => {
    res.json(buildStatus(c.workspaces.workspaceOrThrow(wsId(req)).path));
  });

  /** Installs and configures the build plugin, and points the canvas at the app's dev command. */
  r.post("/build", async (req, res) => {
    const input = z.object({ path: z.string().min(1).max(500).optional() }).parse(req.body);
    const ws = c.workspaces.workspaceOrThrow(wsId(req));
    await c.workspaces.ensureOnDisk(ws);
    const result = await setUpBuildPlugin(ws.path);
    if (input.path && result.status.appCommand && !c.canvases.read(ws.id, input.path).appCommand) {
      c.canvases.setSetting(ws.id, input.path, "appCommand", result.status.appCommand);
      result.changed.push(input.path);
    }
    res.json(result);
  });

  /** Design tokens: the CSS custom properties the project's stylesheets define. */
  r.get("/tokens", async (req, res) => {
    const ws = c.workspaces.workspaceOrThrow(wsId(req));
    await c.workspaces.ensureOnDisk(ws);
    res.json(await projectTokens(ws.path));
  });

  r.put("/tokens", async (req, res) => {
    const input = z.object({ file: z.string().min(1).max(500), name: z.string().regex(/^--[a-zA-Z0-9_-]{1,80}$/), scope: z.string().max(200).optional(), value: z.string().trim().min(1).max(500), add: z.boolean().default(false) }).parse(req.body);
    const ws = c.workspaces.workspaceOrThrow(wsId(req));
    writeToken(ws.path, input.file, input);
    res.json(await projectTokens(ws.path));
  });

  r.get("/components", (req, res) => {
    res.json(c.canvases.components(wsId(req), String(req.query.path ?? ""), String(req.query.story ?? "")));
  });

  r.post("/detach", (req, res) => {
    const input = StoryInput.extend({ component: z.string().regex(/^[A-Z][\w$]*$/) }).parse(req.body);
    res.json(c.canvases.detach(wsId(req), input.path, input.storyId, input.component));
  });

  /** Design system jobs (generate, audit, review, harden): an agent chat in this workspace. */
  r.post("/design-tool", async (req, res) => {
    const input = z.object({ tool: z.enum(DESIGN_TOOLS), note: z.string().max(10_000).default("") }).parse(req.body);
    const info = DESIGN_TOOL_INFO.find((t) => t.id === input.tool)!;
    const chat = c.engine.createChat({ workspaceId: wsId(req), title: info.title, mode: input.tool === "harden" ? "default" : "acceptEdits" });
    await c.engine.send(chat.id, { text: designToolPrompt(input.tool, input.note) }, currentActor());
    res.status(201).json({ chatId: chat.id });
  });

  r.post("/home", async (req, res) => {
    res.json(await c.canvases.setHome(wsId(req), z.object({ path: z.string().min(1).max(500) }).parse(req.body).path));
  });

  r.post("/tidy", (req, res) => {
    res.json(c.canvases.tidy(wsId(req), z.object({ path: z.string().min(1).max(500) }).parse(req.body).path));
  });

  r.get("/library", async (req, res) => {
    res.json(await c.canvases.library(wsId(req)));
  });

  /** Stacking order, duplicate, or delete for the selected element, written to its source. */
  r.post("/element", (req, res) => {
    const input = z.object({ loc: z.string().min(3).max(600), op: z.enum([...ORDER_MOVES, "duplicate", "delete"]) }).parse(req.body);
    const op = input.op;
    const edit = op === "duplicate" ? duplicateElement : op === "delete" ? deleteElement : (s: string, l: number, c: number) => reorderElement(s, l, c, op);
    const why = op === "delete" ? "That element cannot be deleted here (it is a component's root, or it changed); reselect it" : op === "duplicate" ? "That element was not found; reselect it" : "It is already as far as it goes that way";
    res.json(c.canvases.editElementSource(wsId(req), input.loc, edit, why));
  });

  r.post("/insert-element", (req, res) => {
    const input = z.object({ loc: z.string().min(3).max(600), kind: z.enum(NEW_ELEMENTS) }).parse(req.body);
    res.json(c.canvases.insertNewElement(wsId(req), input.loc, input.kind));
  });

  r.get("/assets", async (req, res) => {
    res.json(await c.canvases.assets(wsId(req)));
  });

  r.post("/insert", (req, res) => {
    const Literal: z.ZodType<unknown> = z.lazy(() => z.union([z.string().max(2000), z.number(), z.boolean(), z.null(), z.array(Literal).max(50), z.record(z.string().max(100), Literal)]));
    const input = z
      .object({
        loc: z.string().min(3).max(600),
        component: z.object({ name: z.string().regex(/^[A-Z][\w$]*$/), file: z.string().min(1).max(500), imported: z.string().max(100) }),
        variant: z.object({ props: z.record(z.string().regex(/^[A-Za-z_$][\w$-]*$/), Literal), children: z.string().max(2000).nullable() }).nullish(),
      })
      .parse(req.body);
    res.json(c.canvases.insert(wsId(req), input.loc, input.component, (input.variant as Parameters<typeof c.canvases.insert>[3]) ?? null));
  });

  r.post("/lock", (req, res) => {
    const input = z.union([StoryInput.extend({ locked: z.boolean() }), z.object({ loc: z.string().min(5).max(600), locked: z.boolean() })]).parse(req.body);
    if ("loc" in input) res.json(c.canvases.lockElement(wsId(req), input.loc, input.locked));
    else res.json(c.canvases.lockStory(wsId(req), input.path, input.storyId, input.locked));
  });

  /** Saves an image into the project's static folder for an image fill; returns the URL the app serves it at. */
  r.post("/image", (req, res) => {
    res.status(201).json(c.canvases.saveImage(wsId(req), ImageUpload.parse(req.body)));
  });

  /** Adds a Figma frame (pasted link) to the canvas as a reference frame. */
  r.post("/figma", async (req, res) => {
    const input = PathInput.extend({ url: z.string().url().max(2000) }).parse(req.body);
    res.json(await c.figma.import(wsId(req), input.path, input.url));
  });

  r.get("/ledger", (req, res) => {
    res.json(c.canvases.ledger(wsId(req)));
  });

  r.post("/ledger", (req, res) => {
    const input = z.object({ loc: z.string().min(1).max(600), description: z.string().trim().min(1).max(2000), context: EditContext.optional() }).parse(req.body);
    res.status(201).json({ id: c.canvases.stage(wsId(req), input.loc, `${input.description}${describeContext(input.context)}`, currentActor()) });
  });

  r.delete("/ledger/:editId", (req, res) => {
    c.canvases.unstage(req.params.editId);
    res.json({ ok: true });
  });

  /** Hands every staged edit to an agent in a new chat in this workspace. */
  r.post("/ledger/apply", async (req, res) => {
    const prompt = c.canvases.takeLedger(wsId(req));
    if (!prompt) throw new ValidationError("There are no staged edits");
    const chat = c.engine.createChat({ workspaceId: wsId(req), title: "Apply canvas edits", mode: "acceptEdits" });
    await c.engine.send(chat.id, { text: prompt }, currentActor());
    res.json({ chatId: chat.id });
  });

  r.get("/comments", (req, res) => {
    res.json(c.canvases.comments(wsId(req)));
  });

  r.post("/comments", (req, res) => {
    res.status(201).json(c.canvases.comment(wsId(req), CommentInput.parse(req.body), currentActor()));
  });

  r.put("/comments/:commentId/reactions/:reaction", (req, res) => {
    const reaction = z.enum(REACTIONS).parse(req.params.reaction);
    res.json(c.canvases.react(wsId(req), req.params.commentId, reaction, z.object({ on: z.boolean() }).parse(req.body).on, currentActor()));
  });

  r.put("/comments/:commentId/body", (req, res) => {
    res.json(c.canvases.editComment(wsId(req), req.params.commentId, z.object({ body: z.string().trim().min(1).max(10_000) }).parse(req.body).body, currentActor()));
  });

  r.put("/comments/:commentId/position", (req, res) => {
    const to = z.object({ x: z.number().finite().optional(), y: z.number().finite().optional(), storyId: z.string().max(200).nullable().optional(), workspaceId: z.string().max(100).optional() }).parse(req.body);
    res.json(c.canvases.moveComment(wsId(req), req.params.commentId, to, currentActor()));
  });

  r.post("/comments/:commentId/unread", (req, res) => {
    c.canvases.unreadThread(wsId(req), req.params.commentId, identityOf(res).memberId, currentActor());
    res.json({ ok: true });
  });

  r.post("/comments/:commentId/read", (req, res) => {
    c.canvases.readThread(wsId(req), req.params.commentId, identityOf(res).memberId, currentActor());
    res.json({ ok: true });
  });

  r.patch("/comments/:commentId", (req, res) => {
    c.canvases.resolveComment(req.params.commentId, z.object({ resolved: z.boolean() }).parse(req.body).resolved, currentActor());
    res.json({ ok: true });
  });

  /** Its author or an admin deletes a message; deleting the first one removes the thread. */
  r.delete("/comments/:commentId", (req, res) => {
    const target = c.q.canvasComments(wsId(req)).find((x) => x.id === req.params.commentId);
    if (!target) throw new NotFoundError("That comment no longer exists");
    if (target.author !== currentActor() && identityOf(res).role === "member") throw new ForbiddenError("Only its author or an admin can delete this");
    c.canvases.deleteComment(req.params.commentId, currentActor());
    res.json({ ok: true });
  });

  /** Agents editing canvases in this workspace right now. */
  r.get("/editing", (req, res) => {
    res.json(c.canvasEditing.list(wsId(req)));
  });

  r.get("/screenshot", async (req, res) => {
    png(res, await c.canvasRender.screenshot(wsId(req), String(req.query.path ?? ""), String(req.query.story ?? "")));
  });

  /** Which frame is the canvas's thumbnail. */
  r.put("/cover", (req, res) => {
    const input = PathInput.extend({ storyId: z.string().min(1).max(200) }).parse(req.body);
    if (!c.canvases.read(wsId(req), input.path).storyboards.some((s) => s.id === input.storyId)) throw new NotFoundError(`No frame ${input.storyId}`);
    res.json(c.canvases.setSetting(wsId(req), input.path, "cover", input.storyId));
  });

  r.get("/thumbnail", async (req, res) => {
    png(res, await c.canvasRender.thumbnail(wsId(req), String(req.query.path ?? "")));
  });

  r.post("/vrt", async (req, res) => {
    const input = PathInput.extend({ storyId: z.string().optional() }).parse(req.body);
    res.json(input.storyId ? [await c.canvasRender.check(wsId(req), input.path, input.storyId)] : await c.canvasRender.checkCanvas(wsId(req), input.path));
  });

  /** Checks every canvas in the workspace and posts the result on its pull request (updating the last report). */
  r.post("/vrt/pr", async (req, res) => {
    res.json(await postVisualsToPr(c, wsId(req)));
  });

  /** A page open in the built-in browser, added to a canvas as a route frame. */
  r.post("/add-page", async (req, res) => {
    res.status(201).json(await c.canvases.addPage(wsId(req), z.object({ url: z.string().min(1).max(2000) }).parse(req.body).url));
  });

  r.post("/vrt/track", (req, res) => {
    const input = StoryInput.extend({ enabled: z.boolean() }).parse(req.body);
    res.json(c.canvases.trackVisual(wsId(req), input.path, input.storyId, input.enabled));
  });

  r.post("/vrt/accept-all", async (req, res) => {
    res.json({ baselines: await c.canvasRender.acceptAll(wsId(req), PathInput.parse(req.body).path) });
  });

  /** What happened on a canvas: commits to its file, comments, and edits waiting for an agent, newest first. */
  r.get("/activity", async (req, res) => {
    const path = z.string().min(1).max(500).parse(req.query.path);
    const ws = c.workspaces.workspaceOrThrow(wsId(req));
    c.canvases.resolve(ws, path, CANVAS_FILE);
    const log = ws.branch ? await git(ws.path, ["log", "-n", "30", "--format=%H%x09%an%x09%cI%x09%s", "--", path], true) : "";
    const commits = log.split("\n").filter(Boolean).map((l) => {
      const [sha, author, at, subject] = l.split("\t");
      return { kind: "commit" as const, at: at!, who: author!, text: subject!, ref: sha!.slice(0, 7) };
    });
    const comments = c.q.canvasComments(ws.id).filter((x) => x.canvasPath === path).map((x) => ({ kind: "comment" as const, at: x.createdAt, who: x.author, text: x.body || "(image)", ref: x.id, resolved: x.resolved }));
    const edits = c.q.canvasEdits(ws.id).map((x) => ({ kind: "edit" as const, at: x.createdAt, who: "", text: x.description, ref: x.loc }));
    res.json([...commits, ...comments, ...edits].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 80));
  });

  r.post("/vrt/accept", async (req, res) => {
    const input = StoryInput.parse(req.body);
    res.json({ baseline: await c.canvasRender.accept(wsId(req), input.path, input.storyId) });
  });

  /** The committed baseline, or a current/diff render from the last check. */
  r.get("/vrt/image", (req, res) => {
    const id = wsId(req);
    const kind = String(req.query.kind ?? "");
    const path = String(req.query.path ?? "");
    const story = String(req.query.story ?? "");
    if (!/^[A-Za-z_$][\w$]*$/.test(story)) throw new ValidationError("Invalid frame");
    if (kind === "baseline") {
      const ws = c.workspaces.workspaceOrThrow(id);
      c.canvases.resolve(ws, path, CANVAS_FILE);
      const file = join(ws.path, baselinePath(path, story));
      return png(res, existsSync(file) ? readFileSync(file) : null);
    }
    if (kind !== "current" && kind !== "diff") throw new ValidationError("kind is baseline, current, or diff");
    const file = join(c.dataDir, "vrt", basename(id), `${path.replace(/[\\/]/g, "_")}-${story}.${kind}.png`);
    if (!file.startsWith(join(c.dataDir, "vrt"))) throw new ValidationError("Invalid path");
    png(res, existsSync(file) ? readFileSync(file) : null);
  });

  return r;
}

/** Every canvas across live workspaces, for the canvas home page. */
export function canvasHomeRoutes(c: Container): Router {
  const r = Router();
  r.get("/", async (_req, res) => {
    const out = [];
    for (const ws of c.q.workspaces().filter((w) => !w.archived && w.branch)) {
      try {
        for (const canvas of await c.canvases.list(ws.id)) {
          const file = join(ws.path, canvas.path);
          out.push({ workspaceId: ws.id, workspaceName: ws.name, branch: ws.branch, projectId: ws.projectId, updatedAt: existsSync(file) ? statSync(file).mtime.toISOString() : null, ...canvas });
        }
      } catch {
        // a workspace not on disk has no canvases to show
      }
    }
    // Branches nobody has open: their canvases, read from git (opening one makes a workspace).
    for (const project of c.q.projects()) {
      const open = new Set(c.q.workspaces().filter((w) => !w.archived && w.projectId === project.id && w.branch).map((w) => w.branch!));
      try {
        for (const canvas of await branchCanvases(project, open)) out.push({ workspaceId: null, workspaceName: "", ...canvas });
      } catch {
        // a project folder that is gone or not a repository
      }
    }
    res.json(out);
  });

  /** Opens a canvas from a branch without a workspace: makes (or reuses) one for the branch. */
  r.post("/open", hostActions(), async (req, res) => {
    const input = z.object({ projectId: z.string().min(1).max(100), branch: z.string().min(1).max(250) }).parse(req.body);
    const ws = await c.workspaces.forBranch(input.projectId, input.branch, currentActor());
    res.json({ workspaceId: ws.id });
  });

  /** Pins a canvas to the top of the viewer's canvas home ("workspaceId|path"). */
  r.put("/pins", (req, res) => {
    const input = z.object({ key: z.string().min(3).max(700), on: z.boolean() }).parse(req.body);
    const who = identityOf(res);
    const current = c.q.members().find((m) => m.id === who.memberId)?.pinnedCanvases ?? [];
    const pinnedCanvases = input.on ? [...new Set([input.key, ...current])].slice(0, 100) : current.filter((k) => k !== input.key);
    c.store.append({ aggregate: "member", type: "MemberUpdated", aggregateId: who.memberId, payload: { pinnedCanvases } });
    res.json({ pinnedCanvases });
  });
  return r;
}
