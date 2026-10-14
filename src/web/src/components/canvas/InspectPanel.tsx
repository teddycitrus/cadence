import { useEffect, useState } from "react";
import type { CanvasEdit } from "../../../../core/types";
import type { DesignToken } from "../../api";
import { Button, ErrorText, inputClass, useAction } from "../ui";
import { FillEditor } from "./FillEditor";
import { BLEND_MODES, FILTER_PROPS } from "../../../../canvas/tailwind";
import { ElementActions } from "./ElementActions";

export interface SelectedElement {
  loc: string;
  tag: string;
  className: string;
  inlineStyle: string;
  text: string | null;
  count: number;
  styles: Record<string, string>;
  rect?: { x: number; y: number; width: number; height: number };
  ancestors?: { loc: string; tag: string; className: string }[];
}

export interface TreeNode {
  loc: string;
  tag: string;
  depth: number;
  label: string;
  locked?: boolean;
  /** The element's class attribute, for the Tailwind toggle. */
  classes?: string;
}

/** Layers whose styles cannot be edited here: from installed packages, or locked. */
const readOnlyLayer = (n: TreeNode) => Boolean(n.locked) || /(^|[\\/])node_modules[\\/]/.test(n.loc);

type Field = { prop: string; label: string; from: (s: Record<string, string>) => string; type?: "color" | "select"; options?: string[] };

const px = (v: string | undefined) => (v ?? "").replace(/px$/, "");
function hex(rgb: string | undefined): string {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(rgb ?? "");
  if (!m) return rgb ?? "";
  if (m[4] === "0") return "transparent";
  return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
}
const same4 = (s: Record<string, string>, base: string) => {
  const v = ["Top", "Right", "Bottom", "Left"].map((k) => s[`${base}${k}`]);
  return v.every((x) => x === v[0]) ? px(v[0]) : "";
};

/** One function's argument in a computed CSS filter ("brightness(1.2) blur(4px)"). */
const filterValue = (filter: string | undefined, fn: string) => new RegExp(String.raw`(?:^|\s)${fn}\(([^)]+)\)`).exec(filter ?? "")?.[1] ?? "";
const FILTER_FIELDS: Record<(typeof FILTER_PROPS)[number], string> = { blur: "blur", brightness: "brightness", contrast: "contrast", saturate: "saturate", grayscale: "grayscale", sepia: "sepia", invert: "invert", hueRotate: "hue-rotate" };

/**
 * Every filter value for one change: CSS filter is a single property, so
 * changing one function must carry the others along (or they would be lost).
 */
export function filterChange(filter: string | undefined, prop: string, value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, fn] of Object.entries(FILTER_FIELDS)) {
    const current = filterValue(filter, fn).replace(/deg$/, "");
    const v = p === prop ? value : current;
    if (v) out[p] = v;
  }
  if (!out[prop]) out[prop] = "";
  return out;
}

/** A computed value that means "not set", shown as empty. */
const none = (v: string | undefined, also = "") => (!v || v === "none" || v === "auto" || v === also ? "" : v);

