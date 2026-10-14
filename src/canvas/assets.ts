import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Expression, ImportDeclaration, Node, ObjectExpression } from "@babel/types";
import { resolveImport } from "./detach";
import { objectOf, parseSource } from "./parse";

// Component kits: canvases can declare the components they showcase as
// reusable assets, with the libraries they belong to, when to use them, and
// named variants (prop presets) people and agents insert. Everything is read
// statically from the canvas's default export, so canvases stay import-free:
//
//   export default {
//     name: "Buttons",
//     library: "Design System",
//     assets: {
//       Button: {
//         usage: "Primary actions: form submits and calls to action. Not for navigation (use Link).",
//         variants: { Primary: { props: { variant: "primary" }, children: "Buy now" } },
//       },
//     },
//   };

export type PropLiteral = string | number | boolean | null | PropLiteral[] | { [key: string]: PropLiteral };

export interface AssetVariant {
  name: string;
  props: Record<string, PropLiteral>;
  /** Plain text placed between the tags. */
  children: string | null;
}

export interface Asset {
  /** The component's name as the canvas imports it. */
  name: string;
  /** Its source file, relative to the project root. */
  file: string;
  imported: string | "default";
  libraries: string[];
  usage: string | null;
  variants: AssetVariant[];
  /** The canvas that declares it. */
  canvasPath: string;
  warnings: string[];
}

export interface AssetLibraries {
  assets: Asset[];
  /** Library name to asset names, sorted. Assets in no library are listed under "No library". */
  libraries: Record<string, string[]>;
  /** Canvas path to declaration problems (duplicates, unknown components). */
  errors: Record<string, string[]>;
}

const keyName = (k: Node): string | null => (k.type === "Identifier" ? k.name : k.type === "StringLiteral" ? k.value : null);

/** A JSON-like literal from source, or undefined when it is anything else (a call, an identifier). */
function evaluate(node: Node | null | undefined): PropLiteral | undefined {
  if (!node) return undefined;
  switch (node.type) {
    case "StringLiteral":
      return node.value;
    case "NumericLiteral":
      return node.value;
    case "BooleanLiteral":
      return node.value;
    case "NullLiteral":
      return null;
    case "TemplateLiteral":
      return node.expressions.length === 0 ? node.quasis.map((q) => q.value.cooked ?? "").join("") : undefined;
    case "UnaryExpression":
      return node.operator === "-" && node.argument.type === "NumericLiteral" ? -node.argument.value : undefined;
    case "ArrayExpression": {
      const out: PropLiteral[] = [];
      for (const el of node.elements) {
        const v = evaluate(el as Node | null);
        if (v === undefined) return undefined;
        out.push(v);
      }
      return out;
    }
    case "ObjectExpression": {
      const out: Record<string, PropLiteral> = {};
      for (const p of node.properties) {
        if (p.type !== "ObjectProperty" || p.computed) return undefined;
        const k = keyName(p.key);
        const v = evaluate(p.value as Node);
        if (k === null || v === undefined) return undefined;
        out[k] = v;
      }
      return out;
    }
    case "TSAsExpression":
    case "TSSatisfiesExpression":
      return evaluate(node.expression);
    default:
      return undefined;
  }
}

const field = (obj: ObjectExpression, key: string): Node | null => {
  for (const p of obj.properties) if (p.type === "ObjectProperty" && !p.computed && keyName(p.key) === key) return p.value as Node;
  return null;
};

