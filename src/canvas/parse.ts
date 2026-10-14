import { parse } from "@babel/parser";
import type { Expression, File, Node, ObjectExpression, ObjectProperty } from "@babel/types";
import { APP_COMMAND } from "./app-command";
import { readJsxCanvas } from "./jsx-format";

// A canvas is a `*.canvas.tsx` file in the project:
//
//   export default { name: "Checkout", background: "#d7c09b" };
//   export const Empty = { name: "Empty cart", render: () => <Cart items={[]} />, frame: { x: 0, y: 0, width: 390, height: 844 } };
//   export const Home = { name: "Home page", route: "/", frame: { x: 440, y: 0, width: 1280, height: 800 } };
//   export const Mock = { name: "Pricing mock", html: "mocks/pricing.html", frame: { x: 0, y: 900, width: 800, height: 600 } };
//   export const Card = { name: "Card", svelte: "src/lib/Card.svelte", props: { title: "Hi" }, frame: { ... } };
//
// Svelte projects can write canvases as *.canvas.ts, since they need no JSX.
//
// Plain objects with no imports from Cadence, so a canvas never breaks the
// project's own build or typecheck.
//
// Canvases in the component format (a default-exported component returning <Canvas>
// with <Storyboard>, <RouteStoryboard>, <HtmlStoryboard>, and <SvelteStoryboard>
// children) are read and edited in place too; see jsx-format.ts.

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type StoryKind = "component" | "route" | "html" | "svelte";

/** Visual regression settings: a per-pixel threshold (0 to 1) and regions to ignore. */
export interface VrtSettings {
  enabled: boolean;
  threshold: number;
  ignore: Frame[];
}

export interface Storyboard {
  /** The export name. */
  id: string;
  name: string;
  kind: StoryKind;
  route: string | null;
  html: string | null;
  /** A .svelte component to mount, relative to the project root; its `props` are read at render time. */
  svelte: string | null;
  frame: Frame;
  vrt: VrtSettings;
  /** Locked frames cannot be moved or resized on the board. */
  locked: boolean;
  /** Source offsets of the frame object literal, for write-back. */
  frameRange: [number, number] | null;
  /** Source offsets of the whole `export const ... ;` statement (in the component format, the frame element). */
  range: [number, number];
  /** The component format: the component it renders and where its attributes are, for write-back. */
  jsx?: JsxStory;
}

/** Where a component-format frame's parts are in the source. */
export interface JsxStory {
  /** The local name of the component (`component={Cart}`), if any. */
  component: string | null;
  /** Where new attributes go: just before the opening tag's `/>` or `>`. */
  insertAt: number;
  /** Offsets of each attribute (whole `name={...}`) and of its value. */
  attrs: Record<string, { start: number; end: number; valueStart: number; valueEnd: number }>;
  /** Offsets of each layout number, by key. */
  frameKeys: Partial<Record<keyof Frame, [number, number]>>;
}

export interface CanvasFile {
  name: string;
  background: string;
  /** Where route frames load from when the app has its own dev server (e.g. Next.js). */
  appUrl: string | null;
  /** The app's dev command (e.g. "npm run dev"), which Cadence runs with CADENCE=1 and PORT set. */
  appCommand: string | null;
  /** The frame shown as the canvas's thumbnail; the first one when unset. */
  cover: string | null;
  /** The workspace's main canvas: Run opens it beside the app. */
  home: boolean;
  storyboards: Storyboard[];
  errors: string[];
  /** "objects" is Cadence's format; "jsx" is the <Canvas> component format. */
  format: "objects" | "jsx";
  /** The component format: where the <Canvas> element's parts are. */
  jsxCanvas?: JsxCanvas;
}

export interface JsxCanvas {
  /** Where new <Canvas> attributes go. */
  insertAt: number;
  /** Where new frames go: just before `</Canvas>` (null when it is self-closing). */
  childrenEnd: number | null;
  /** The self-closing tag's `/>` offsets, to open it up for a first frame. */
  selfClose: [number, number] | null;
  /** The indentation of the <Canvas> line. */
  indent: string;
  attrs: Record<string, { start: number; end: number; valueStart: number; valueEnd: number }>;
  /** The local names the canvas imports frame tags under, by the format's name for each. */
  tags: Record<string, string>;
  /** Offsets of the tag import's specifier list, to add a tag. */
  importSpecifiersEnd: number | null;
}

/** appUrl must point at this machine; canvases never load arbitrary sites. */
const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/;

export const DEFAULT_FRAME: Frame = { x: 0, y: 0, width: 800, height: 600 };

export function parseSource(source: string): File {
  return parse(source, { sourceType: "module", plugins: ["typescript", "jsx"], errorRecovery: true });
}

function prop(obj: ObjectExpression, key: string): ObjectProperty | null {
  for (const p of obj.properties) {
    if (p.type === "ObjectProperty" && ((p.key.type === "Identifier" && p.key.name === key) || (p.key.type === "StringLiteral" && p.key.value === key))) return p;
  }
  return null;
}

export function literal(node: Node | null | undefined): string | number | null {
  if (!node) return null;
  if (node.type === "StringLiteral" || node.type === "NumericLiteral") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]!.value.cooked ?? null;
  if (node.type === "UnaryExpression" && node.operator === "-" && node.argument.type === "NumericLiteral") return -node.argument.value;
  return null;
}

/** Unwraps `x as T`, `x satisfies T`, and parentheses down to the object literal, if there is one. */
export function objectOf(node: Node | null | undefined): ObjectExpression | null {
  let n = node;
  while (n && (n.type === "TSAsExpression" || n.type === "TSSatisfiesExpression" || n.type === "ParenthesizedExpression" || n.type === "TSTypeAssertion")) n = n.expression;
  return n?.type === "ObjectExpression" ? n : null;
}

