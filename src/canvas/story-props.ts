import type { Expression, JSXElement, Node, ObjectExpression } from "@babel/types";
import { objectOf, parseSource } from "./parse";
import { jsxStoryElement } from "./jsx-format";

export type PropValue = string | number | boolean;

export interface StoryProp {
  name: string;
  value: PropValue;
  /** A JSX attribute in `render`, or an entry of a Svelte frame's `props`. */
  where: "jsx" | "props";
  /** Source offsets of the value, for write-back. */
  start: number;
  end: number;
}

/** A literal the panel can edit: strings, numbers (also negative), and booleans. */
function literalOf(node: Node | null | undefined): PropValue | undefined {
  if (!node) return undefined;
  if (node.type === "StringLiteral" || node.type === "NumericLiteral" || node.type === "BooleanLiteral") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]!.value.cooked ?? undefined;
  if (node.type === "UnaryExpression" && node.operator === "-" && node.argument.type === "NumericLiteral") return -node.argument.value;
  return undefined;
}

/** The JSX a render function returns: `() => <X />`, `() => (<X />)`, or `() => { return <X />; }`. */
function renderedElement(fn: Node | null | undefined): JSXElement | null {
  if (!fn) return null;
  let body: Node | null = null;
  if (fn.type === "ArrowFunctionExpression" || fn.type === "FunctionExpression" || fn.type === "ObjectMethod") body = fn.body;
  if (body?.type === "BlockStatement") body = body.body.find((s) => s.type === "ReturnStatement")?.argument ?? null;
  while (body?.type === "ParenthesizedExpression") body = body.expression;
  return body?.type === "JSXElement" ? body : null;
}

function storyObject(source: string, storyId: string): ObjectExpression | null {
  for (const stmt of parseSource(source).program.body) {
    if (stmt.type !== "ExportNamedDeclaration" || stmt.declaration?.type !== "VariableDeclaration") continue;
    for (const d of stmt.declaration.declarations) if (d.id.type === "Identifier" && d.id.name === storyId) return objectOf(d.init);
  }
  return null;
}

/** The literal entries of a props object. */
function entriesOf(obj: ObjectExpression | null): StoryProp[] {
  const out: StoryProp[] = [];
  for (const q of obj?.properties ?? []) {
    if (q.type !== "ObjectProperty") continue;
    const name = q.key.type === "Identifier" ? q.key.name : q.key.type === "StringLiteral" ? q.key.value : null;
    const value = literalOf(q.value);
    if (name && value !== undefined) out.push({ name, value, where: "props", start: q.value.start!, end: q.value.end! });
  }
  return out;
}

/**
 * The literal props a frame passes: attributes on the element a
 * component frame renders, or a Svelte frame's `props` object.
 * Computed ones (variables, arrays, callbacks) are left to code.
 */
export function storyProps(source: string, storyId: string): StoryProp[] {
  // The component format: the frame's props={{ ... }} attribute.
  const el = jsxStoryElement(parseSource(source), storyId);
  if (el) {
    const attr = el.openingElement.attributes.find((a) => a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === "props");
    const value = attr?.type === "JSXAttribute" && attr.value?.type === "JSXExpressionContainer" ? objectOf(attr.value.expression as Expression) : null;
    return entriesOf(value);
  }
  const obj = storyObject(source, storyId);
  if (!obj) return [];
  const out: StoryProp[] = [];
  for (const p of obj.properties) {
    const key = p.type === "ObjectProperty" || p.type === "ObjectMethod" ? (p.key.type === "Identifier" ? p.key.name : p.key.type === "StringLiteral" ? p.key.value : null) : null;
    if (key === "props" && p.type === "ObjectProperty") out.push(...entriesOf(objectOf(p.value as Expression)));
    if (key === "render") {
      const el = renderedElement(p.type === "ObjectMethod" ? p : (p as { value: Node }).value);
      for (const a of el?.openingElement.attributes ?? []) {
        if (a.type !== "JSXAttribute" || a.name.type !== "JSXIdentifier") continue;
        const name = a.name.name;
        // A bare attribute (<X disabled />) is true.
        if (!a.value) out.push({ name, value: true, where: "jsx", start: a.name.end!, end: a.name.end! });
        else if (a.value.type === "StringLiteral") out.push({ name, value: a.value.value, where: "jsx", start: a.value.start!, end: a.value.end! });
        else if (a.value.type === "JSXExpressionContainer") {
          const value = literalOf(a.value.expression);
          if (value !== undefined) out.push({ name, value, where: "jsx", start: a.value.start!, end: a.value.end! });
        }
      }
    }
  }
  return out;
}

/** Writes one prop's new value, keeping its type; null when the prop is not a literal one. */
export function setStoryProp(source: string, storyId: string, name: string, value: PropValue): string | null {
  const p = storyProps(source, storyId).find((x) => x.name === name);
  if (!p || typeof value !== typeof p.value || (typeof value === "number" && !Number.isFinite(value))) return null;
  let text: string;
  if (p.where === "props") text = JSON.stringify(value);
  else if (typeof value === "string") text = /["\n{}<>&]/.test(value) ? `{${JSON.stringify(value)}}` : `"${value}"`;
  else text = `{${JSON.stringify(value)}}`;
  // A bare attribute gets its value spelled out.
  if (p.start === p.end) text = `=${text}`;
  return source.slice(0, p.start) + text + source.slice(p.end);
}
