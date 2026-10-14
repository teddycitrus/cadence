import MagicString from "magic-string";
import type { JSXAttribute, JSXElement, JSXOpeningElement, Node, ObjectExpression } from "@babel/types";
import { objectOf, parseCanvas, parseSource, type Frame } from "./parse";
import { jsxAppend, jsxDuplicate, jsxRemove, jsxSetFrame, jsxSetLocked, jsxSetting, jsxSetVrt } from "./jsx-format";

// Deterministic edits to source text. Each returns the new source, or null
// when the change cannot be made safely by rewriting literals (a computed
// className, a style built at runtime): those go to the Agent queue instead.

const round = (n: number) => Math.round(n);

export function frameLiteral(f: Frame): string {
  return `{ x: ${round(f.x)}, y: ${round(f.y)}, width: ${round(f.width)}, height: ${round(f.height)} }`;
}

/** Moves or resizes a frame by rewriting its frame literal (or adding one). */
export function setFrame(source: string, storyId: string, frame: Frame): string | null {
  const story = parseCanvas(source).storyboards.find((s) => s.id === storyId);
  if (!story) return null;
  if (story.jsx) return jsxSetFrame(source, story, frame);
  const s = new MagicString(source);
  if (story.frameRange) {
    s.overwrite(story.frameRange[0], story.frameRange[1], frameLiteral(frame));
    return s.toString();
  }
  // No frame yet: add one before the object's closing brace.
  const text = source.slice(story.range[0], story.range[1]);
  const close = text.lastIndexOf("}");
  if (close < 0) return null;
  const before = text.slice(0, close).trimEnd();
  const sep = before.endsWith(",") || before.endsWith("{") ? " " : ", ";
  s.overwrite(story.range[0] + before.length, story.range[0] + close, `${sep}frame: ${frameLiteral(frame)} `);
  return s.toString();
}

