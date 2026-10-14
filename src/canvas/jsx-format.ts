import { posix } from "node:path";
import MagicString from "magic-string";
import type { File, JSXAttribute, JSXElement, JSXOpeningElement, Node, ObjectExpression } from "@babel/types";
import { APP_COMMAND } from "./app-command";
import { JSX_HOME_MARKER, JSX_TAG_MODULE } from "./jsx-compat";
import { DEFAULT_FRAME, literal, readVrt, type CanvasFile, type Frame, type JsxCanvas, type JsxStory, type Storyboard } from "./parse";

// The component canvas format: the file default-exports a component that returns
//
//   <Canvas name="Checkout" backgroundColor="#111">
//     <Storyboard id="Empty" name="Empty cart" component={Cart} props={{ items: [] }} layout={{ x: 0, y: 0, width: 390, height: 844 }} />
//     <RouteStoryboard id="Home" route="/" layout={{ x: 440, y: 0, width: 1280, height: 800 }} />
//     <HtmlStoryboard id="Mock" filepath="mocks/pricing.html" layout={...} />
//     <SvelteStoryboard id="Card" component={Card} props={{ title: "Hi" }} layout={...} />
//   </Canvas>
//
// with the tags imported from the format's module (see jsx-compat.ts). Cadence reads it, renders it
// (the import resolves to a stand-in inside the canvas devserver), and writes
// edits back as attributes, so the file stays valid in that format.

type Attr = { start: number; end: number; valueStart: number; valueEnd: number; node: JSXAttribute };

const STORY_TAGS = ["Storyboard", "SvelteStoryboard", "RouteStoryboard", "HtmlStoryboard"] as const;
const TAGS = ["Canvas", ...STORY_TAGS] as const;
const FRAME_KEYS = ["x", "y", "width", "height"] as const;
const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/;

function find(node: unknown, pred: (n: Node) => boolean): Node | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = find(n, pred);
      if (hit) return hit;
    }
    return null;
  }
  const n = node as Node & Record<string, unknown>;
  if (typeof n.type === "string" && pred(n)) return n;
  for (const [k, v] of Object.entries(n)) {
    if (k === "loc" || k === "leadingComments" || k === "trailingComments" || k === "innerComments") continue;
    if (v && typeof v === "object") {
      const hit = find(v, pred);
      if (hit) return hit;
    }
  }
  return null;
}

function attrsOf(open: JSXOpeningElement): Record<string, Attr> {
  const out: Record<string, Attr> = {};
  for (const a of open.attributes) {
    if (a.type !== "JSXAttribute" || a.name.type !== "JSXIdentifier") continue;
    out[a.name.name] = { start: a.start!, end: a.end!, valueStart: a.value?.start ?? a.end!, valueEnd: a.value?.end ?? a.end!, node: a };
  }
  return out;
}

function expression(a: Attr | undefined): Node | null {
  const v = a?.node.value;
  if (!v) return null;
  if (v.type === "JSXExpressionContainer") return v.expression.type === "JSXEmptyExpression" ? null : v.expression;
  return v;
}

function text(a: Attr | undefined): string | null {
  const v = literal(expression(a));
  return typeof v === "string" ? v : null;
}

/** Where a new attribute goes: after the last one, or after the tag name. */
function insertPoint(open: JSXOpeningElement): number {
  return open.attributes.at(-1)?.end ?? open.name.end!;
}

function indentAt(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(source.slice(lineStart))![0];
}

/** The element a default export returns: a function, an arrow, or a name for one declared in the file. */
function defaultTarget(ast: File): Node | null {
  const def = ast.program.body.find((s) => s.type === "ExportDefaultDeclaration");
  if (!def || def.type !== "ExportDefaultDeclaration") return null;
  const d = def.declaration;
  if (d.type !== "Identifier") return d;
  for (const s of ast.program.body) {
    const decl = s.type === "ExportNamedDeclaration" ? s.declaration : s;
    if (decl?.type === "FunctionDeclaration" && decl.id?.name === d.name) return decl;
    if (decl?.type === "VariableDeclaration") for (const v of decl.declarations) if (v.id.type === "Identifier" && v.id.name === d.name) return v.init ?? null;
  }
  return null;
}