const strings = (v: PropLiteral | undefined): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The asset declarations in one canvas file, with problems found along the way. */
export function parseAssets(root: string, canvasPath: string, source: string): { assets: Asset[]; errors: string[] } {
  const errors: string[] = [];
  let ast;
  try {
    ast = parseSource(source);
  } catch {
    return { assets: [], errors: [] };
  }
  const imports = new Map<string, { file: string; imported: string | "default" }>();
  const dir = dirname(join(root, canvasPath));
  for (const s of ast.program.body.filter((x): x is ImportDeclaration => x.type === "ImportDeclaration")) {
    const file = s.source.value.startsWith(".") ? resolveImport(dir, s.source.value) : null;
    for (const sp of s.specifiers) {
      if (!file) continue;
      const rel = relative(root, file).split("\\").join("/");
      if (sp.type === "ImportDefaultSpecifier") imports.set(sp.local.name, { file: rel, imported: "default" });
      if (sp.type === "ImportSpecifier") imports.set(sp.local.name, { file: rel, imported: sp.imported.type === "Identifier" ? sp.imported.name : sp.imported.value });
    }
  }
  const def = ast.program.body.find((s) => s.type === "ExportDefaultDeclaration");
  const config = def && def.type === "ExportDefaultDeclaration" ? objectOf(def.declaration as Expression) : null;
  if (!config) return { assets: [], errors };
  const canvasLibraries = [...strings(evaluate(field(config, "library"))), ...strings(evaluate(field(config, "libraries")))];
  const declared = field(config, "assets");
  if (!declared) return { assets: [], errors };
  if (declared.type !== "ObjectExpression") return { assets: [], errors: ["assets must be an object literal keyed by component name"] };
  const assets: Asset[] = [];
  for (const p of declared.properties) {
    if (p.type !== "ObjectProperty") continue;
    const name = keyName(p.key);
    if (!name) continue;
    const target = imports.get(name);
    if (!target) {
      errors.push(`${name}: not imported from a project file in this canvas`);
      continue;
    }
    const spec = objectOf(p.value as Expression);
    const warnings: string[] = [];
    const usageValue = spec ? evaluate(field(spec, "usage")) : undefined;
    const variants: AssetVariant[] = [];
    const rawVariants = spec ? field(spec, "variants") : null;
    if (rawVariants?.type === "ObjectExpression") {
      for (const v of rawVariants.properties) {
        if (v.type !== "ObjectProperty") continue;
        const vName = keyName(v.key);
        const vObj = objectOf(v.value as Expression);
        if (!vName || !vObj) continue;
        const props = evaluate(field(vObj, "props"));
        const children = evaluate(field(vObj, "children"));
        if (field(vObj, "props") && (props === undefined || typeof props !== "object" || Array.isArray(props) || props === null)) {
          warnings.push(`Variant ${vName}: props must be literal values`);
          continue;
        }
        variants.push({ name: vName, props: (props as Record<string, PropLiteral> | undefined) ?? {}, children: typeof children === "string" ? children : null });
      }
    }
    if (!usageValue) warnings.push("No usage note: say what it is for and when not to use it");
    const libraries = spec ? [...canvasLibraries, ...strings(evaluate(field(spec, "library"))), ...strings(evaluate(field(spec, "libraries")))] : canvasLibraries;
    assets.push({ name, ...target, libraries: [...new Set(libraries)], usage: typeof usageValue === "string" ? usageValue : null, variants, canvasPath, warnings });
  }
  return { assets, errors };
}

/** Every asset the workspace's canvases declare, grouped into libraries. One declaration per component. */
export function assetLibraries(root: string, canvasPaths: string[]): AssetLibraries {
  const out: AssetLibraries = { assets: [], libraries: {}, errors: {} };
  const seen = new Map<string, Asset>();
  for (const path of canvasPaths) {
    const full = join(root, path);
    if (!existsSync(full)) continue;
    const { assets, errors } = parseAssets(root, path, readFileSync(full, "utf8"));
    if (errors.length) out.errors[path] = errors;
    for (const a of assets) {
      const key = `${a.file}#${a.imported}`;
      const first = seen.get(key);
      if (first) {
        (out.errors[path] ??= []).push(`${a.name} is already declared in ${first.canvasPath}; keep one declaration per component`);
        continue;
      }
      seen.set(key, a);
      out.assets.push(a);
      for (const lib of a.libraries.length ? a.libraries : ["No library"]) (out.libraries[lib] ??= []).push(a.name);
    }
  }
  for (const list of Object.values(out.libraries)) list.sort();
  out.assets.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** JSX for a variant: <Button variant="primary">Buy now</Button>. */
export function variantJsx(local: string, variant: Pick<AssetVariant, "props" | "children"> | null): string {
  const attrs = Object.entries(variant?.props ?? {}).map(([k, v]) => (v === true ? k : typeof v === "string" && !/[{}"]/.test(v) ? `${k}=${JSON.stringify(v)}` : `${k}={${JSON.stringify(v)}}`));
  const open = [local, ...attrs].join(" ");
  const children = variant?.children;
  return children ? `<${open}>${children.replace(/[{}<>]/g, (c) => `{${JSON.stringify(c)}}`)}</${local}>` : `<${open} />`;
}