/** Copies a frame under a new export name, placed beside the original. */
export function duplicateStory(source: string, storyId: string, newId: string): string | null {
  if (!/^[A-Za-z_$][\w$]*$/.test(newId)) return null;
  const canvas = parseCanvas(source);
  const story = canvas.storyboards.find((s) => s.id === storyId);
  if (!story || canvas.storyboards.some((s) => s.id === newId)) return null;
  if (story.jsx) return jsxDuplicate(source, story, newId);
  const copy = setFrame(source, storyId, { ...story.frame, x: story.frame.x + story.frame.width + 40 });
  const moved = copy ? parseCanvas(copy).storyboards.find((s) => s.id === storyId)! : story;
  const text = (copy ?? source)
    .slice(moved.range[0], moved.range[1])
    .replace(new RegExp(`(export\\s+const\\s+)${storyId}\\b`), `$1${newId}`)
    .replace(/(\bname\s*:\s*)(["'`])(.*?)\2/, (_m, p: string, q: string, n: string) => `${p}${q}${n} copy${q}`);
  return `${source.slice(0, story.range[1])}\n\n${text}${source.slice(story.range[1])}`;
}

/** Adds a route or html frame at the end of the file. */
export function appendStory(source: string, id: string, story: { name: string; html?: string; route?: string; frame: Frame }): string {
  const canvas = parseCanvas(source);
  if (canvas.format === "jsx") return jsxAppend(source, canvas, id, story);
  const lines = [`export const ${id} = {`, `  name: ${JSON.stringify(story.name)},`];
  if (story.html) lines.push(`  html: ${JSON.stringify(story.html)},`);
  if (story.route) lines.push(`  route: ${JSON.stringify(story.route)},`);
  lines.push(`  frame: ${frameLiteral(story.frame)},`, `};`);
  return `${source.trimEnd()}\n\n${lines.join("\n")}\n`;
}

export function removeStory(source: string, storyId: string): string | null {
  const story = parseCanvas(source).storyboards.find((s) => s.id === storyId);
  if (!story) return null;
  if (story.jsx) return jsxRemove(source, story);
  let end = story.range[1];
  while (source[end] === "\n" || source[end] === "\r") end++;
  return source.slice(0, story.range[0]) + source.slice(end);
}

function walk(node: Node, visit: (n: Node) => boolean | void): boolean {
  if (visit(node)) return true;
  for (const key of Object.keys(node) as (keyof Node)[]) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
    const child = node[key] as unknown;
    if (Array.isArray(child)) {
      for (const c of child) if (c && typeof c === "object" && typeof (c as Node).type === "string" && walk(c as Node, visit)) return true;
    } else if (child && typeof child === "object" && typeof (child as Node).type === "string") {
      if (walk(child as Node, visit)) return true;
    }
  }
  return false;
}

/** The JSX element whose opening tag starts at line (1-based) and column (0-based). */
export function findElement(source: string, line: number, column: number): JSXElement | null {
  let found: JSXElement | null = null;
  walk(parseSource(source).program, (n) => {
    if (n.type === "JSXElement" && n.openingElement.loc?.start.line === line && n.openingElement.loc.start.column === column) {
      found = n;
      return true;
    }
  });
  return found;
}

function attr(el: JSXOpeningElement, name: string): JSXAttribute | null {
  return (el.attributes.find((a) => a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === name) as JSXAttribute | undefined) ?? null;
}

const isDomTag = (el: JSXOpeningElement) => el.name.type === "JSXIdentifier" && /^[a-z]/.test(el.name.name);

/** The element's className when it is a plain string, else null (computed). Undefined when absent. */
export function readClassName(el: JSXOpeningElement): string | null | undefined {
  const a = attr(el, "className") ?? attr(el, "class");
  if (!a) return undefined;
  const v = a.value;
  if (v?.type === "StringLiteral") return v.value;
  if (v?.type === "JSXExpressionContainer") {
    const e = v.expression;
    if (e.type === "StringLiteral") return e.value;
    if (e.type === "TemplateLiteral" && e.expressions.length === 0) return e.quasis[0]!.value.cooked ?? null;
  }
  return null;
}

/** Rewrites a literal className through `update`; adds one to DOM elements that have none. */
export function editClassName(source: string, line: number, column: number, update: (classes: string[]) => string[]): string | null {
  const el = findElement(source, line, column);
  if (!el) return null;
  const open = el.openingElement;
  const current = readClassName(open);
  if (current === null) return null;
  const next = update(current ? current.split(/\s+/).filter(Boolean) : []).join(" ");
  const s = new MagicString(source);
  const a = attr(open, "className") ?? attr(open, "class");
  if (a) {
    s.overwrite(a.value!.start!, a.value!.end!, JSON.stringify(next));
  } else {
    if (!isDomTag(open)) return null;
    s.appendLeft(open.name.end!, ` className=${JSON.stringify(next)}`);
  }
  return s.toString();
}

const STYLE_KEY = /^[a-zA-Z]+$/;

function isLiteral(node: Node): boolean {
  if (node.type === "StringLiteral" || node.type === "NumericLiteral") return true;
  if (node.type === "TemplateLiteral") return node.expressions.length === 0;
  return node.type === "UnaryExpression" && node.operator === "-" && node.argument.type === "NumericLiteral";
}

function styleValue(v: string | number): string {
  return typeof v === "number" ? String(v) : JSON.stringify(v);
}

/**
 * Sets or removes inline style properties when `style` is absent or an object
 * of literals. `anyElement` also adds a style to components (React Native's
 * View and Text take one), not just DOM tags.
 */
export function editStyle(source: string, line: number, column: number, patch: Record<string, string | number | null>, opts: { anyElement?: boolean } = {}): string | null {
  if (!Object.keys(patch).every((k) => STYLE_KEY.test(k))) return null;
  const el = findElement(source, line, column);
  if (!el) return null;
  const open = el.openingElement;
  const a = attr(open, "style");
  const s = new MagicString(source);
  if (!a) {
    if (!isDomTag(open) && !opts.anyElement) return null;
    const entries = Object.entries(patch).filter(([, v]) => v !== null) as [string, string | number][];
    if (!entries.length) return source;
    s.appendLeft(open.name.end!, ` style={{ ${entries.map(([k, v]) => `${k}: ${styleValue(v)}`).join(", ")} }}`);
    return s.toString();
  }
  const expr = a.value?.type === "JSXExpressionContainer" ? objectOf(a.value.expression as Node) : null;
  if (!expr) return null;
  const obj: ObjectExpression = expr;
  const entries = new Map<string, string>();
  const dynamic = new Set<string>();
  for (const p of obj.properties) {
    if (p.type !== "ObjectProperty" || p.computed) return null;
    const key = p.key.type === "Identifier" ? p.key.name : p.key.type === "StringLiteral" ? p.key.value : null;
    if (!key) return null;
    entries.set(key, source.slice(p.value.start!, p.value.end!));
    if (!isLiteral(p.value)) dynamic.add(key);
  }
  // Overwriting a computed value (featured ? a : b) would erase its logic for every variant.
  if (Object.keys(patch).some((k) => dynamic.has(k))) return null;
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) entries.delete(k);
    else entries.set(k, styleValue(v));
  }
  s.overwrite(obj.start!, obj.end!, entries.size ? `{ ${[...entries].map(([k, v]) => `${k}: ${v}`).join(", ")} }` : "{}");
  return s.toString();
}