/** Local names for the format's tags (`import { Storyboard as S } ...`), the specifier list end, and every import's source. */
function importsOf(ast: File): { tags: Record<string, string>; specifiersEnd: number | null; sources: Map<string, string> } {
  const tags: Record<string, string> = {};
  const sources = new Map<string, string>();
  let specifiersEnd: number | null = null;
  for (const s of ast.program.body) {
    if (s.type !== "ImportDeclaration") continue;
    for (const spec of s.specifiers) {
      sources.set(spec.local.name, s.source.value);
      if (JSX_TAG_MODULE.test(s.source.value) && spec.type === "ImportSpecifier") {
        const imported = spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
        if ((TAGS as readonly string[]).includes(imported)) tags[imported] = spec.local.name;
        specifiersEnd = spec.end!;
      }
    }
  }
  return { tags, specifiersEnd, sources };
}

function canvasElement(ast: File, tags: Record<string, string>): JSXElement | null {
  const target = defaultTarget(ast);
  const name = tags.Canvas ?? "Canvas";
  return target ? (find(target, (n) => n.type === "JSXElement" && n.openingElement.name.type === "JSXIdentifier" && n.openingElement.name.name === name) as JSXElement | null) : null;
}

/** The frame element with this id, for code that needs its AST (props, detach). */
export function jsxStoryElement(ast: File, storyId: string): JSXElement | null {
  const { tags } = importsOf(ast);
  const canvas = canvasElement(ast, tags);
  for (const child of canvas?.children ?? []) {
    if (child.type === "JSXElement" && text(attrsOf(child.openingElement).id) === storyId) return child;
  }
  return null;
}

/** Reads a component-format canvas into `out`; false when the file is not one. */
export function readJsxCanvas(ast: File, source: string, fileName: string, out: CanvasFile): boolean {
  const { tags, specifiersEnd, sources } = importsOf(ast);
  const canvas = canvasElement(ast, tags);
  if (!canvas) return false;
  out.format = "jsx";
  const open = canvas.openingElement;
  const ca = attrsOf(open);
  const name = text(ca.name);
  if (name) out.name = name;
  const bg = text(ca.backgroundColor) ?? text(ca.background);
  if (bg) out.background = bg;
  const appUrl = text(ca.appUrl);
  if (appUrl && LOCAL_URL.test(appUrl)) out.appUrl = appUrl.replace(/\/$/, "");
  const appCommand = text(ca.appCommand);
  if (appCommand && APP_COMMAND.test(appCommand)) out.appCommand = appCommand;
  else if (appCommand) out.errors.push(`appCommand "${appCommand}" is not a plain dev command (no ; | & $ or backticks)`);
  out.cover = text(ca.cover);
  // The format marks a project's main canvas with a comment.
  out.home = (ast.comments ?? []).some((c) => c.value.includes(JSX_HOME_MARKER));
  const local = (tag: string) => tags[tag] ?? tag;
  const tagOf = (el: JSXElement) => {
    const n = el.openingElement.name;
    return n.type === "JSXIdentifier" ? STORY_TAGS.find((t) => local(t) === n.name) ?? null : null;
  };
  const dir = posix.dirname(fileName.split("\\").join("/"));
  for (const child of canvas.children) {
    if (child.type !== "JSXElement") continue;
    const tag = tagOf(child);
    if (!tag) {
      out.errors.push(`<Canvas> children must be frames; ${source.slice(child.openingElement.start!, child.openingElement.end!).slice(0, 60)} is skipped`);
      continue;
    }
    const a = attrsOf(child.openingElement);
    const id = text(a.id);
    if (!id) {
      out.errors.push(`<${tag}> needs a literal id`);
      continue;
    }
    const compNode = expression(a.component);
    const component = compNode?.type === "Identifier" ? compNode.name : null;
    let svelte: string | null = null;
    if (tag === "SvelteStoryboard" && component) {
      const from = sources.get(component);
      const path = from && from.endsWith(".svelte") ? posix.normalize(from.startsWith(".") ? posix.join(dir, from) : from) : null;
      svelte = path && !path.startsWith("..") ? path : null;
    }
    const layout = expression(a.layout);
    const obj = layout?.type === "ObjectExpression" ? (layout as ObjectExpression) : null;
    const frame: Frame = { ...DEFAULT_FRAME };
    const frameKeys: JsxStory["frameKeys"] = {};
    for (const p of obj?.properties ?? []) {
      if (p.type !== "ObjectProperty" || p.key.type !== "Identifier" || !(FRAME_KEYS as readonly string[]).includes(p.key.name)) continue;
      const v = literal(p.value);
      if (typeof v !== "number") continue;
      frame[p.key.name as keyof Frame] = v;
      frameKeys[p.key.name as keyof Frame] = [p.value.start!, p.value.end!];
    }
    const lockedExpr = expression(a.locked);
    const vrtExpr = expression(a.vrt);
    const story: Storyboard = {
      id,
      name: text(a.name) ?? id,
      kind: tag === "RouteStoryboard" ? "route" : tag === "HtmlStoryboard" ? "html" : tag === "SvelteStoryboard" ? "svelte" : "component",
      route: tag === "RouteStoryboard" ? text(a.route) : null,
      html: tag === "HtmlStoryboard" ? (text(a.filepath) ?? text(a.src)) : null,
      svelte,
      frame,
      vrt: vrtExpr?.type === "BooleanLiteral" ? { enabled: vrtExpr.value, threshold: 0.1, ignore: [] } : vrtExpr?.type === "ObjectExpression" ? readVrt(vrtExpr) : { enabled: true, threshold: 0.1, ignore: [] },
      locked: Boolean(a.locked) && (!lockedExpr || (lockedExpr.type === "BooleanLiteral" && lockedExpr.value)),
      frameRange: obj ? [obj.start!, obj.end!] : null,
      range: [child.start!, child.end!],
      jsx: { component, insertAt: insertPoint(child.openingElement), attrs: plain(a), frameKeys },
    };
    if (tag === "RouteStoryboard" && !story.route) out.errors.push(`<RouteStoryboard id="${id}"> needs a literal route`);
    out.storyboards.push(story);
  }
  const jc: JsxCanvas = {
    insertAt: insertPoint(open),
    childrenEnd: canvas.closingElement?.start ?? null,
    selfClose: open.selfClosing ? [open.end! - 2, open.end!] : null,
    indent: indentAt(source, canvas.start!),
    attrs: plain(ca),
    tags,
    importSpecifiersEnd: specifiersEnd,
  };
  out.jsxCanvas = jc;
  return true;
}

