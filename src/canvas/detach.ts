import { copyFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import MagicString from "magic-string";
import type { Identifier, ImportDeclaration, JSXAttribute, Node } from "@babel/types";
import { ValidationError } from "../core/errors";
import { objectOf, parseSource } from "./parse";
import { jsxStoryElement } from "./jsx-format";

// Detaching a component instance: one frame gets its own copy of a
// component, so canvas edits to it change that frame only. The copy sits
// beside the original (so its relative imports keep working) and the
// frame renders the copy under a new name.

export interface ComponentUse {
  /** The JSX name in the frame, e.g. Cart. */
  name: string;
  /** The import it comes from, relative to the canvas file. */
  source: string;
  imported: string | "default";
}

function walk(node: unknown, visit: (n: Node) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  const n = node as Node & Record<string, unknown>;
  if (typeof n.type === "string") visit(n);
  for (const [k, v] of Object.entries(n)) if (k !== "loc" && v && typeof v === "object") walk(v, visit);
}

/** The frame's object (Cadence's format) or its element (the component format, where `component={X}` names what it renders). */
function storyNode(ast: ReturnType<typeof parseSource>, storyId: string): Node | null {
  const el = jsxStoryElement(ast, storyId);
  if (el) return el;
  for (const stmt of ast.program.body) {
    if (stmt.type !== "ExportNamedDeclaration" || stmt.declaration?.type !== "VariableDeclaration") continue;
    for (const d of stmt.declaration.declarations) if (d.id.type === "Identifier" && d.id.name === storyId) return objectOf(d.init);
  }
  return null;
}

/** Components a frame renders that come from relative imports (the project's own). */
export function storyComponents(source: string, storyId: string): ComponentUse[] {
  const ast = parseSource(source);
  const imports = new Map<string, { source: string; imported: string | "default" }>();
  for (const stmt of ast.program.body) {
    if (stmt.type !== "ImportDeclaration" || !stmt.source.value.startsWith(".")) continue;
    for (const s of (stmt as ImportDeclaration).specifiers) {
      if (s.type === "ImportDefaultSpecifier") imports.set(s.local.name, { source: stmt.source.value, imported: "default" });
      else if (s.type === "ImportSpecifier") imports.set(s.local.name, { source: stmt.source.value, imported: s.imported.type === "Identifier" ? s.imported.name : s.imported.value });
    }
  }
  const story = storyNode(ast, storyId);
  if (!story) return [];
  const seen = new Map<string, ComponentUse>();
  walk(story, (n) => {
    const name = n.type === "JSXOpeningElement" && n.name.type === "JSXIdentifier" ? n.name.name : componentAttr(n);
    if (name && /^[A-Z]/.test(name)) {
      const imp = imports.get(name);
      if (imp && !seen.has(name)) seen.set(name, { name, ...imp });
    }
  });
  return [...seen.values()];
}

/** `component={Cart}` on a component-format frame: the name it renders. */
function componentAttr(n: Node): string | null {
  if (n.type !== "JSXAttribute" || n.name.type !== "JSXIdentifier" || n.name.name !== "component") return null;
  return n.value?.type === "JSXExpressionContainer" && n.value.expression.type === "Identifier" ? n.value.expression.name : null;
}

const EXTENSIONS = ["", ".tsx", ".jsx", ".ts", ".js", "/index.tsx", "/index.jsx", "/index.ts", "/index.js"];

/** The file an import path points at, relative to the importing file's folder. */
export function resolveImport(fromDir: string, spec: string): string | null {
  for (const ext of EXTENSIONS) {
    const p = join(fromDir, spec + ext);
    if (existsSync(p) && /\.[jt]sx?$/.test(p)) return p;
  }
  return null;
}

/**
 * Copies `component` (as the frame uses it) and points the frame at
 * the copy. Returns the new canvas source and the copy's path (relative to the
 * project root).
 */
export function detachComponent(root: string, canvasPath: string, source: string, storyId: string, component: string): { source: string; copy: string; name: string } {
  const use = storyComponents(source, storyId).find((c) => c.name === component);
  if (!use) throw new ValidationError(`${component} is not a project component used by frame ${storyId}`);
  const canvasDir = dirname(join(root, canvasPath));
  const original = resolveImport(canvasDir, use.source);
  if (!original) throw new ValidationError(`Could not find the file for ${use.source}`);
  const ext = original.slice(original.lastIndexOf("."));
  const base = original.slice(0, -ext.length).replace(/[\\/]index$/, "");
  const tag = storyId.replace(/[^A-Za-z0-9]/g, "");
  let copy = `${base}.${tag}${ext}`;
  for (let n = 2; existsSync(copy); n++) copy = `${base}.${tag}${n}${ext}`;
  // Only rename what the frame renders; the rest of the canvas keeps the original.
  const localName = `${component}${tag}`;
  const ast = parseSource(source);
  if (ast.program.body.some((s) => s.type === "ImportDeclaration" && s.specifiers.some((x) => x.local.name === localName))) throw new ValidationError(`${localName} already exists in this canvas`);
  const story = storyNode(ast, storyId)!;
  const s = new MagicString(source);
  walk(story, (n) => {
    if ((n.type === "JSXOpeningElement" || n.type === "JSXClosingElement") && n.name.type === "JSXIdentifier" && n.name.name === component) s.overwrite(n.name.start!, n.name.end!, localName);
    if (componentAttr(n) === component) {
      const id = (n as JSXAttribute & { value: { expression: Identifier } }).value.expression;
      s.overwrite(id.start!, id.end!, localName);
    }
  });
  let spec = relative(canvasDir, copy).split("\\").join("/").replace(/\.[jt]sx?$/, "");
  if (!spec.startsWith(".")) spec = `./${spec}`;
  const statement = use.imported === "default" ? `import ${localName} from ${JSON.stringify(spec)};` : `import { ${use.imported} as ${localName} } from ${JSON.stringify(spec)};`;
  const lastImport = [...ast.program.body].reverse().find((x) => x.type === "ImportDeclaration");
  if (lastImport) s.appendLeft(lastImport.end!, `\n${statement}`);
  else s.prepend(`${statement}\n`);
  copyFileSync(original, copy);
  return { source: s.toString(), copy: relative(root, copy).split("\\").join("/"), name: localName };
}