export const LOCK_ATTR = "data-cadence-locked";

/**
 * Removes an object property spanning [start, end): its whole line when it
 * sits alone on one, else the property with the comma that joined it.
 */
function removeProperty(source: string, start: number, end: number): string {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const nl = source.indexOf("\n", end);
  const lineEnd = nl < 0 ? source.length : nl;
  if (!source.slice(lineStart, start).trim() && /^\s*,?\s*$/.test(source.slice(end, lineEnd))) return source.slice(0, lineStart) + source.slice(nl < 0 ? lineEnd : lineEnd + 1);
  const after = /^\s*,\s*/.exec(source.slice(end));
  if (after) return source.slice(0, start) + source.slice(end + after[0].length);
  const before = /\s*,\s*$/.exec(source.slice(0, start));
  return before ? source.slice(0, start - before[0].length) + source.slice(end) : source.slice(0, start) + source.slice(end);
}

/** Sets a setting (appCommand, appUrl, background, home...) in the canvas's default export, adding it if missing. */
export function setCanvasSetting(source: string, key: string, value: string | boolean): string | null {
  if (!/^[A-Za-z]\w*$/.test(key)) return null;
  const canvas = parseCanvas(source);
  if (canvas.format === "jsx") return jsxSetting(source, canvas, key, value);
  for (const stmt of parseSource(source).program.body) {
    if (stmt.type !== "ExportDefaultDeclaration") continue;
    const obj = objectOf(stmt.declaration as Node);
    if (!obj) return null;
    const p = obj.properties.find((x) => x.type === "ObjectProperty" && x.key.type === "Identifier" && x.key.name === key);
    const s = new MagicString(source);
    if (p && p.type === "ObjectProperty") s.overwrite(p.value.start!, p.value.end!, JSON.stringify(value));
    else {
      const last = obj.properties.at(-1);
      if (last) s.appendLeft(last.end!, `, ${key}: ${JSON.stringify(value)}`);
      else s.overwrite(obj.start!, obj.end!, `{ ${key}: ${JSON.stringify(value)} }`);
    }
    return s.toString();
  }
  // No default export yet: add one.
  return `${source.trimEnd()}\n\nexport default { ${key}: ${JSON.stringify(value)} };\n`;
}

/** A top-level property of a frame's object literal. */
function storyProperty(source: string, storyId: string, key: string): Node | null {
  for (const stmt of parseSource(source).program.body) {
    if (stmt.type !== "ExportNamedDeclaration" || stmt.declaration?.type !== "VariableDeclaration") continue;
    for (const d of stmt.declaration.declarations) {
      if (d.id.type !== "Identifier" || d.id.name !== storyId) continue;
      const obj = objectOf(d.init);
      const p = obj?.properties.find((x) => x.type === "ObjectProperty" && ((x.key.type === "Identifier" && x.key.name === key) || (x.key.type === "StringLiteral" && x.key.value === key)));
      return p ?? null;
    }
  }
  return null;
}

/**
 * Locks or unlocks an element on the canvas. The lock lives in the source as
 * an attribute, so it moves with the element through edits and merges.
 */
export function setElementLocked(source: string, line: number, column: number, locked: boolean): string | null {
  const el = findElement(source, line, column);
  if (!el) return null;
  const open = el.openingElement;
  const a = attr(open, LOCK_ATTR);
  if (locked === Boolean(a)) return source;
  const s = new MagicString(source);
  if (locked) s.appendLeft(open.name.end!, ` ${LOCK_ATTR}`);
  else {
    // Take the attribute and the space before it.
    let start = a!.start!;
    while (start > 0 && /\s/.test(source[start - 1]!)) start--;
    s.remove(start, a!.end!);
  }
  return s.toString();
}

/**
 * Locks a React Native component: `dataSet={{ cadenceLocked: true }}`, which
 * React Native Web renders as the same data-cadence-locked attribute. DOM
 * tags in the same file use the plain attribute.
 */