const GROUPS: { title: string; fields: Field[]; svgOnly?: boolean }[] = [
  {
    title: "Layout",
    fields: [
      { prop: "display", label: "Display", from: (s) => s.display ?? "", type: "select", options: ["block", "flex", "grid", "inline-block", "inline", "none"] },
      { prop: "direction", label: "Direction", from: (s) => s.flexDirection ?? "", type: "select", options: ["row", "column", "row-reverse", "column-reverse"] },
      { prop: "align", label: "Align", from: (s) => s.alignItems ?? "", type: "select", options: ["start", "center", "end", "stretch", "baseline"] },
      { prop: "justify", label: "Justify", from: (s) => s.justifyContent ?? "", type: "select", options: ["start", "center", "end", "between", "around", "evenly"] },
      { prop: "gap", label: "Gap", from: (s) => px(s.gap === "normal" ? "" : s.gap) },
      { prop: "wrap", label: "Wrap", from: (s) => s.flexWrap ?? "", type: "select", options: ["nowrap", "wrap", "wrap-reverse"] },
      { prop: "gridColumns", label: "Columns", from: (s) => none(s.gridTemplateColumns) },
      { prop: "gridRows", label: "Rows", from: (s) => none(s.gridTemplateRows) },
      { prop: "overflow", label: "Overflow", from: (s) => s.overflow ?? "", type: "select", options: ["visible", "hidden", "auto", "scroll", "clip"] },
    ],
  },
  {
    title: "Position",
    fields: [
      { prop: "position", label: "Position", from: (s) => s.position ?? "", type: "select", options: ["static", "relative", "absolute", "fixed", "sticky"] },
      { prop: "top", label: "Top", from: (s) => px(none(s.top)) },
      { prop: "right", label: "Right", from: (s) => px(none(s.right)) },
      { prop: "bottom", label: "Bottom", from: (s) => px(none(s.bottom)) },
      { prop: "left", label: "Left", from: (s) => px(none(s.left)) },
      { prop: "zIndex", label: "Z index", from: (s) => none(s.zIndex) },
    ],
  },
  {
    title: "Spacing",
    fields: [
      { prop: "padding", label: "Padding", from: (s) => same4(s, "padding") },
      { prop: "paddingX", label: "Padding X", from: (s) => (s.paddingLeft === s.paddingRight ? px(s.paddingLeft) : "") },
      { prop: "paddingY", label: "Padding Y", from: (s) => (s.paddingTop === s.paddingBottom ? px(s.paddingTop) : "") },
      { prop: "margin", label: "Margin", from: (s) => same4(s, "margin") },
    ],
  },
  {
    title: "Size",
    fields: [
      { prop: "width", label: "Width", from: (s) => px(s.width) },
      { prop: "height", label: "Height", from: (s) => px(s.height) },
      { prop: "minWidth", label: "Min W", from: (s) => px(none(s.minWidth, "0px")) },
      { prop: "maxWidth", label: "Max W", from: (s) => px(none(s.maxWidth)) },
      { prop: "minHeight", label: "Min H", from: (s) => px(none(s.minHeight, "0px")) },
      { prop: "maxHeight", label: "Max H", from: (s) => px(none(s.maxHeight)) },
      { prop: "aspectRatio", label: "Aspect", from: (s) => none(s.aspectRatio) },
      { prop: "boxSizing", label: "Box", from: (s) => s.boxSizing ?? "", type: "select", options: ["border-box", "content-box"] },
    ],
  },
  {
    title: "Text",
    fields: [
      { prop: "fontSize", label: "Size", from: (s) => px(s.fontSize) },
      { prop: "fontWeight", label: "Weight", from: (s) => s.fontWeight ?? "", type: "select", options: ["300", "400", "500", "600", "700", "800"] },
      { prop: "color", label: "Color", from: (s) => hex(s.color), type: "color" },
      { prop: "textAlign", label: "Align", from: (s) => s.textAlign ?? "", type: "select", options: ["left", "center", "right", "justify"] },
      { prop: "fontFamily", label: "Font", from: (s) => s.fontFamily ?? "" },
      { prop: "lineHeight", label: "Line height", from: (s) => px(none(s.lineHeight, "normal")) },
      { prop: "letterSpacing", label: "Spacing", from: (s) => px(none(s.letterSpacing, "normal")) },
      { prop: "textTransform", label: "Case", from: (s) => s.textTransform ?? "", type: "select", options: ["none", "uppercase", "lowercase", "capitalize"] },
      { prop: "fontStyle", label: "Style", from: (s) => s.fontStyle ?? "", type: "select", options: ["normal", "italic"] },
      { prop: "textDecoration", label: "Decoration", from: (s) => s.textDecorationLine ?? "", type: "select", options: ["none", "underline", "line-through", "overline"] },
    ],
  },
  {
    title: "Fill and border",
    fields: [
      { prop: "background", label: "Fill", from: (s) => hex(s.backgroundColor), type: "color" },
      { prop: "radius", label: "Radius", from: (s) => px(s.borderRadius) },
      { prop: "borderWidth", label: "Border", from: (s) => px(s.borderWidth) },
      { prop: "borderColor", label: "Border color", from: (s) => hex(s.borderColor), type: "color" },
      { prop: "borderStyle", label: "Border style", from: (s) => s.borderStyle ?? "", type: "select", options: ["solid", "dashed", "dotted", "double", "none"] },
      { prop: "opacity", label: "Opacity", from: (s) => s.opacity ?? "" },
    ],
  },
  {
    title: "Outline",
    fields: [
      { prop: "outlineWidth", label: "Width", from: (s) => (s.outlineStyle === "none" ? "" : px(s.outlineWidth)) },
      { prop: "outlineColor", label: "Color", from: (s) => hex(s.outlineColor), type: "color" },
      { prop: "outlineStyle", label: "Style", from: (s) => s.outlineStyle ?? "", type: "select", options: ["none", "solid", "dashed", "dotted", "double"] },
      { prop: "outlineOffset", label: "Offset", from: (s) => px(s.outlineOffset) },
    ],
  },
  {
    title: "Effects",
    fields: [
      { prop: "boxShadow", label: "Shadow", from: (s) => none(s.boxShadow) },
      { prop: "textShadow", label: "Text shadow", from: (s) => none(s.textShadow) },
      { prop: "blur", label: "Blur", from: (s) => px(/blur\(([^)]+)\)/.exec(s.filter ?? "")?.[1] ?? "") },
      { prop: "backdropBlur", label: "Backdrop blur", from: (s) => px(/blur\(([^)]+)\)/.exec(s.backdropFilter ?? "")?.[1] ?? "") },
      { prop: "blendMode", label: "Blend", from: (s) => s.mixBlendMode ?? "", type: "select", options: BLEND_MODES },
      { prop: "brightness", label: "Brightness", from: (s) => filterValue(s.filter, "brightness") },
      { prop: "contrast", label: "Contrast", from: (s) => filterValue(s.filter, "contrast") },
      { prop: "saturate", label: "Saturation", from: (s) => filterValue(s.filter, "saturate") },
      { prop: "grayscale", label: "Grayscale", from: (s) => filterValue(s.filter, "grayscale") },
      { prop: "sepia", label: "Sepia", from: (s) => filterValue(s.filter, "sepia") },
      { prop: "invert", label: "Invert", from: (s) => filterValue(s.filter, "invert") },
      { prop: "hueRotate", label: "Hue", from: (s) => filterValue(s.filter, "hue-rotate").replace(/deg$/, "") },
    ],
  },
  {
    title: "Transform",
    fields: [
      { prop: "rotate", label: "Rotate", from: (s) => none(s.rotate).replace(/deg$/, "") },
      { prop: "scale", label: "Scale", from: (s) => (none(s.scale).includes(" ") ? "" : none(s.scale)) },
      { prop: "scaleX", label: "Flip X", from: (s) => (none(s.scale).split(" ")[0]?.startsWith("-") ? "-1" : "1"), type: "select", options: ["1", "-1"] },
      { prop: "scaleY", label: "Flip Y", from: (s) => (none(s.scale).split(" ")[1]?.startsWith("-") ? "-1" : "1"), type: "select", options: ["1", "-1"] },
      { prop: "translateX", label: "Move X", from: (s) => px(none(s.translate).split(" ")[0] ?? "") },
      { prop: "translateY", label: "Move Y", from: (s) => px(none(s.translate).split(" ")[1] ?? "") },
    ],
  },
  {
    title: "SVG",
    svgOnly: true,
    fields: [
      { prop: "fill", label: "Fill", from: (s) => hex(s.fill), type: "color" },
      { prop: "stroke", label: "Stroke", from: (s) => hex(none(s.stroke)), type: "color" },
      { prop: "strokeWidth", label: "Stroke width", from: (s) => px(s.strokeWidth) },
    ],
  },
];

