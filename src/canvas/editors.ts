import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ValidationError } from "../core/errors";
import { editClassName, editStyle, editText, LOCK_ATTR, setElementLocked, setNativeLocked } from "./edit";
import { editSvelteClass, editSvelteStyle, editSvelteText, setSvelteLocked, svelteCompiler } from "./svelte";

/** Element edits in one kind of source file. Each returns new source, or null when it cannot be done mechanically. */
export interface SourceEditor {
  className(source: string, line: number, column: number, update: (classes: string[]) => string[]): string | null;
  style(source: string, line: number, column: number, patch: Record<string, string | number | null>): string | null;
  text(source: string, line: number, column: number, text: string): string | null;
  lock(source: string, line: number, column: number, locked: boolean): string | null;
}

const jsx: SourceEditor = { className: editClassName, style: editStyle, text: editText, lock: setElementLocked };

/** React Native styles: lengths are plain numbers, and View/Text take a style like DOM tags do. */
export function nativeStyle(patch: Record<string, string | number | null>): Record<string, string | number | null> {
  return Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, typeof v === "string" && /^-?\d+(\.\d+)?px$/.test(v) ? Number.parseFloat(v) : v]));
}

/** CSS properties React Native spells differently (a transform array, no filters): left for an agent. */
const NOT_NATIVE = new Set(["rotate", "scale", "translate", "filter", "backdropFilter", "outlineStyle", "outlineOffset", "textDecoration", "gridTemplateColumns", "gridTemplateRows"]);

const native: SourceEditor = { ...jsx, style: (s, l, c, p) => (Object.keys(p).some((k) => NOT_NATIVE.has(k)) ? null : editStyle(s, l, c, nativeStyle(p), { anyElement: true })), lock: setNativeLocked };

export function usesReactNative(projectRoot: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    return Boolean(pkg.dependencies?.["react-native"]);
  } catch {
    return false;
  }
}

/** The editor for a file: JSX/TSX (React Native aware), or a .svelte component (with the project's Svelte compiler). */
export function editorFor(file: string, projectRoot: string): SourceEditor {
  if (!file.endsWith(".svelte")) return usesReactNative(projectRoot) ? native : jsx;
  const compiler = svelteCompiler(projectRoot);
  if (!compiler) throw new ValidationError("Install svelte in this project to edit .svelte files from the canvas");
  return {
    className: (s, l, c, u) => editSvelteClass(s, l, c, u, compiler),
    style: (s, l, c, p) => editSvelteStyle(s, l, c, p, compiler),
    text: (s, l, c, t) => editSvelteText(s, l, c, t, compiler),
    lock: (s, l, c, locked) => setSvelteLocked(s, l, c, locked, LOCK_ATTR, compiler),
  };
}
