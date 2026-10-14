import MagicString from "magic-string";
import type { JSXElement, Node } from "@babel/types";
import { parseSource } from "./parse";

// Element operations from the canvas: change stacking order (siblings that
// come later paint on top), duplicate, and delete. Each works on the JSX
// source of the element at line:column (0-based column), keeping the code
// around it as written.

export const ORDER_MOVES = ["forward", "backward", "front", "back"] as const;
export type OrderMove = (typeof ORDER_MOVES)[number];

interface Located {
  el: JSXElement;
  /** Element siblings in the parent's children, in order (text and expressions skipped). */
  siblings: JSXElement[];
  /** Whether it sits in another element's children (not a component's root). */
  inElement: boolean;
}

function locate(source: string, line: number, column: number): Located | null {
  let found: Located | null = null;
  const visit = (node: Node | null | undefined, parentChildren: Node[] | null): void => {
    if (!node || found || typeof node !== "object") return;
    if (node.type === "JSXElement" && node.openingElement.loc?.start.line === line && node.openingElement.loc.start.column === column) {
      found = { el: node, siblings: (parentChildren ?? [node]).filter((c): c is JSXElement => c.type === "JSXElement"), inElement: parentChildren !== null };
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "leadingComments" || key === "trailingComments") continue;
      const value = (node as unknown as Record<string, unknown>)[key];
      const children = (node.type === "JSXElement" || node.type === "JSXFragment") && key === "children" ? (value as Node[]) : null;
      if (Array.isArray(value)) for (const v of value) visit(v as Node, children);
      else if (value && typeof value === "object" && "type" in (value as object)) visit(value as Node, null);
    }
  };
  visit(parseSource(source).program, null);
  return found;
}

const text = (source: string, n: Node) => source.slice(n.start!, n.end!);

/** Moves an element among its siblings. Returns null when it cannot move that way (or was not found). */
export function reorderElement(source: string, line: number, column: number, move: OrderMove): string | null {
  const found = locate(source, line, column);
  if (!found || found.siblings.length < 2) return null;
  const { el, siblings } = found;
  const at = siblings.indexOf(el);
  const target = move === "forward" ? at + 1 : move === "backward" ? at - 1 : move === "front" ? siblings.length - 1 : 0;
  if (target < 0 || target >= siblings.length || target === at) return null;
  // Rotate the element texts across the sibling slots, so whitespace between them stays put.
  const order = siblings.map((s) => text(source, s));
  const [moved] = order.splice(at, 1);
  order.splice(target, 0, moved!);
  const s = new MagicString(source);
  siblings.forEach((sib, i) => {
    if (order[i] !== text(source, sib)) s.overwrite(sib.start!, sib.end!, order[i]!);
  });
  return s.toString();
}

/** Puts a copy of the element right after it, on its own line with the same indent. */
export function duplicateElement(source: string, line: number, column: number): string | null {
  const found = locate(source, line, column);
  if (!found) return null;
  const { el } = found;
  const lineStart = source.lastIndexOf("\n", el.start! - 1) + 1;
  const indent = /^[ \t]*/.exec(source.slice(lineStart))?.[0] ?? "";
  const onOwnLine = source.slice(lineStart, el.start!).trim() === "";
  const s = new MagicString(source);
  s.appendLeft(el.end!, onOwnLine ? `\n${indent}${text(source, el)}` : text(source, el));
  return s.toString();
}

/** Removes the element (and the line it stood on, when it had one to itself). Refuses a component's root. */
export function deleteElement(source: string, line: number, column: number): string | null {
  const found = locate(source, line, column);
  if (!found) return null;
  const { el } = found;
  // The root of a return or arrow body has no parent element: deleting it would break the component.
  if (!found.inElement) return null;
  const lineStart = source.lastIndexOf("\n", el.start! - 1) + 1;
  const lineEnd = source.indexOf("\n", el.end!);
  const before = source.slice(lineStart, el.start!);
  const after = source.slice(el.end!, lineEnd < 0 ? source.length : lineEnd);
  const s = new MagicString(source);
  if (!before.trim() && !after.trim()) s.remove(lineStart, lineEnd < 0 ? source.length : lineEnd + 1);
  else s.remove(el.start!, el.end!);
  return s.toString();
}