export function setNativeLocked(source: string, line: number, column: number, locked: boolean): string | null {
  const el = findElement(source, line, column);
  if (!el) return null;
  const open = el.openingElement;
  if (isDomTag(open)) return setElementLocked(source, line, column, locked);
  const a = attr(open, "dataSet");
  const obj = a?.value?.type === "JSXExpressionContainer" ? objectOf(a.value.expression as Node) : null;
  if (a && !obj) return null;
  const flag = obj?.properties.find((p) => p.type === "ObjectProperty" && p.key.type === "Identifier" && p.key.name === "cadenceLocked");
  if (locked === Boolean(flag)) return source;
  const s = new MagicString(source);
  if (locked) {
    if (!obj) s.appendLeft(open.name.end!, " dataSet={{ cadenceLocked: true }}");
    else if (obj.properties.length) s.appendLeft(obj.properties.at(-1)!.end!, ", cadenceLocked: true");
    else s.overwrite(obj.start!, obj.end!, "{ cadenceLocked: true }");
    return s.toString();
  }
  // Unlocking: drop the flag, and the whole dataSet when nothing else was in it.
  if (obj!.properties.length === 1) {
    let start = a!.start!;
    while (start > 0 && /\s/.test(source[start - 1]!)) start--;
    s.remove(start, a!.end!);
    return s.toString();
  }
  return removeProperty(source, flag!.start!, flag!.end!);
}

/** Locks a frame in place (a `locked: true` property), or unlocks it. */
export function setStoryLocked(source: string, storyId: string, locked: boolean): string | null {
  const story = parseCanvas(source).storyboards.find((s) => s.id === storyId);
  if (!story) return null;
  if (story.locked === locked) return source;
  if (story.jsx) return jsxSetLocked(source, story, locked);
  const text = source.slice(story.range[0], story.range[1]);
  if (!locked) {
    const p = storyProperty(source, storyId, "locked");
    if (!p) return null;
    return removeProperty(source, p.start!, p.end!);
  }
  const close = text.lastIndexOf("}");
  if (close < 0) return null;
  const before = text.slice(0, close).trimEnd();
  const comma = before.endsWith(",") || before.endsWith("{") ? "" : ",";
  // One property per line stays that way.
  const inserted = before.includes("\n") ? `${comma}\n${/\n([ \t]+)\S/.exec(before)?.[1] ?? "  "}locked: true,\n` : `${comma} locked: true `;
  return source.slice(0, story.range[0]) + before + inserted + text.slice(close) + source.slice(story.range[1]);
}

/** Turns a frame's visual test on or off (vrt: false); thresholds and ignore regions stay. */
export function setStoryVrt(source: string, storyId: string, enabled: boolean): string | null {
  const story = parseCanvas(source).storyboards.find((s) => s.id === storyId);
  if (!story) return null;
  if (story.vrt.enabled === enabled) return source;
  if (story.jsx) return jsxSetVrt(source, story, enabled);
  const p = storyProperty(source, storyId, "vrt") as (Node & { value?: Node }) | null;
  if (enabled) return p ? removeProperty(source, p.start!, p.end!) : source;
  if (p) return source.slice(0, p.start!) + "vrt: false" + source.slice(p.end!);
  const text = source.slice(story.range[0], story.range[1]);
  const close = text.lastIndexOf("}");
  if (close < 0) return null;
  const before = text.slice(0, close).trimEnd();
  const comma = before.endsWith(",") || before.endsWith("{") ? "" : ",";
  const inserted = before.includes("\n") ? `${comma}\n${/\n([ \t]+)\S/.exec(before)?.[1] ?? "  "}vrt: false,\n` : `${comma} vrt: false `;
  return source.slice(0, story.range[0]) + before + inserted + text.slice(close) + source.slice(story.range[1]);
}

/** Replaces the element's text when its only child is plain text. */
export function editText(source: string, line: number, column: number, text: string): string | null {
  const el = findElement(source, line, column);
  if (!el) return null;
  const kids = el.children.filter((c) => !(c.type === "JSXText" && !c.value.trim()));
  if (kids.length !== 1 || kids[0]!.type !== "JSXText") return null;
  const k = kids[0]!;
  const lead = k.value.match(/^\s*/)![0];
  const trail = k.value.match(/\s*$/)![0];
  const safe = text.replace(/[{}<>]/g, (ch) => `{${JSON.stringify(ch)}}`);
  const s = new MagicString(source);
  s.overwrite(k.start!, k.end!, `${lead}${safe}${trail}`);
  return s.toString();
}