/** Groups open by default; the rest open on click. */
const OPEN_BY_DEFAULT = new Set(["Layout", "Spacing", "Size", "Text", "Fill and border", "SVG"]);

const SVG_TAGS = new Set(["svg", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "g", "text"]);

function FieldInput({ field, value, onCommit }: { field: Field; value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = (next = v) => next !== value && onCommit(next);
  if (field.type === "select") {
    return (
      <select className={`${inputClass} py-1! text-xs`} value={field.options!.includes(v) ? v : ""} onChange={(e) => onCommit(e.target.value)}>
        <option value="">{v && !field.options!.includes(v) ? v : "-"}</option>
        {field.options!.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  }
  const pick = async () => {
    // Chrome's eyedropper samples any pixel on screen, canvas frames included.
    const Dropper = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
    if (!Dropper) return;
    try {
      const { sRGBHex } = await new Dropper().open();
      setV(sRGBHex);
      onCommit(sRGBHex);
    } catch {
      // cancelled
    }
  };
  return (
    <div className="flex gap-1">
      {field.type === "color" && /^#[0-9a-f]{6}$/i.test(v) && <input type="color" className="h-7 w-7 shrink-0 cursor-pointer rounded bg-transparent" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => commit()} />}
      {field.type === "color" && "EyeDropper" in window && (
        <button type="button" className="shrink-0 rounded px-1 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100" title="Pick a color from the screen" onClick={() => void pick()}>
          ◎
        </button>
      )}
      {(field.prop === "width" || field.prop === "height") && (
        <span className="flex shrink-0 gap-0.5">
          <button type="button" className="rounded px-1 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100" title="Hug contents (fit-content)" onClick={() => onCommit("fit-content")}>
            Hug
          </button>
          <button type="button" className="rounded px-1 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100" title="Fill the container (100%)" onClick={() => onCommit("100%")}>
            Fill
          </button>
        </span>
      )}
      <input
        className={`${inputClass} py-1! font-mono text-xs`}
        list={field.type === "color" ? "cadence-color-tokens" : SIZE_PROPS.has(field.prop) ? "cadence-size-tokens" : undefined}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
    </div>
  );
}

const SIZE_PROPS = new Set(["padding", "paddingX", "paddingY", "margin", "gap", "width", "height", "fontSize", "radius", "borderWidth"]);

/** Token suggestions for the style fields: var(--name) with its value. */
function TokenLists({ tokens }: { tokens: DesignToken[] }) {
  return (
    <>
      <datalist id="cadence-color-tokens">
        {tokens
          .filter((t) => t.kind === "color")
          .map((t) => (
            <option key={`${t.scope}${t.name}`} value={`var(${t.name})`}>
              {t.value}
            </option>
          ))}
      </datalist>
      <datalist id="cadence-size-tokens">
        {tokens
          .filter((t) => t.kind === "length")
          .map((t) => (
            <option key={`${t.scope}${t.name}`} value={`var(${t.name})`}>
              {t.value}
            </option>
          ))}
      </datalist>
    </>
  );
}

/** Layers, the style panel for the selected element, and the Agent queue. */
export function InspectPanel({
  workspaceId,
  element,
  tree,
  onPick,
  onHover,
  onEdit,
  ledger,
  onStage,
  onUnstage,
  onApplyLedger,
  onLock,
  onUpload,
  onListImages,
  tokens = [],
  root,
}: {
  workspaceId: string;
  element: SelectedElement | null;
  tree: TreeNode[];
  onPick: (loc: string) => void;
  onHover: (loc: string | null) => void;
  onEdit: (change: { styles?: Record<string, string>; text?: string; variant?: string }) => Promise<{ applied: boolean; via: string }>;
  ledger: CanvasEdit[];
  onStage: (description: string) => Promise<unknown>;
  onUnstage: (id: string) => void;
  onApplyLedger: () => Promise<unknown>;
  onLock: (loc: string, locked: boolean) => Promise<unknown>;
  onUpload: (file: File) => Promise<string>;
  onListImages?: () => Promise<{ url: string; path: string }[]>;
  tokens?: DesignToken[];
  /** The workspace folder, for opening source in an editor. */
  root?: string;
}) {
  const [tab, setTab] = useState<"design" | "layers">("design");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const isOpen = (title: string) => openGroups[title] ?? OPEN_BY_DEFAULT.has(title);
  const [note, setNote] = useState<string | null>(null);
  const [ask, setAsk] = useState("");
  const action = useAction();
  const [variant, setVariant] = useState("");
  const [showClasses, setShowClasses] = useState(false);
  const [layerClasses, setLayerClasses] = useState(false);
  const [hideReadOnly, setHideReadOnly] = useState(false);
  const edit = (change: { styles?: Record<string, string>; text?: string }) =>
    action.run(async () => {
      const r = await onEdit(change.styles && variant ? { ...change, variant } : change);
      setNote(r.applied ? `Written to source (${r.via === "tailwind" ? "Tailwind classes" : r.via === "style" ? "inline style" : "text"}).` : "Could not be written directly, so it was staged for AI below.");
    });

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-zinc-900 bg-zinc-950">
      <TokenLists tokens={tokens} />
      <div className="flex gap-1 border-b border-zinc-900 px-2 py-1.5">
        {(["design", "layers"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-md px-2 py-1 text-xs capitalize ${tab === t ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900"}`}>
            {t}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "layers" ? (
          <ul className="py-1 text-xs">
            <li className="flex items-center gap-3 border-b border-zinc-900 px-2 pb-1.5 text-[11px] text-zinc-500">
              <label className="flex items-center gap-1" title="Show each layer's class names (Tailwind)">
                <input type="checkbox" checked={layerClasses} onChange={(e) => setLayerClasses(e.target.checked)} /> Classes
              </label>
              <label className="flex items-center gap-1" title="Hide layers whose styles cannot be edited here (locked, or from installed packages)">
                <input type="checkbox" checked={hideReadOnly} onChange={(e) => setHideReadOnly(e.target.checked)} /> Hide read-only
              </label>
            </li>
            {tree.filter((n) => !hideReadOnly || !readOnlyLayer(n)).map((n, i) => (
              <li key={`${n.loc}-${i}`} className="group flex items-center hover:bg-zinc-900">
                <button
                  className={`flex min-w-0 flex-1 items-center gap-1 truncate py-0.5 pr-1 text-left ${element?.loc === n.loc ? "bg-violet-950/60 text-violet-200" : n.locked ? "text-zinc-500" : "text-zinc-300"}`}
                  style={{ paddingLeft: 8 + n.depth * 12 }}
                  disabled={n.locked}
                  title={n.locked ? "Locked: unlock it to select it" : undefined}
                  onClick={() => onPick(n.loc)}
                  onMouseEnter={() => onHover(n.loc)}
                  onMouseLeave={() => onHover(null)}
                >
                  <span className="font-mono text-zinc-500">{n.tag}</span>
                  {n.label && <span className="truncate">{n.label}</span>}
                  {layerClasses && n.classes && <span className="truncate font-mono text-[10px] text-sky-400/80">.{n.classes.split(/\s+/).join(" .")}</span>}
                </button>
                <button
                  className={`shrink-0 px-2 text-[10px] ${n.locked ? "text-amber-300" : "text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-zinc-200"}`}
                  onClick={() => void action.run(() => onLock(n.loc, !n.locked))}
                  title={n.locked ? "Unlock" : "Lock so it cannot be selected on the canvas"}
                >
                  {n.locked ? "Locked" : "Lock"}
                </button>
              </li>
            ))}
            {!tree.length && <li className="p-3 text-zinc-500">Pick the Select tool and click a frame to see its layers.</li>}
          </ul>
        ) : element ? (
          <div className="space-y-4 p-3 text-xs">
            <div>
              <p className="flex items-center font-mono text-zinc-200">
                &lt;{element.tag}&gt;
                <button className="ml-auto font-sans text-[11px] text-zinc-500 hover:text-zinc-100" onClick={() => void action.run(() => onLock(element.loc, true))} title="Lock so it cannot be selected on the canvas">
                  Lock
                </button>
              </p>
              <p className="truncate font-mono text-[11px] text-zinc-500" title={element.loc}>
                {element.loc}
              </p>
              {element.count > 1 && <p className="mt-1 text-amber-300">Rendered {element.count} times (likely a list). Edits apply to the source, so every copy changes.</p>}
              <ElementActions workspaceId={workspaceId} element={element} run={(fn) => action.run(fn)} />
              <div className="mt-2 flex items-center gap-2">
                <select className="rounded bg-zinc-900 px-1.5 py-0.5 text-[11px] text-zinc-300 ring-1 ring-zinc-800" value={variant} onChange={(e) => setVariant(e.target.value)} title="Edit the base styles, or one breakpoint or state">
                  <option value="">All sizes</option>
                  {["sm", "md", "lg", "xl", "2xl"].map((v) => (
                    <option key={v} value={v}>
                      {v} and up
                    </option>
                  ))}
                  {["hover", "focus", "active", "dark"].map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
                <button className="text-[11px] text-zinc-500 hover:text-zinc-200" onClick={() => setShowClasses(!showClasses)}>
                  {showClasses ? "Hide" : "Show"} classes
                </button>
                <a className="ml-auto text-[11px] text-zinc-500 hover:text-zinc-200" href={`vscode://file/${encodeURI(`${(root ?? "").replace(/\\/g, "/")}/${element.loc.replace(/:(\d+):(\d+)$/, (_m, l: string, c: string) => `:${l}:${Number(c) + 1}`)}`)}`} title="Open this element's source in VS Code">
                  Source
                </a>
              </div>
              {variant && <p className="mt-1 text-[11px] text-sky-300">Edits apply {["hover", "focus", "active", "dark"].includes(variant) ? `on ${variant}` : `from the ${variant} breakpoint up`} ({variant}: classes).</p>}
              {showClasses && <p className="mt-1 font-mono text-[11px] break-all text-zinc-400">{element.className || "(no classes)"}</p>}
            </div>
            {element.text !== null && (
              <div className="space-y-1">
                <p className="text-[11px] tracking-wide text-zinc-500 uppercase">Content</p>
                <FieldInput field={{ prop: "text", label: "Text", from: () => "" }} value={element.text} onCommit={(text) => void edit({ text })} />
              </div>
            )}
            {GROUPS.filter((g) => !g.svgOnly || SVG_TAGS.has(element.tag)).map((g) => (
              <div key={g.title} className="space-y-1.5">
                <button className="flex w-full items-center text-[11px] tracking-wide text-zinc-500 uppercase hover:text-zinc-300" onClick={() => setOpenGroups((o) => ({ ...o, [g.title]: !isOpen(g.title) }))}>
                  {g.title}
                  <span className="ml-auto">{isOpen(g.title) ? "-" : "+"}</span>
                </button>
                {isOpen(g.title) && (
                  <>
                    <div className="grid grid-cols-[5rem_1fr] items-center gap-x-2 gap-y-1">
                      {g.fields.map((f) => (
                        <div key={f.prop} className="contents">
                          <span className="text-zinc-400">{f.label}</span>
                          <FieldInput field={f} value={f.from(element.styles)} onCommit={(v) => void edit({ styles: f.prop in FILTER_FIELDS ? filterChange(element.styles.filter, f.prop, v) : { [f.prop]: v } })} />
                        </div>
                      ))}
                    </div>
                    {g.title === "Fill and border" && <FillEditor styles={element.styles} onCommit={(styles) => void edit({ styles })} onUpload={onUpload} onListImages={onListImages} />}
                  </>
                )}
              </div>
            ))}
            {note && <p className="text-zinc-400">{note}</p>}
            <ErrorText>{action.error}</ErrorText>
            <div className="space-y-1">
              <p className="text-[11px] tracking-wide text-zinc-500 uppercase">Ask an agent to change this</p>
              <textarea className={`${inputClass} min-h-14 text-xs`} placeholder="e.g. make this a two-column grid on wide screens" value={ask} onChange={(e) => setAsk(e.target.value)} />
              <Button
                className="py-1! text-xs"
                disabled={!ask.trim()}
                onClick={() =>
                  action.run(async () => {
                    await onStage(ask.trim());
                    setAsk("");
                  })
                }
              >
                Stage for AI
              </Button>
            </div>
          </div>
        ) : (
          <p className="p-3 text-xs text-zinc-500">Pick the Select tool (S) and click anything in a frame to edit it. Changes are written back to its source.</p>
        )}
      </div>
      <div className="space-y-2 border-t border-zinc-900 p-3 text-xs">
        <p className="flex items-center gap-2 text-[11px] tracking-wide text-zinc-500 uppercase">
          Agent queue <span className="rounded bg-zinc-800 px-1 text-zinc-300">{ledger.length}</span>
        </p>
        {ledger.map((e) => (
          <div key={e.id} className="group flex items-start gap-2">
            <p className="min-w-0 flex-1 text-zinc-300">
              {e.description}
              <span className="block truncate font-mono text-[10px] text-zinc-600">{e.loc}</span>
            </p>
            <button className="text-zinc-600 hover:text-red-400" onClick={() => onUnstage(e.id)} title="Remove">
              ×
            </button>
          </div>
        ))}
        {ledger.length > 0 ? (
          <Button variant="primary" className="w-full py-1! text-xs" onClick={() => void action.run(onApplyLedger)}>
            Apply {ledger.length} edit{ledger.length === 1 ? "" : "s"} with AI
          </Button>
        ) : (
          <p className="text-zinc-600">Edits that cannot be written directly (computed classes, runtime styles) collect here for an agent to apply in one commit.</p>
        )}
      </div>
    </aside>
  );
}