export function readVrt(obj: ObjectExpression): VrtSettings {
  const p = prop(obj, "vrt");
  if (p?.value.type === "BooleanLiteral") return { enabled: p.value.value, threshold: 0.1, ignore: [] };
  const v = objectOf(p?.value as Expression | undefined);
  if (!v) return { enabled: true, threshold: 0.1, ignore: [] };
  const t = literal(prop(v, "threshold")?.value);
  const list = prop(v, "ignore")?.value;
  const ignore: Frame[] = [];
  if (list?.type === "ArrayExpression") {
    for (const el of list.elements) {
      const o = objectOf(el as Expression | null);
      if (!o) continue;
      const n = (k: keyof Frame) => {
        const x = literal(prop(o, k)?.value);
        return typeof x === "number" ? x : 0;
      };
      ignore.push({ x: n("x"), y: n("y"), width: n("width"), height: n("height") });
    }
  }
  return { enabled: true, threshold: typeof t === "number" ? Math.min(1, Math.max(0, t)) : 0.1, ignore };
}

function readFrame(obj: ObjectExpression): { frame: Frame; range: [number, number] | null } {
  const p = prop(obj, "frame");
  const f = objectOf(p?.value as Expression | undefined);
  if (!f) return { frame: { ...DEFAULT_FRAME }, range: null };
  const num = (k: keyof Frame) => {
    const v = literal(prop(f, k)?.value);
    return typeof v === "number" ? v : DEFAULT_FRAME[k];
  };
  return { frame: { x: num("x"), y: num("y"), width: num("width"), height: num("height") }, range: [f.start!, f.end!] };
}

export function parseCanvas(source: string, fileName = "canvas"): CanvasFile {
  const out: CanvasFile = { name: defaultName(fileName), background: "#d7c09b", appUrl: null, appCommand: null, cover: null, home: false, storyboards: [], errors: [], format: "objects" };
  let ast: File;
  try {
    ast = parseSource(source);
  } catch (err) {
    out.errors.push(err instanceof Error ? err.message : String(err));
    return out;
  }
  for (const e of (ast as unknown as { errors?: { message: string }[] }).errors ?? []) out.errors.push(e.message);
  if (readJsxCanvas(ast, source, fileName, out)) return out;
  for (const stmt of ast.program.body) {
    if (stmt.type === "ExportDefaultDeclaration") {
      const obj = objectOf(stmt.declaration as Node);
      if (obj) {
        const name = literal(prop(obj, "name")?.value);
        const bg = literal(prop(obj, "background")?.value);
        if (typeof name === "string") out.name = name;
        if (typeof bg === "string") out.background = bg;
        const appUrl = literal(prop(obj, "appUrl")?.value);
        if (typeof appUrl === "string" && LOCAL_URL.test(appUrl)) out.appUrl = appUrl.replace(/\/$/, "");
        const cover = literal(prop(obj, "cover")?.value);
        if (typeof cover === "string") out.cover = cover;
        const home = prop(obj, "home")?.value;
        out.home = home?.type === "BooleanLiteral" && home.value;
        const appCommand = literal(prop(obj, "appCommand")?.value);
        if (typeof appCommand === "string" && APP_COMMAND.test(appCommand)) out.appCommand = appCommand;
        else if (typeof appCommand === "string") out.errors.push(`appCommand "${appCommand}" is not a plain dev command (no ; | & $ or backticks)`);
      }
      continue;
    }
    if (stmt.type !== "ExportNamedDeclaration" || stmt.declaration?.type !== "VariableDeclaration") continue;
    for (const d of stmt.declaration.declarations) {
      if (d.id.type !== "Identifier") continue;
      const obj = objectOf(d.init);
      if (!obj) continue;
      const route = literal(prop(obj, "route")?.value);
      const html = literal(prop(obj, "html")?.value);
      const svelteRaw = literal(prop(obj, "svelte")?.value);
      const svelte = typeof svelteRaw === "string" && /^[\w./@-]+\.svelte$/.test(svelteRaw) && !svelteRaw.includes("..") ? svelteRaw.replace(/^\.?\//, "") : null;
      const hasRender = Boolean(prop(obj, "render") ?? obj.properties.find((p) => p.type === "ObjectMethod" && p.key.type === "Identifier" && p.key.name === "render"));
      if (!hasRender && typeof route !== "string" && typeof html !== "string" && !svelte) continue;
      const name = literal(prop(obj, "name")?.value);
      const { frame, range } = readFrame(obj);
      out.storyboards.push({
        id: d.id.name,
        name: typeof name === "string" ? name : d.id.name,
        kind: typeof route === "string" ? "route" : typeof html === "string" ? "html" : svelte ? "svelte" : "component",
        route: typeof route === "string" ? route : null,
        html: typeof html === "string" ? html : null,
        svelte,
        frame,
        vrt: readVrt(obj),
        locked: prop(obj, "locked")?.value.type === "BooleanLiteral" && (prop(obj, "locked")!.value as { value: boolean }).value,
        frameRange: range,
        range: [stmt.start!, stmt.end!],
      });
    }
  }
  return out;
}

/** A canvas's name from its file: the component format keeps each canvas in its own folder as index.canvas.tsx. */
function defaultName(fileName: string): string {
  const parts = fileName.split(/[/\\]/);
  const base = (parts.at(-1) ?? "").replace(/\.canvas\.[tj]sx?$/, "");
  return base === "index" && parts.length > 1 ? parts.at(-2)! : base;
}
