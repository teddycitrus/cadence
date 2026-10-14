import { randomUUID } from "node:crypto";
import { setStoryProp, storyProps, type PropValue } from "./story-props";
import { arrange, type ArrangeOp } from "./arrange";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { ForbiddenError, NotFoundError, ValidationError } from "../core/errors";
import type { EventStore } from "../core/event-store";
import type { Queries } from "../core/queries";
import type { Actor, CanvasComment, CanvasEdit, Reaction, Workspace } from "../core/types";
import { git } from "../git/git";
import type { WorkspaceService } from "../workspaces/service";
import { appendStory, duplicateStory, removeStory, setCanvasSetting, setFrame, setStoryLocked, setStoryVrt } from "./edit";
import { editorFor } from "./editors";
import { detachComponent, storyComponents, type ComponentUse } from "./detach";
import { componentLibrary, insertComponent, insertElement, tidyFrames, type LibraryComponent, type NewElement } from "./compose";
import { parseCanvas, type CanvasFile, type Frame } from "./parse";
import { canvasSummary } from "./project-config";
import { applyStyles, styleFor, type StyleProp , type StyleVariant } from "./tailwind";
import { currentActor } from "../auth/context";
import { assetLibraries, type AssetLibraries, type AssetVariant } from "./assets";
import { saveProjectImage } from "./images";

/** Canvas files: TSX/JSX, or plain TS/JS in projects without JSX (Svelte). */
export const CANVAS_FILE = /\.canvas\.[jt]sx?$/;
/** Source files whose elements the style panel can edit. */
const SOURCE_FILE = /\.(?:[jt]sx|svelte)$/;

export type CanvasSummary = CanvasFile & { path: string };

export interface ElementChange {
  styles?: Partial<Record<StyleProp, string>>;
  /** A breakpoint or state (md, hover): its own Tailwind classes change, not the base ones. */
  variant?: StyleVariant;
  text?: string;
}

export interface EditResult {
  applied: boolean;
  /** "tailwind" or "style" when written to source; "ledger" when staged for an agent. */
  via: "tailwind" | "style" | "text" | "ledger";
  file: string;
  ledgerId?: string;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "canvas";
}

/** Where on the canvas an edit was made, so an agent knows which variant was meant. */
export interface EditContext {
  canvasPath: string;
  storyId: string;
  storyName: string;
  /** How many times the element renders in that frame. */
  copies?: number;
}

export function describeChange(change: ElementChange, context?: EditContext): string {
  const parts = Object.entries(change.styles ?? {}).map(([k, v]) => (v ? `${k}: ${v}` : `remove ${k}`));
  if (change.text !== undefined) parts.push(`text: ${JSON.stringify(change.text)}`);
  return `${parts.join(", ")}${describeContext(context)}`;
}

export function describeContext(context?: EditContext): string {
  if (!context) return "";
  const copies = context.copies && context.copies > 1 ? `; the element renders ${context.copies} times there` : "";
  return ` (made on frame "${context.storyName}", export ${context.storyId} in ${context.canvasPath}${copies}; change it for that case only unless it applies to all)`;
}

/** Reads and edits a workspace's canvases and the source they render. */
export class CanvasService {
  constructor(
    private store: EventStore,
    private q: Queries,
    private workspaces: WorkspaceService,
  ) {}

  private ws(id: string): Workspace {
    const ws = this.workspaces.workspaceOrThrow(id);
    if (!existsSync(ws.path)) throw new ValidationError("Restore this workspace to work on its canvases");
    return ws;
  }

  /** A path inside the workspace, refusing anything that could escape it or reach dependencies. */
  resolve(ws: Workspace, rel: string, pattern: RegExp): string {
    const clean = normalize(rel.replace(/\\/g, "/")).split(sep).join("/");
    if (!rel || clean.startsWith("..") || clean.startsWith("/") || /^[a-zA-Z]:/.test(clean) || clean.split("/").includes("node_modules") || clean.split("/").includes(".git")) {
      throw new ValidationError(`Invalid path "${rel}"`);
    }
    if (!pattern.test(clean)) throw new ValidationError(`"${rel}" is not a ${pattern === CANVAS_FILE ? "canvas (*.canvas.tsx)" : "JSX, TSX, or Svelte"} file`);
    return join(ws.path, clean);
  }