function plain(a: Record<string, Attr>): JsxStory["attrs"] {
  return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, { start: v.start, end: v.end, valueStart: v.valueStart, valueEnd: v.valueEnd }]));
}

const round = (n: number) => Math.round(n);
const layoutLiteral = (f: Frame) => `{ x: ${round(f.x)}, y: ${round(f.y)}, width: ${round(f.width)}, height: ${round(f.height)} }`;

/** An attribute value: "plain text", {"text with quotes"}, or {true}. */
function attrValue(v: string | boolean): string {
  if (typeof v === "boolean") return `{${v}}`;
  return /["\n{}<>&]/.test(v) ? `{${JSON.stringify(v)}}` : `"${v}"`;
}

/** Sets (true means a bare attribute) or removes (null) one attribute. */
function setAttr(source: string, insertAt: number, attrs: JsxStory["attrs"], name: string, value: string | boolean | null): string {
  const a = attrs[name];
  if (value === null) {
    if (!a) return source;
    let start = a.start;
    while (start > 0 && /[ \t\n\r]/.test(source[start - 1]!)) start--;
    return source.slice(0, start) + source.slice(a.end);
  }
  const written = value === true ? name : `${name}=${attrValue(value)}`;
  if (a) return source.slice(0, a.start) + written + source.slice(a.end);
  return source.slice(0, insertAt) + ` ${written}` + source.slice(insertAt);
}

/** Moves or resizes a frame: rewrites the layout numbers, keeping other layout keys (zIndex, intrinsicSizing). */
export function jsxSetFrame(source: string, story: Storyboard, frame: Frame): string {
  const j = story.jsx!;
  const s = new MagicString(source);
  if (!story.frameRange) {
    s.appendLeft(j.insertAt, ` layout={${layoutLiteral(frame)}}`);
    return s.toString();
  }
  const known = FRAME_KEYS.filter((k) => j.frameKeys[k]);
  if (!known.length) {
    s.overwrite(story.frameRange[0], story.frameRange[1], layoutLiteral(frame));
    return s.toString();
  }
  for (const k of known) s.overwrite(j.frameKeys[k]![0], j.frameKeys[k]![1], String(round(frame[k])));
  const missing = FRAME_KEYS.filter((k) => !j.frameKeys[k]);
  if (missing.length) s.appendLeft(story.frameRange[1] - 1, `, ${missing.map((k) => `${k}: ${round(frame[k])}`).join(", ")} `);
  return s.toString();
}

/** A copy of the frame under a new id and name, placed to its right. */
export function jsxDuplicate(source: string, story: Storyboard, newId: string): string {
  const j = story.jsx!;
  const [start, end] = story.range;
  const edits: [number, number, string][] = [[j.attrs.id!.valueStart, j.attrs.id!.valueEnd, attrValue(newId)]];
  const nameAttr = j.attrs.name;
  if (nameAttr) edits.push([nameAttr.valueStart, nameAttr.valueEnd, attrValue(`${story.name} copy`)]);
  const x = story.frame.x + story.frame.width + 40;
  if (j.frameKeys.x) edits.push([j.frameKeys.x[0], j.frameKeys.x[1], String(round(x))]);
  else edits.push([j.insertAt, j.insertAt, ` layout={${layoutLiteral({ ...story.frame, x })}}`]);
  let copy = source.slice(start, end);
  for (const [a, b, t] of edits.sort((p, q) => q[0] - p[0])) copy = copy.slice(0, a - start) + t + copy.slice(b - start);
  return `${source.slice(0, end)}\n${indentAt(source, start)}${copy}${source.slice(end)}`;
}

/** Adds a route or HTML frame as the canvas's last child, importing its tag when needed. */
export function jsxAppend(source: string, canvas: CanvasFile, id: string, story: { name: string; html?: string; route?: string; frame: Frame }): string {
  const jc = canvas.jsxCanvas!;
  const tag = story.route ? "RouteStoryboard" : "HtmlStoryboard";
  const local = jc.tags[tag] ?? tag;
  const target = story.route ? `route=${attrValue(story.route)}` : `filepath=${attrValue(story.html ?? "")}`;
  const el = `<${local} id=${attrValue(id)} name=${attrValue(story.name)} ${target} layout={${layoutLiteral(story.frame)}} />`;
  const s = new MagicString(source);
  if (jc.childrenEnd !== null) s.appendLeft(jc.childrenEnd, `  ${el}\n${jc.indent}`);
  else if (jc.selfClose) s.overwrite(jc.selfClose[0], jc.selfClose[1], `>\n${jc.indent}  ${el}\n${jc.indent}</${jc.tags.Canvas ?? "Canvas"}>`);
  if (!jc.tags[tag] && jc.importSpecifiersEnd !== null) s.appendLeft(jc.importSpecifiersEnd, `, ${tag}`);
  return s.toString();
}

/** Removes a frame element, and its line when it stood alone. */
export function jsxRemove(source: string, story: Storyboard): string {
  let [start, end] = story.range;
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  if (/^[ \t]*$/.test(source.slice(lineStart, start))) start = lineStart;
  const rest = /^[ \t]*\r?\n/.exec(source.slice(end));
  if (rest && start === lineStart) end += rest[0].length;
  return source.slice(0, start) + source.slice(end);
}

/** Canvas settings as <Canvas> attributes; the main canvas is the format's marker comment (JSX_HOME_MARKER). */
export function jsxSetting(source: string, canvas: CanvasFile, key: string, value: string | boolean): string | null {
  const jc = canvas.jsxCanvas!;
  if (key === "home") {
    if (value === canvas.home) return source;
    if (value) return `// ${JSX_HOME_MARKER}: the canvas Run opens beside the app.\n${source}`;
    return source
      .split("\n")
      .filter((line) => !(/^\s*\/\//.test(line) && line.includes(JSX_HOME_MARKER)))
      .join("\n");
  }
  if (typeof value !== "string" || !/^[A-Za-z]\w*$/.test(key)) return null;
  const attr = key === "background" ? (jc.attrs.backgroundColor || !jc.attrs.background ? "backgroundColor" : "background") : key;
  return setAttr(source, jc.insertAt, jc.attrs, attr, value);
}

export function jsxSetLocked(source: string, story: Storyboard, locked: boolean): string {
  return setAttr(source, story.jsx!.insertAt, story.jsx!.attrs, "locked", locked ? true : null);
}

/** vrt={false} leaves a frame out of visual tests; turning it back on removes that. */
export function jsxSetVrt(source: string, story: Storyboard, enabled: boolean): string {
  const j = story.jsx!;
  if (enabled) return j.attrs.vrt ? setAttr(source, j.insertAt, j.attrs, "vrt", null) : source;
  return setAttr(source, j.insertAt, j.attrs, "vrt", false);
}
