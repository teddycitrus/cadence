import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import MagicString from "magic-string";
import type { ImportDeclaration } from "@babel/types";
import type { Frame } from "./parse";
import { resolveImport, storyComponents } from "./detach";
import { findElement } from "./edit";
import { parseSource } from "./parse";
import { variantJsx, type AssetVariant } from "./assets";
import { newElementJsx, type NewElement } from "./new-elements";
export { NEW_ELEMENTS, type NewElement } from "./new-elements";

// Arranging frames, and building with the project's own components.

/** A component the canvases render, offered for insertion anywhere on the canvas. */
export interface LibraryComponent {
  name: string;
  /** Its source file, relative to the project root. */
  file: string;
  imported: string | "default";
}

export interface TidyInput {
  id: string;
  frame: Frame;
  locked: boolean;
}

/**
 * Lays frames out in reading order, in rows that wrap at a width that
 * fits the widest one, with even gaps. Locked frames stay where they are.
 */
export function tidyFrames(stories: TidyInput[], gap = 80): Map<string, Frame> {
  const free = stories.filter((s) => !s.locked);
  const out = new Map<string, Frame>();
  if (!free.length) return out;
  const order = [...free].sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x);
  const startX = Math.min(...free.map((s) => s.frame.x));
  const startY = Math.min(...free.map((s) => s.frame.y));
  const maxWidth = Math.max(2400, ...free.map((s) => s.frame.width));
  let x = startX;
  let y = startY;
  let rowHeight = 0;
  for (const s of order) {
    if (x > startX && x + s.frame.width > startX + maxWidth) {
      x = startX;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    out.set(s.id, { ...s.frame, x, y });
    x += s.frame.width + gap;
    rowHeight = Math.max(rowHeight, s.frame.height);
  }
  return out;
}

/** Every project component the workspace's canvases render, once each. */
export function componentLibrary(root: string, canvases: { path: string; storyIds: string[] }[]): LibraryComponent[] {
  const seen = new Map<string, LibraryComponent>();
  for (const c of canvases) {
    const full = join(root, c.path);
    if (!existsSync(full)) continue;
    const source = readFileSync(full, "utf8");
    for (const id of c.storyIds) {
      for (const use of storyComponents(source, id)) {
        const file = resolveImport(dirname(full), use.source);
        if (!file) continue;
        const rel = relative(root, file).split("\\").join("/");
        const key = `${rel}#${use.imported}`;
        if (!seen.has(key)) seen.set(key, { name: use.imported === "default" ? use.name : use.imported, file: rel, imported: use.imported });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Adds `<Component />` as the last child of the element at line:column, and
 * imports it if the file does not already. Returns null when the element
 * cannot take children here (not found).
 */
export function insertComponent(source: string, line: number, column: number, fileDir: string, root: string, component: LibraryComponent, variant: Pick<AssetVariant, "props" | "children"> | null = null): string | null {
  const el = findElement(source, line, column);
  if (!el) return null;
  const ast = parseSource(source);
  let spec = relative(fileDir, join(root, component.file)).split("\\").join("/").replace(/\.[jt]sx?$/, "").replace(/\/index$/, "");
  if (!spec.startsWith(".")) spec = `./${spec}`;
  const imports = ast.program.body.filter((s): s is ImportDeclaration => s.type === "ImportDeclaration");
  // Reuse an existing import of the same component; otherwise pick a free local name.
  let local: string | null = null;
  for (const imp of imports) {
    if (imp.source.value.replace(/\.[jt]sx?$/, "") !== spec) continue;
    for (const s of imp.specifiers) {
      if (component.imported === "default" && s.type === "ImportDefaultSpecifier") local = s.local.name;
      if (component.imported !== "default" && s.type === "ImportSpecifier" && (s.imported.type === "Identifier" ? s.imported.name : s.imported.value) === component.imported) local = s.local.name;
    }
  }
  const taken = new Set(imports.flatMap((i) => i.specifiers.map((s) => s.local.name)));
  const s = new MagicString(source);
  if (!local) {
    local = component.name;
    for (let n = 2; taken.has(local); n++) local = `${component.name}${n}`;
    const statement = component.imported === "default" ? `import ${local} from ${JSON.stringify(spec)};` : local === component.imported ? `import { ${local} } from ${JSON.stringify(spec)};` : `import { ${component.imported} as ${local} } from ${JSON.stringify(spec)};`;
    const last = imports.at(-1);
    if (last) s.appendLeft(last.end!, `\n${statement}`);
    else s.prepend(`${statement}\n`);
  }
  appendChild(s, source, el, line, variantJsx(local, variant));
  return s.toString();
}

/** Puts `tag` as the element's last child, opening a self-closing element around it. */
function appendChild(s: MagicString, source: string, el: NonNullable<ReturnType<typeof findElement>>, line: number, tag: string): void {
  const indent = /^[ \t]*/.exec(source.split("\n")[line - 1] ?? "")?.[0] ?? "";
  if (el.openingElement.selfClosing) {
    // <div /> becomes <div>...</div> around the new child.
    const open = source.slice(el.openingElement.start!, el.openingElement.end!).replace(/\s*\/>$/, ">");
    const name = source.slice(el.openingElement.name.start!, el.openingElement.name.end!);
    s.overwrite(el.openingElement.start!, el.openingElement.end!, `${open}\n${indent}  ${tag}\n${indent}</${name}>`);
  } else {
    s.appendLeft(el.closingElement!.start!, `  ${tag}\n${indent}`);
  }
}

/** Adds a drawn element (a box, shape, or text) as the last child of the element at line:column. */
export function insertElement(source: string, line: number, column: number, kind: NewElement): string | null {
  const el = findElement(source, line, column);
  if (!el) return null;
  const s = new MagicString(source);
  appendChild(s, source, el, line, newElementJsx(kind));
  return s.toString();
}