  async list(workspaceId: string): Promise<CanvasSummary[]> {
    const ws = this.ws(workspaceId);
    if (!ws.branch && !existsSync(join(ws.path, ".git"))) return [];
    const out = await git(ws.path, ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.canvas.tsx", "*.canvas.jsx", "*.canvas.ts", "*.canvas.js"], true);
    return out
      .split("\n")
      .filter((p) => p && CANVAS_FILE.test(p))
      .sort()
      .map((path) => ({ path, ...canvasSummary(ws.path, path, readFileSync(join(ws.path, path), "utf8")) }));
  }

  /** A tag that changes whenever the canvas file does (its modification time and size), or null if it is missing. */
  version(workspaceId: string, path: string): string | null {
    const file = this.resolve(this.ws(workspaceId), path, CANVAS_FILE);
    try {
      const st = statSync(file);
      return `W/"${st.mtimeMs.toString(36)}-${st.size.toString(36)}"`;
    } catch {
      return null;
    }
  }

  read(workspaceId: string, path: string): CanvasSummary & { source: string } {
    const ws = this.ws(workspaceId);
    const file = this.resolve(ws, path, CANVAS_FILE);
    if (!existsSync(file)) throw new NotFoundError(`Canvas ${path} not found`);
    const source = readFileSync(file, "utf8");
    return { path, source, ...canvasSummary(ws.path, path, source) };
  }

  /** Writes a new canvas with one frame per component given (or a starter). */
  create(workspaceId: string, input: { name: string; dir?: string; storyboards?: { id: string; name: string; import: string; component: string; frame?: Frame }[] }): CanvasSummary {
    const ws = this.ws(workspaceId);
    const dir = input.dir ?? (existsSync(join(ws.path, "src")) ? "src/canvases" : "canvases");
    const path = `${dir.replace(/\/+$/, "")}/${slug(input.name)}.canvas.tsx`;
    const file = this.resolve(ws, path, CANVAS_FILE);
    if (existsSync(file)) throw new ValidationError(`${path} already exists`);
    const stories = input.storyboards ?? [];
    const imports = [...new Set(stories.map((s) => `import { ${s.component} } from ${JSON.stringify(s.import)};`))];
    const body = stories.length
      ? stories.map((s, i) => `export const ${s.id} = {\n  name: ${JSON.stringify(s.name)},\n  render: () => <${s.component} />,\n  frame: { x: ${s.frame?.x ?? i * 840}, y: ${s.frame?.y ?? 0}, width: ${s.frame?.width ?? 800}, height: ${s.frame?.height ?? 600} },\n};`)
      : [`export const Starter = {\n  name: "Starter",\n  render: () => <div style={{ padding: 24, fontFamily: "system-ui" }}>Replace me with a component from this project.</div>,\n  frame: { x: 0, y: 0, width: 800, height: 600 },\n};`];
    const source = [
      `// Canvas: each exported object with render, route, or html is a frame.`,
      `// Import the app's global CSS here if components rely on it.`,
      ...imports,
      ``,
      `export default { name: ${JSON.stringify(input.name)}, background: "#d7c09b" };`,
      ``,
      body.join("\n\n"),
      ``,
    ].join("\n");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
    return { path, ...parseCanvas(source, path) };
  }

  /** Deletes a canvas file. Its snapshots and visual baselines stay until removed separately. */
  deleteCanvas(workspaceId: string, path: string): void {
    const file = this.resolve(this.ws(workspaceId), path, CANVAS_FILE);
    if (!existsSync(file)) throw new NotFoundError(`Canvas ${path} not found`);
    rmSync(file);
  }

  private rewrite(workspaceId: string, path: string, fn: (source: string) => string | null, what: string): CanvasSummary {
    const ws = this.ws(workspaceId);
    const file = this.resolve(ws, path, CANVAS_FILE);
    if (!existsSync(file)) throw new NotFoundError(`Canvas ${path} not found`);
    const next = fn(readFileSync(file, "utf8"));
    if (next === null) throw new ValidationError(`Could not ${what}`);
    writeFileSync(file, next);
    return { path, ...canvasSummary(ws.path, path, next) };
  }

  setFrame(workspaceId: string, path: string, storyId: string, frame: Frame): CanvasSummary {
    if (![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) || frame.width < 20 || frame.height < 20) throw new ValidationError("Frames need finite numbers and at least 20px each way");
    return this.rewrite(
      workspaceId,
      path,
      (s) => {
        if (parseCanvas(s).storyboards.find((x) => x.id === storyId)?.locked) throw new ValidationError(`Frame ${storyId} is locked; unlock it to move it`);
        return setFrame(s, storyId, frame);
      },
      `move frame ${storyId}`,
    );
  }

  /** Adds an HTML frame (used for snapshots). */
  addHtmlStory(workspaceId: string, path: string, id: string, story: { name: string; html: string; frame: Frame }): CanvasSummary {
    return this.rewrite(workspaceId, path, (s) => appendStory(s, id, story), `add frame ${id}`);
  }

  /** A frame's literal props, for the props editor. */
  props(workspaceId: string, path: string, storyId: string): { name: string; value: PropValue }[] {
    return storyProps(this.read(workspaceId, path).source, storyId).map(({ name, value }) => ({ name, value }));
  }

  setProp(workspaceId: string, path: string, storyId: string, name: string, value: PropValue): CanvasSummary {
    return this.rewrite(workspaceId, path, (s) => {
      const next = setStoryProp(s, storyId, name, value);
      if (next === null) throw new ValidationError(`${name} is not a plain ${typeof value} prop on ${storyId}`);
      return next;
    }, `set ${storyId} ${name}`);
  }

  /** Aligns or distributes the chosen frames, in one write (locked ones refuse). */
  arrange(workspaceId: string, path: string, storyIds: string[], op: ArrangeOp): CanvasSummary {
    return this.rewrite(
      workspaceId,
      path,
      (s) => {
        const stories = parseCanvas(s).storyboards.filter((x) => storyIds.includes(x.id));
        if (stories.length !== new Set(storyIds).size) throw new ValidationError("Some of those frames are not on this canvas");
        const locked = stories.find((x) => x.locked);
        if (locked) throw new ValidationError(`Frame ${locked.id} is locked; unlock it to move it`);
        let next: string | null = s;
        for (const [id, frame] of Object.entries(arrange(Object.fromEntries(stories.map((x) => [x.id, x.frame])), op))) next = next && setFrame(next, id, frame);
        return next;
      },
      `${op.startsWith("distribute") ? "distribute" : "align"} ${storyIds.length} frames`,
    );
  }

  /** Arranges the frames in tidy rows (locked ones stay put). */
  tidy(workspaceId: string, path: string): CanvasSummary {
    return this.rewrite(
      workspaceId,
      path,
      (s) => {
        let out: string | null = s;
        for (const [id, frame] of tidyFrames(parseCanvas(s).storyboards)) out = out && setFrame(out, id, frame);
        return out;
      },
      "tidy up frames",
    );
  }

  /** Project components the canvases render, for inserting into any frame. */
  async library(workspaceId: string): Promise<LibraryComponent[]> {
    const ws = this.ws(workspaceId);
    return componentLibrary(ws.path, (await this.list(workspaceId)).map((c) => ({ path: c.path, storyIds: c.storyboards.filter((s) => s.kind === "component").map((s) => s.id) })));
  }

  /**
   * Rewrites the JSX/TSX file behind an element location with `edit`
   * (insert, reorder, duplicate, delete). `edit` returns null when the
   * element is gone or the change does not apply; `why` explains that.
   */
  editElementSource(workspaceId: string, loc: string, edit: (source: string, line: number, col: number, file: string) => string | null, why: string): { file: string } {
    const { file, rel, line, col } = this.locate(this.ws(workspaceId), loc);
    if (!/\.[jt]sx$/.test(file)) throw new ValidationError("Only elements in JSX and TSX files can be changed here");
    const next = edit(readFileSync(file, "utf8"), line, col, file);
    if (next === null) throw new ValidationError(why);
    writeFileSync(file, next);
    return { file: rel };
  }

  /** Adds a new div, rectangle, or text element inside the selected element (the canvas toolbar's drawing tools). */
  insertNewElement(workspaceId: string, loc: string, kind: NewElement): { file: string } {
    return this.editElementSource(workspaceId, loc, (s, l, c) => insertElement(s, l, c, kind), "That element was not found; reselect it and try again");
  }

  /** The component kits the workspace's canvases declare. */
  async assets(workspaceId: string): Promise<AssetLibraries> {
    return assetLibraries(this.ws(workspaceId).path, (await this.list(workspaceId)).map((c) => c.path));
  }

  /** Adds a library component inside the selected element (as its last child), optionally as one of its variants. */
  insert(workspaceId: string, loc: string, component: LibraryComponent, variant: Pick<AssetVariant, "props" | "children"> | null = null): { file: string } {
    const ws = this.ws(workspaceId);
    this.resolve(ws, component.file, SOURCE_FILE);
    return this.editElementSource(workspaceId, loc, (s, l, c, file) => insertComponent(s, l, c, dirname(file), ws.path, component, variant), "That element was not found; reselect it and try again");
  }

  /** Sets a canvas-level setting such as appCommand or appUrl. */
  setSetting(workspaceId: string, path: string, key: "appCommand" | "appUrl" | "background" | "name" | "cover" | "home", value: string | boolean): CanvasSummary {
    return this.rewrite(workspaceId, path, (s) => setCanvasSetting(s, key, value), `set ${key}`);
  }

  /** Makes one canvas the workspace's main canvas (the one Run opens beside the app); the others stop being it. */
  async setHome(workspaceId: string, path: string): Promise<CanvasSummary> {
    for (const c of await this.list(workspaceId)) if (c.home && c.path !== path) this.setSetting(workspaceId, c.path, "home", false);
    return this.setSetting(workspaceId, path, "home", true);
  }

  /** The project components a frame renders, which can be detached. */
  components(workspaceId: string, path: string, storyId: string): ComponentUse[] {
    return storyComponents(this.read(workspaceId, path).source, storyId);
  }

  /** Gives one frame its own copy of a component, so edits to it stay in that frame. */
  detach(workspaceId: string, path: string, storyId: string, component: string): CanvasSummary & { copy: string; name: string } {
    const ws = this.ws(workspaceId);
    const file = this.resolve(ws, path, CANVAS_FILE);
    const result = detachComponent(ws.path, path, readFileSync(file, "utf8"), storyId, component);
    writeFileSync(file, result.source);
    return { path, ...canvasSummary(ws.path, path, result.source), copy: result.copy, name: result.name };
  }

  lockStory(workspaceId: string, path: string, storyId: string, locked: boolean): CanvasSummary {
    return this.rewrite(workspaceId, path, (s) => setStoryLocked(s, storyId, locked), `${locked ? "lock" : "unlock"} frame ${storyId}`);
  }

  /**
   * Adds a page of the running app (from the built-in browser) to a canvas as
   * a route frame: the first canvas, or a new "Pages" one. A canvas with
   * no app URL yet is pointed at that app.
   */
  async addPage(workspaceId: string, url: string): Promise<CanvasSummary> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new ValidationError("That is not a page address");
    }
    if (!/^(localhost|127\.0\.0\.1)$/.test(u.hostname) || !/^https?:$/.test(u.protocol)) throw new ValidationError("Only pages of an app running on this machine can be added to a canvas");
    const path = (await this.list(workspaceId))[0]?.path ?? this.create(workspaceId, { name: "Pages" }).path;
    const route = `${u.pathname}${u.search}` || "/";
    if (!this.read(workspaceId, path).appUrl) this.setSetting(workspaceId, path, "appUrl", u.origin);
    return this.rewrite(
      workspaceId,
      path,
      (s) => {
        const stories = parseCanvas(s).storyboards;
        const ids = new Set(stories.map((x) => x.id));
        const base = (route.replace(/[^A-Za-z0-9]+/g, " ").trim().replace(/(?:^|\s)(\w)/g, (_m, c: string) => c.toUpperCase()) || "Home").replace(/^(\d)/, "Page$1");
        let id = base;
        for (let n = 2; ids.has(id); n++) id = `${base}${n}`;
        const right = Math.max(0, ...stories.map((x) => x.frame.x + x.frame.width));
        return appendStory(s, id, { name: route, route, frame: { x: stories.length ? right + 80 : 0, y: 0, width: 1280, height: 800 } });
      },
      `add page ${route}`,
    );
  }

  /** Includes a frame in visual tests, or leaves it out (vrt: false). */
  trackVisual(workspaceId: string, path: string, storyId: string, enabled: boolean): CanvasSummary {
    return this.rewrite(workspaceId, path, (s) => setStoryVrt(s, storyId, enabled), `${enabled ? "track" : "untrack"} visual test for ${storyId}`);
  }

  /** Locks an element so the canvas no longer selects it (or unlocks it). */
  lockElement(workspaceId: string, loc: string, locked: boolean): { file: string } {
    const ws = this.ws(workspaceId);
    const { file, rel, line, col } = this.locate(ws, loc);
    const next = editorFor(file, ws.path).lock(readFileSync(file, "utf8"), line, col, locked);
    if (next === null) throw new ValidationError(`Could not find the element at ${loc}; the file may have changed`);
    writeFileSync(file, next);
    return { file: rel };
  }

  /** Saves an image for an image fill into the project's static folder (see saveProjectImage). */
  saveImage(workspaceId: string, input: { name: string; mediaType: string; data: string }): { url: string; path: string } {
    return saveProjectImage(this.ws(workspaceId).path, input);
  }

  /** The file and position behind an element location ("file:line:col"). */
  private locate(ws: Workspace, loc: string): { file: string; rel: string; line: number; col: number } {
    const m = /^(.+):(\d+):(\d+)$/.exec(loc);
    if (!m) throw new ValidationError(`Invalid element location "${loc}"`);
    const [, rel, lineText, colText] = m as unknown as [string, string, string, string];
    const file = this.resolve(ws, rel, SOURCE_FILE);
    if (!existsSync(file)) throw new NotFoundError(`${rel} not found`);
    return { file, rel, line: Number(lineText), col: Number(colText) };
  }

  duplicate(workspaceId: string, path: string, storyId: string): CanvasSummary {
    return this.rewrite(
      workspaceId,
      path,
      (s) => {
        const ids = new Set(parseCanvas(s).storyboards.map((x) => x.id));
        let n = 2;
        while (ids.has(`${storyId}${n}`)) n++;
        return duplicateStory(s, storyId, `${storyId}${n}`);
      },
      `duplicate frame ${storyId}`,
    );
  }

  removeStory(workspaceId: string, path: string, storyId: string): CanvasSummary {
    return this.rewrite(workspaceId, path, (s) => removeStory(s, storyId), `remove frame ${storyId}`);
  }

  private usesTailwind(ws: Workspace): boolean {
    try {
      const pkg = JSON.parse(readFileSync(join(ws.path, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      return Boolean(pkg.dependencies?.tailwindcss ?? pkg.devDependencies?.tailwindcss);
    } catch {
      return false;
    }
  }

  /**
   * Applies a style panel change to the element at `loc` ("file:line:col").
   * Writes Tailwind classes or an inline style when the source allows it;
   * otherwise stages the change in the Agent queue.
   */
  editElement(workspaceId: string, loc: string, change: ElementChange, actor: Actor = currentActor(), context?: EditContext): EditResult {
    const ws = this.ws(workspaceId);
    const { file, rel, line, col } = this.locate(ws, loc);
    const editor = editorFor(file, ws.path);
    let source = readFileSync(file, "utf8");
    let via: EditResult["via"] | null = null;
    let failed = false;

    if (change.styles && Object.keys(change.styles).length) {
      const styles = change.styles;
      const tw = this.usesTailwind(ws) ? editor.className(source, line, col, (c) => applyStyles(c, styles, change.variant)) : null;
      // Inline styles have no breakpoints or states, so a variant edit without Tailwind goes to the ledger.
      const next = tw ?? (change.variant ? null : editor.style(source, line, col, styleFor(styles)));
      if (next === null) failed = true;
      else {
        source = next;
        via = tw ? "tailwind" : "style";
      }
    }
    if (!failed && change.text !== undefined) {
      const next = editor.text(source, line, col, change.text);
      if (next === null) failed = true;
      else {
        source = next;
        via ??= "text";
      }
    }
    if (failed) {
      const ledgerId = this.stage(workspaceId, loc, describeChange(change, context), actor);
      return { applied: false, via: "ledger", file: rel, ledgerId };
    }
    writeFileSync(file, source);
    return { applied: true, via: via ?? "text", file: rel };
  }

  stage(workspaceId: string, loc: string, description: string, actor: Actor = currentActor()): string {
    const id = randomUUID();
    this.store.append({ aggregate: "canvas", type: "CanvasEditStaged", aggregateId: id, payload: { workspaceId, loc, description } }, actor);
    return id;
  }

  ledger(workspaceId: string): CanvasEdit[] {
    return this.q.canvasEdits(workspaceId);
  }

  unstage(id: string): void {
    this.store.append({ aggregate: "canvas", type: "CanvasEditRemoved", aggregateId: id, payload: {} }, "user");
  }

  /** The prompt an agent gets to apply every staged edit in one commit; the ledger empties. */
  takeLedger(workspaceId: string): string | null {
    const edits = this.ledger(workspaceId);
    if (!edits.length) return null;
    for (const e of edits) this.unstage(e.id);
    return [
      "Apply these visual edits made on the canvas. Each could not be written mechanically (computed classes, runtime styles, or loop-rendered elements), so change the source so the rendered result matches. Keep the project's styling conventions, touch nothing else, and commit once when done.",
      "",
      ...edits.map((e, i) => `${i + 1}. Element at ${e.loc}: ${e.description}`),
    ].join("\n");
  }

  comments(workspaceId: string): CanvasComment[] {
    return this.q.canvasComments(workspaceId);
  }

  comment(workspaceId: string, input: { canvasPath: string; storyId: string | null; x: number; y: number; parentId: string | null; body: string; attachments?: { url: string; name: string }[] }, actor: Actor): CanvasComment {
    this.resolve(this.ws(workspaceId), input.canvasPath, CANVAS_FILE);
    if (input.parentId && !this.q.canvasComments(workspaceId).some((c) => c.id === input.parentId)) throw new NotFoundError("That comment no longer exists");
    const id = randomUUID();
    this.store.append({ aggregate: "canvas", type: "CanvasCommentAdded", aggregateId: id, payload: { workspaceId, ...input } }, actor);
    return this.q.canvasComments(workspaceId).find((c) => c.id === id)!;
  }

  react(workspaceId: string, id: string, reaction: Reaction, on: boolean, actor: Actor): CanvasComment {
    if (!this.q.canvasComments(workspaceId).some((c) => c.id === id)) throw new NotFoundError("That comment no longer exists");
    this.store.append({ aggregate: "canvas", type: "CanvasCommentReacted", aggregateId: id, payload: { reaction, on } }, actor);
    return this.q.canvasComments(workspaceId).find((c) => c.id === id)!;
  }

  private commentOrThrow(workspaceId: string, id: string): CanvasComment {
    const c = this.q.canvasComments(workspaceId).find((x) => x.id === id);
    if (!c) throw new NotFoundError("That comment no longer exists");
    return c;
  }

  editComment(workspaceId: string, id: string, body: string, actor: Actor): CanvasComment {
    if (this.commentOrThrow(workspaceId, id).author !== actor) throw new ForbiddenError("Only its author can edit a comment");
    this.store.append({ aggregate: "canvas", type: "CanvasCommentEdited", aggregateId: id, payload: { body } }, actor);
    return this.commentOrThrow(workspaceId, id);
  }

  /** Moves a pin on the board, or a whole thread to another workspace with the same canvas. */
  moveComment(workspaceId: string, id: string, to: { x?: number; y?: number; storyId?: string | null; workspaceId?: string }, actor: Actor): CanvasComment {
    const c = this.commentOrThrow(workspaceId, id);
    if (c.parentId) throw new ValidationError("Move the thread, not a reply");
    if (to.workspaceId && to.workspaceId !== workspaceId) this.resolve(this.ws(to.workspaceId), c.canvasPath, CANVAS_FILE);
    this.store.append({ aggregate: "canvas", type: "CanvasCommentMoved", aggregateId: id, payload: to }, actor);
    return this.commentOrThrow(to.workspaceId ?? workspaceId, id);
  }

  readThread(workspaceId: string, id: string, memberId: string, actor: Actor): void {
    const c = this.commentOrThrow(workspaceId, id);
    const latest = this.q.canvasComments(workspaceId).filter((x) => x.id === id || x.parentId === id).map((x) => x.editedAt ?? x.createdAt).sort().at(-1)!;
    if ((c.readBy?.[memberId] ?? "") >= latest) return;
    this.store.append({ aggregate: "canvas", type: "CanvasCommentRead", aggregateId: id, payload: { memberId } }, actor);
  }

  unreadThread(workspaceId: string, id: string, memberId: string, actor: Actor): void {
    if (!this.commentOrThrow(workspaceId, id).readBy?.[memberId]) return;
    this.store.append({ aggregate: "canvas", type: "CanvasCommentUnread", aggregateId: id, payload: { memberId } }, actor);
  }

  resolveComment(id: string, resolved: boolean, actor: Actor = "user"): void {
    this.store.append({ aggregate: "canvas", type: "CanvasCommentResolved", aggregateId: id, payload: { resolved } }, actor);
  }

  deleteComment(id: string, actor: Actor = "user"): void {
    this.store.append({ aggregate: "canvas", type: "CanvasCommentDeleted", aggregateId: id, payload: {} }, actor);
  }
}
