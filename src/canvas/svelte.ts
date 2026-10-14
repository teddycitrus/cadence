import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import MagicString from "magic-string";
import { LOC_ATTR } from "./vite-plugin";

// Svelte support for canvases: stamping `data-cadence-loc` into .svelte
// markup and writing style panel edits back into it. The project's own
// Svelte compiler is used when it has one, else Cadence's.

interface SvelteCompiler {
  parse(source: string, options?: { modern?: boolean }): unknown;
}

interface SvNode {
  type: string;
  start: number;
  end: number;
  name?: string;
  data?: string;
  attributes?: SvNode[];
  value?: true | SvNode | SvNode[];
  fragment?: { nodes: SvNode[] };
  children?: SvNode[];
}

const own = createRequire(import.meta.url);
const compilers = new Map<string, SvelteCompiler | null>();

/** The Svelte compiler for a project folder (its own, else Cadence's), or null without Svelte. */
export function svelteCompiler(root: string): SvelteCompiler | null {
  if (compilers.has(root)) return compilers.get(root)!;
  let compiler: SvelteCompiler | null = null;
  for (const req of [existsSync(join(root, "package.json")) ? createRequire(join(root, "package.json")) : null, own]) {
    try {
      if (req) {
        compiler = req("svelte/compiler") as SvelteCompiler;
        break;
      }
    } catch {
      // try the next one
    }
  }
  compilers.set(root, compiler);
  return compiler;
}

/** Markup elements (lowercase tags) in document order. */
function elements(source: string, compiler: SvelteCompiler): SvNode[] {
  const ast = compiler.parse(source, { modern: true }) as { fragment?: SvNode; html?: SvNode };
  const out: SvNode[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    const n = node as SvNode & Record<string, unknown>;
    if ((n.type === "RegularElement" || n.type === "Element") && n.name && /^[a-z]/.test(n.name) && !n.name.includes(":")) out.push(n);
    for (const [k, v] of Object.entries(n)) if (k !== "metadata" && k !== "name_loc" && k !== "loc" && v && typeof v === "object") visit(v);
  };
  visit(ast.fragment ?? ast.html);
  return out.sort((a, b) => a.start - b.start);
}

/** 1-based line and 0-based column of an offset, matching the JSX stamps. */
function position(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  return { line, column: offset - (before.lastIndexOf("\n") + 1) };
}

const attrOf = (el: SvNode, name: string) => el.attributes?.find((a) => a.type === "Attribute" && a.name === name) ?? null;
const nameEnd = (el: SvNode) => el.start + 1 + el.name!.length;

/** Adds `data-cadence-loc="file:line:col"` to every element of a .svelte file. */
export function stampSvelte(code: string, relPath: string, compiler: SvelteCompiler): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  let list: SvNode[];
  try {
    list = elements(code, compiler);
  } catch {
    return null;
  }
  const s = new MagicString(code);
  let touched = false;
  for (const el of list) {
    if (attrOf(el, LOC_ATTR)) continue;
    const { line, column } = position(code, el.start);
    s.appendLeft(nameEnd(el), ` ${LOC_ATTR}="${relPath}:${line}:${column}"`);
    touched = true;
  }
  return touched ? { code: s.toString(), map: s.generateMap({ hires: true, source: relPath }) } : null;
}

export function findSvelteElement(source: string, line: number, column: number, compiler: SvelteCompiler): SvNode | null {
  return elements(source, compiler).find((el) => {
    const p = position(source, el.start);
    return p.line === line && p.column === column;
  }) ?? null;
}

/** An attribute's static text, "" for a bare attribute, or null when it has an expression. */
function staticValue(a: SvNode): { text: string; range: [number, number] | null } | null {
  if (a.value === true) return { text: "", range: null };
  const parts = Array.isArray(a.value) ? a.value : a.value ? [a.value] : [];
  if (parts.some((p) => p.type !== "Text")) return null;
  if (!parts.length) return { text: "", range: null };
  return { text: parts.map((p) => p.data ?? "").join(""), range: [parts[0]!.start, parts.at(-1)!.end] };
}

const escapeAttr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** Writes an attribute's value, adding the attribute when it is missing. */
function writeAttr(source: string, el: SvNode, name: string, value: string): string | null {
  const s = new MagicString(source);
  const a = attrOf(el, name);
  if (!a) {
    s.appendLeft(nameEnd(el), ` ${name}="${escapeAttr(value)}"`);
    return s.toString();
  }
  const current = staticValue(a);
  if (!current) return null;
  if (current.range) s.overwrite(current.range[0], current.range[1], escapeAttr(value));
  else s.overwrite(a.start, a.end, `${name}="${escapeAttr(value)}"`);
  return s.toString();
}

export function editSvelteClass(source: string, line: number, column: number, update: (classes: string[]) => string[], compiler: SvelteCompiler): string | null {
  const el = findSvelteElement(source, line, column, compiler);
  if (!el) return null;
  const a = attrOf(el, "class");
  const current = a ? staticValue(a) : { text: "", range: null };
  if (!current) return null;
  return writeAttr(source, el, "class", update(current.text.split(/\s+/).filter(Boolean)).join(" "));
}

const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Splits a style attribute into declarations, keeping semicolons inside parentheses. */
function declarations(style: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let cur = "";
  for (const ch of `${style};`) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === ";" && depth === 0) {
      const i = cur.indexOf(":");
      if (i > 0) out.push([cur.slice(0, i).trim(), cur.slice(i + 1).trim()]);
      cur = "";
    } else cur += ch;
  }
  return out;
}

export function editSvelteStyle(source: string, line: number, column: number, patch: Record<string, string | number | null>, compiler: SvelteCompiler): string | null {
  const el = findSvelteElement(source, line, column, compiler);
  if (!el) return null;
  const a = attrOf(el, "style");
  const current = a ? staticValue(a) : { text: "", range: null };
  if (!current) return null;
  const decls = new Map(declarations(current.text));
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === "") decls.delete(kebab(k));
    else decls.set(kebab(k), String(v));
  }
  return writeAttr(source, el, "style", [...decls].map(([k, v]) => `${k}: ${v}`).join("; "));
}

export function editSvelteText(source: string, line: number, column: number, text: string, compiler: SvelteCompiler): string | null {
  const el = findSvelteElement(source, line, column, compiler);
  if (!el) return null;
  const kids = (el.fragment?.nodes ?? el.children ?? []).filter((k) => !(k.type === "Text" && !k.data?.trim()));
  if (kids.length !== 1 || kids[0]!.type !== "Text") return null;
  const k = kids[0]!;
  const raw = source.slice(k.start, k.end);
  const lead = raw.match(/^\s*/)![0];
  const trail = raw.match(/\s*$/)![0];
  const safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/[{}]/g, (c) => (c === "{" ? "&#123;" : "&#125;"));
  const s = new MagicString(source);
  s.overwrite(k.start, k.end, `${lead}${safe}${trail}`);
  return s.toString();
}

export function setSvelteLocked(source: string, line: number, column: number, locked: boolean, attr: string, compiler: SvelteCompiler): string | null {
  const el = findSvelteElement(source, line, column, compiler);
  if (!el) return null;
  const a = attrOf(el, attr);
  if (locked === Boolean(a)) return source;
  const s = new MagicString(source);
  if (locked) s.appendLeft(nameEnd(el), ` ${attr}`);
  else {
    let start = a!.start;
    while (start > 0 && /\s/.test(source[start - 1]!)) start--;
    s.remove(start, a!.end);
  }
  return s.toString();
}
