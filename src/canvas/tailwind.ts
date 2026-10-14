// Style panel properties as Tailwind classes. Values use arbitrary-value
// syntax (`p-[12px]`, `bg-[#1d4ed8]`) so what the panel shows is exactly what
// renders, and each property replaces only its own classes.

export type StyleProp =
  | "padding"
  | "paddingX"
  | "paddingY"
  | "margin"
  | "gap"
  | "width"
  | "height"
  | "background"
  | "color"
  | "fontSize"
  | "fontWeight"
  | "radius"
  | "opacity"
  | "direction"
  | "align"
  | "justify"
  | "display"
  | "textAlign"
  | "borderWidth"
  | "borderColor"
  /** A CSS image: linear-, radial-, or conic-gradient(...), url(...), or none. */
  | "backgroundImage"
  | "backgroundSize"
  | "backgroundPosition"
  | "backgroundRepeat"
  | "wrap"
  | "gridColumns"
  | "gridRows"
  | "overflow"
  | "position"
  | "top"
  | "right"
  | "bottom"
  | "left"
  | "zIndex"
  | "aspectRatio"
  | "minWidth"
  | "maxWidth"
  | "minHeight"
  | "maxHeight"
  | "lineHeight"
  | "letterSpacing"
  | "fontFamily"
  | "textTransform"
  | "fontStyle"
  | "textDecoration"
  | "borderStyle"
  | "outlineWidth"
  | "outlineColor"
  | "outlineStyle"
  | "outlineOffset"
  | "boxShadow"
  | "blur"
  | "backdropBlur"
  | "rotate"
  | "scale"
  | "translateX"
  | "translateY"
  | "fill"
  | "stroke"
  | "strokeWidth"
  | "textShadow"
  | "scaleX"
  | "scaleY"
  | "blendMode"
  | "brightness"
  | "contrast"
  | "saturate"
  | "grayscale"
  | "sepia"
  | "invert"
  | "hueRotate"
  | "boxSizing";

/** Props that together make up CSS `filter`; inline styles need all of them at once. */
export const FILTER_PROPS = ["blur", "brightness", "contrast", "saturate", "grayscale", "sepia", "invert", "hueRotate"] as const;
export const BLEND_MODES = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"];

export const STYLE_PROPS: StyleProp[] = ["padding", "paddingX", "paddingY", "margin", "gap", "width", "height", "background", "color", "fontSize", "fontWeight", "radius", "opacity", "direction", "align", "justify", "display", "textAlign", "borderWidth", "borderColor", "backgroundImage", "backgroundSize", "backgroundPosition", "backgroundRepeat", "wrap", "gridColumns", "gridRows", "overflow", "position", "top", "right", "bottom", "left", "zIndex", "aspectRatio", "minWidth", "maxWidth", "minHeight", "maxHeight", "lineHeight", "letterSpacing", "fontFamily", "textTransform", "fontStyle", "textDecoration", "borderStyle", "outlineWidth", "outlineColor", "outlineStyle", "outlineOffset", "boxShadow", "blur", "backdropBlur", "rotate", "scale", "translateX", "translateY", "fill", "stroke", "strokeWidth", "textShadow", "scaleX", "scaleY", "blendMode", "brightness", "contrast", "saturate", "grayscale", "sepia", "invert", "hueRotate", "boxSizing"];

const IMAGE = /^(?:(?:repeating-)?(?:linear|radial|conic)-gradient\(.*\)|url\(.*\)|none)$/s;

/** Whether a fill image is a value the panel can write: a gradient, an image URL, or none. */
export function validImage(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  // Keep url() to http(s), root-relative, or relative paths: never javascript: or data: blobs in source.
  for (const m of v.matchAll(/url\(\s*["']?([^"')]*)["']?\s*\)/g)) {
    const url = m[1]!.trim();
    // Any scheme other than http(s) (javascript:, data:, file:) is refused; paths are fine.
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:\/\//i.test(url)) return false;
  }
  return IMAGE.test(v) && !/[;{}<>]/.test(v);
}

const ANY = String.raw`(?:\[[^\]]+\]|[\w./-]+)`;

/** Which existing classes each property owns (so a new value replaces them). */
const OWNS: Record<StyleProp, RegExp> = {
  padding: new RegExp(`^p-${ANY}$`),
  paddingX: new RegExp(`^px-${ANY}$`),
  paddingY: new RegExp(`^py-${ANY}$`),
  margin: new RegExp(`^m-${ANY}$`),
  gap: new RegExp(`^gap-${ANY}$`),
  width: new RegExp(`^w-${ANY}$`),
  height: new RegExp(`^h-${ANY}$`),
  background: new RegExp(`^bg-(?:\\[(?:#|rgb|hsl|oklch|color:)[^\\]]*\\]|(?:white|black|transparent|current|inherit)|[a-z]+-\\d{2,3}(?:/\\d+)?)$`),
  color: new RegExp(`^text-(?:\\[(?:#|rgb|hsl|oklch|color:)[^\\]]*\\]|(?:white|black|transparent|current|inherit)|[a-z]+-\\d{2,3}(?:/\\d+)?)$`),
  fontSize: new RegExp(`^text-(?:\\[(?:\\d|length:)[^\\]]*\\]|xs|sm|base|lg|xl|[2-9]xl)$`),
  fontWeight: /^font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black|\[\d+\])$/,
  radius: new RegExp(`^rounded(?:-${ANY})?$`),
  opacity: new RegExp(`^opacity-${ANY}$`),
  direction: /^flex-(?:row|col|row-reverse|col-reverse)$/,
  align: /^items-(?:start|end|center|baseline|stretch)$/,
  justify: /^justify-(?:start|end|center|between|around|evenly)$/,
  display: /^(?:block|inline-block|inline|flex|inline-flex|grid|inline-grid|hidden)$/,
  textAlign: /^text-(?:left|center|right|justify|start|end)$/,
  borderWidth: new RegExp(`^border(?:-(?:\\d+|\\[\\d[^\\]]*\\]))?$`),
  borderColor: new RegExp(`^border-(?:\\[(?:#|rgb|hsl|oklch|color:)[^\\]]*\\]|[a-z]+-\\d{2,3}(?:/\\d+)?)$`),
  // Arbitrary images and Tailwind's own gradient utilities, with their color stops.
  backgroundImage: /^(?:bg-(?:\[(?:image:|url\(|(?:repeating-)?(?:linear|radial|conic)-gradient)[^\]]*\]|none|(?:linear|radial|conic)(?:-[\w[\]-]+)?|gradient-to-\w+)|(?:from|via|to)-.+)$/,
  backgroundSize: /^bg-(?:auto|cover|contain|\[length:[^\]]*\]|size-\[[^\]]*\])$/,
  backgroundPosition: /^bg-(?:center|top|bottom|left|right|left-top|left-bottom|right-top|right-bottom|top-left|top-right|bottom-left|bottom-right|\[position:[^\]]*\])$/,
  backgroundRepeat: /^bg-(?:repeat|no-repeat|repeat-x|repeat-y|repeat-round|repeat-space)$/,
  wrap: /^flex-(?:wrap|nowrap|wrap-reverse)$/,
  gridColumns: new RegExp(`^grid-cols-${ANY}$`),
  gridRows: new RegExp(`^grid-rows-${ANY}$`),
  overflow: /^overflow-(?:auto|hidden|clip|visible|scroll)$/,
  position: /^(?:static|relative|absolute|fixed|sticky)$/,
  top: new RegExp(`^-?top-${ANY}$`),
  right: new RegExp(`^-?right-${ANY}$`),
  bottom: new RegExp(`^-?bottom-${ANY}$`),
  left: new RegExp(`^-?left-${ANY}$`),
  zIndex: new RegExp(`^-?z-${ANY}$`),
  aspectRatio: new RegExp(`^aspect-${ANY}$`),
  minWidth: new RegExp(`^min-w-${ANY}$`),
  maxWidth: new RegExp(`^max-w-${ANY}$`),
  minHeight: new RegExp(`^min-h-${ANY}$`),
  maxHeight: new RegExp(`^max-h-${ANY}$`),
  lineHeight: new RegExp(`^leading-${ANY}$`),
  letterSpacing: new RegExp(`^-?tracking-${ANY}$`),
  fontFamily: /^(?:font-(?:sans|serif|mono)|\[font-family:[^\]]*\])$/,
  textTransform: /^(?:uppercase|lowercase|capitalize|normal-case)$/,
  fontStyle: /^(?:italic|not-italic)$/,
  textDecoration: /^(?:underline|overline|line-through|no-underline)$/,
  borderStyle: /^border-(?:solid|dashed|dotted|double|hidden|none)$/,
  outlineWidth: /^outline(?:-(?:\d+|\[\d[^\]]*\]))?$/,
  outlineColor: new RegExp(`^outline-(?:\\[(?:#|rgb|hsl|oklch|color:)[^\\]]*\\]|[a-z]+-\\d{2,3}(?:/\\d+)?)$`),
  outlineStyle: /^outline-(?:solid|dashed|dotted|double|none|hidden)$/,
  outlineOffset: new RegExp(`^-?outline-offset-${ANY}$`),
  boxShadow: /^shadow(?:-(?:2xs|xs|sm|md|lg|xl|2xl|inner|none|\[[^\]]*\]))?$/,
  blur: /^blur(?:-(?:none|xs|sm|md|lg|xl|2xl|3xl|\[[^\]]*\]))?$/,
  backdropBlur: /^backdrop-blur(?:-(?:none|xs|sm|md|lg|xl|2xl|3xl|\[[^\]]*\]))?$/,
  rotate: new RegExp(`^-?rotate-${ANY}$`),
  scale: new RegExp(`^-?scale-${ANY}$`),
  translateX: new RegExp(`^-?translate-x-${ANY}$`),
  translateY: new RegExp(`^-?translate-y-${ANY}$`),
  fill: /^fill-(?:none|current|\[(?:#|rgb|hsl|oklch|color:|url\()[^\]]*\]|[a-z]+-\d{2,3}(?:\/\d+)?)$/,
  stroke: /^stroke-(?:none|current|\[(?:#|rgb|hsl|oklch|color:)[^\]]*\]|[a-z]+-\d{2,3}(?:\/\d+)?)$/,
  strokeWidth: /^stroke-(?:\d+(?:\.\d+)?|\[(?:length:|number:)?[\d.][^\]]*\])$/,
  textShadow: /^(?:\[text-shadow:[^\]]*\]|text-shadow(?:-[\w[\]/.-]+)?)$/,
  blendMode: /^mix-blend-[a-z-]+$/,
  brightness: new RegExp(`^brightness-${ANY}$`),
  contrast: new RegExp(`^contrast-${ANY}$`),
  saturate: new RegExp(`^saturate-${ANY}$`),
  grayscale: new RegExp(`^grayscale(?:-${ANY})?$`),
  sepia: new RegExp(`^sepia(?:-${ANY})?$`),
  invert: new RegExp(`^invert(?:-${ANY})?$`),
  hueRotate: new RegExp(`^-?hue-rotate-${ANY}$`),
  boxSizing: /^box-(?:border|content)$/,
  scaleX: new RegExp(`^-?scale-x-${ANY}$`),
  scaleY: new RegExp(`^-?scale-y-${ANY}$`),
};

const WEIGHT: Record<string, string> = { "100": "thin", "200": "extralight", "300": "light", "400": "normal", "500": "medium", "600": "semibold", "700": "bold", "800": "extrabold", "900": "black" };

const colorValue = (v: string) => (v.startsWith("var(") ? `color:${v}` : v).replace(/\s+/g, "_");
const px = (v: string) => (/^-?\d+(\.\d+)?$/.test(v) ? `${v}px` : v);
const arb = (v: string) => `[${px(v).replace(/\s+/g, "_")}]`;

/** The class for one property, or null to just remove the property's classes. */
export function classFor(prop: StyleProp, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  switch (prop) {
    case "padding":
      return `p-${arb(v)}`;
    case "paddingX":
      return `px-${arb(v)}`;
    case "paddingY":
      return `py-${arb(v)}`;
    case "margin":
      return `m-${arb(v)}`;
    case "gap":
      return `gap-${arb(v)}`;
    case "width":
      return v === "full" || v === "auto" || v === "fit" ? `w-${v}` : `w-${arb(v)}`;
    case "height":
      return v === "full" || v === "auto" || v === "fit" ? `h-${v}` : `h-${arb(v)}`;
    // Tokens (var(--x)) get a color: type hint, so Tailwind does not read them as images or sizes.
    case "background":
      return `bg-[${colorValue(v)}]`;
    case "color":
      return `text-[${colorValue(v)}]`;
    case "fontSize":
      return `text-${arb(v)}`;
    case "fontWeight":
      return `font-${WEIGHT[v] ?? `[${v}]`}`;
    case "radius":
      return v === "full" ? "rounded-full" : `rounded-${arb(v)}`;
    case "opacity":
      return `opacity-${Math.round(Number(v) <= 1 ? Number(v) * 100 : Number(v))}`;
    case "direction":
      return `flex-${v === "column" ? "col" : v === "column-reverse" ? "col-reverse" : v}`;
    case "align":
      return `items-${v.replace("flex-", "")}`;
    case "justify":
      return `justify-${v.replace("flex-", "").replace("space-", "")}`;
    case "display":
      return v === "none" ? "hidden" : v;
    case "textAlign":
      return `text-${v}`;
    case "borderWidth":
      return v === "0" ? "border-0" : `border-${arb(v)}`;
    case "borderColor":
      return `border-[${colorValue(v)}]`;
    case "backgroundImage": {
      if (v === "none") return "bg-none";
      // In arbitrary values "_" means a space, so underscores inside URLs are percent-encoded.
      const safe = v.replace(/url\(([^)]*)\)/g, (_m, u: string) => `url(${u.replace(/_/g, "%5F")})`);
      return `bg-[${safe.replace(/\s*,\s*/g, ",").replace(/\s+/g, "_")}]`;
    }
    case "backgroundSize":
      return ["auto", "cover", "contain"].includes(v) ? `bg-${v}` : `bg-[length:${v.replace(/\s+/g, "_")}]`;
    case "backgroundPosition":
      return /^(center|top|bottom|left|right)$/.test(v) ? `bg-${v}` : `bg-[position:${v.replace(/\s+/g, "_")}]`;
    case "backgroundRepeat":
      return `bg-${v}`;
    case "wrap":
      return v === "wrap" || v === "nowrap" || v === "wrap-reverse" ? `flex-${v}` : null;
    // A plain number is that many equal tracks; anything else is a template.
    case "gridColumns":
      return /^\d+$/.test(v) ? `grid-cols-${v}` : `grid-cols-[${v.replace(/\s+/g, "_")}]`;
    case "gridRows":
      return /^\d+$/.test(v) ? `grid-rows-${v}` : `grid-rows-[${v.replace(/\s+/g, "_")}]`;
    case "overflow":
      return `overflow-${v}`;
    case "position":
      return v;
    case "top":
    case "right":
    case "bottom":
    case "left":
      return `${prop}-${arb(v)}`;
    case "zIndex":
      return `z-[${v}]`;
    case "aspectRatio":
      return v === "square" || v === "video" || v === "auto" ? `aspect-${v}` : `aspect-[${v.replace(/\s+/g, "")}]`;
    case "minWidth":
      return `min-w-${arb(v)}`;
    case "maxWidth":
      return `max-w-${arb(v)}`;
    case "minHeight":
      return `min-h-${arb(v)}`;
    case "maxHeight":
      return `max-h-${arb(v)}`;
    case "lineHeight":
      return `leading-[${v.replace(/\s+/g, "_")}]`;
    case "letterSpacing":
      return `tracking-${arb(v)}`;
    case "fontFamily":
      return ["sans", "serif", "mono"].includes(v) ? `font-${v}` : `[font-family:${v.replace(/\s*,\s*/g, ",").replace(/\s+/g, "_")}]`;
    case "textTransform":
      return v === "none" ? "normal-case" : v;
    case "fontStyle":
      return v === "italic" ? "italic" : "not-italic";
    case "textDecoration":
      return v === "none" ? "no-underline" : v;
    case "borderStyle":
      return `border-${v}`;
    case "outlineWidth":
      return v === "0" ? "outline-0" : `outline-${arb(v)}`;
    case "outlineColor":
      return `outline-[${colorValue(v)}]`;
    case "outlineStyle":
      return `outline-${v}`;
    case "outlineOffset":
      return `outline-offset-${arb(v)}`;
    case "boxShadow":
      return v === "none" ? "shadow-none" : `shadow-[${v.replace(/\s*,\s*/g, ",").replace(/\s+/g, "_")}]`;
    case "blur":
      return v === "0" || v === "none" ? "blur-none" : `blur-${arb(v)}`;
    case "backdropBlur":
      return v === "0" || v === "none" ? "backdrop-blur-none" : `backdrop-blur-${arb(v)}`;
    case "rotate":
      return `rotate-[${/^-?[\d.]+$/.test(v) ? `${v}deg` : v}]`;
    case "scale":
      return `scale-[${v}]`;
    case "translateX":
      return `translate-x-${arb(v)}`;
    case "translateY":
      return `translate-y-${arb(v)}`;
    case "fill":
      return v === "none" || v === "currentColor" ? `fill-${v === "none" ? "none" : "current"}` : `fill-[${colorValue(v)}]`;
    case "stroke":
      return v === "none" || v === "currentColor" ? `stroke-${v === "none" ? "none" : "current"}` : `stroke-[${colorValue(v)}]`;
    case "strokeWidth":
      return /^\d+$/.test(v) ? `stroke-${v}` : `stroke-[length:${px(v)}]`;
    case "textShadow":
      return v === "none" ? "[text-shadow:none]" : `[text-shadow:${v.replace(/\s*,\s*/g, ",").replace(/\s+/g, "_")}]`;
    // Flipping is a scale of -1 on one axis.
    case "scaleX":
      return `scale-x-[${v}]`;
    case "scaleY":
      return `scale-y-[${v}]`;
    case "blendMode":
      return BLEND_MODES.includes(v) ? `mix-blend-${v}` : null;
    // Filter amounts are plain numbers (1 = unchanged); hue rotation is in degrees.
    case "brightness":
    case "contrast":
    case "saturate":
    case "grayscale":
    case "sepia":
    case "invert":
      return /^[\d.]+$/.test(v) ? `${prop}-[${v}]` : null;
    case "hueRotate":
      return /^-?[\d.]+$/.test(v) ? `${v.startsWith("-") ? "-" : ""}hue-rotate-[${v.replace(/^-/, "")}deg]` : null;
    case "boxSizing":
      return v === "border-box" ? "box-border" : v === "content-box" ? "box-content" : null;
  }
}

export const STYLE_VARIANTS = ["sm", "md", "lg", "xl", "2xl", "hover", "focus", "active", "dark"] as const;
export type StyleVariant = (typeof STYLE_VARIANTS)[number];

/**
 * Applies a set of property changes to a class list. Without a variant only
 * base classes change; with one (md, hover, ...) only that variant's classes.
 */
export function applyStyles(classes: string[], changes: Partial<Record<StyleProp, string>>, variant?: StyleVariant): string[] {
  let out = [...classes];
  const prefix = variant ? `${variant}:` : "";
  for (const [prop, value] of Object.entries(changes) as [StyleProp, string][]) {
    const owns = OWNS[prop];
    out = out.filter((c) => !(prefix ? c.startsWith(prefix) && !c.slice(prefix.length).includes(":") && owns.test(c.slice(prefix.length)) : owns.test(c)));
    const next = classFor(prop, value);
    if (next) out.push(prefix + next);
    if (prop === "direction" && next && !out.some((c) => c === "flex" || c === "inline-flex" || c === `${prefix}flex`)) out.push(`${prefix}flex`);
  }
  return out;
}

/** The same changes as inline style properties, for projects without Tailwind. */
export function styleFor(changes: Partial<Record<StyleProp, string>>): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const [prop, raw] of Object.entries(changes) as [StyleProp, string][]) {
    const v = raw.trim() || null;
    const len = v === null ? null : px(v);
    switch (prop) {
      case "paddingX":
        out.paddingLeft = len;
        out.paddingRight = len;
        break;
      case "paddingY":
        out.paddingTop = len;
        out.paddingBottom = len;
        break;
      case "radius":
        out.borderRadius = v === "full" ? "9999px" : len;
        break;
      case "direction":
        out.display = v ? "flex" : null;
        out.flexDirection = v;
        break;
      case "align":
        out.alignItems = v;
        break;
      case "justify":
        out.justifyContent = v;
        break;
      case "opacity":
      case "fontWeight":
        out[prop] = v === null ? null : Number(v);
        break;
      case "background":
      case "color":
      case "display":
      case "textAlign":
      case "borderColor":
      case "backgroundImage":
      case "backgroundSize":
      case "backgroundPosition":
      case "backgroundRepeat":
      case "overflow":
      case "position":
      case "fontFamily":
      case "textTransform":
      case "fontStyle":
      case "textDecoration":
      case "borderStyle":
      case "outlineColor":
      case "outlineStyle":
      case "boxShadow":
      case "fill":
      case "stroke":
      case "textShadow":
        out[prop] = v;
        break;
      // CSS scale takes both axes at once.
      case "scaleX":
      case "scaleY": {
        const x = changes.scaleX?.trim() || "1";
        const y = changes.scaleY?.trim() || "1";
        out.scale = x === "1" && y === "1" ? null : `${x} ${y}`;
        break;
      }
      case "wrap":
        out.flexWrap = v;
        break;
      case "gridColumns":
        out.gridTemplateColumns = v && /^\d+$/.test(v) ? `repeat(${v}, minmax(0, 1fr))` : v;
        break;
      case "gridRows":
        out.gridTemplateRows = v && /^\d+$/.test(v) ? `repeat(${v}, minmax(0, 1fr))` : v;
        break;
      case "zIndex":
      case "scale":
        out[prop] = v === null ? null : Number(v);
        break;
      case "aspectRatio":
        out.aspectRatio = v === "square" ? "1 / 1" : v === "video" ? "16 / 9" : v;
        break;
      case "lineHeight":
        out.lineHeight = v;
        break;
      // CSS filter is one property: rebuild it from every filter value sent with this change.
      case "blur":
      case "brightness":
      case "contrast":
      case "saturate":
      case "grayscale":
      case "sepia":
      case "invert":
      case "hueRotate": {
        const parts = FILTER_PROPS.flatMap((f) => {
          const x = changes[f]?.trim();
          if (!x) return [];
          if (f === "blur") return x === "0" || x === "none" ? [] : [`blur(${px(x)})`];
          if (f === "hueRotate") return [`hue-rotate(${/^-?[\d.]+$/.test(x) ? `${x}deg` : x})`];
          return [`${f}(${x})`];
        });
        out.filter = parts.length ? parts.join(" ") : null;
        break;
      }
      case "blendMode":
        out.mixBlendMode = v;
        break;
      case "boxSizing":
        out.boxSizing = v;
        break;
      case "backdropBlur":
        out.backdropFilter = v === null ? null : `blur(${px(v)})`;
        break;
      case "rotate":
        out.rotate = v === null ? null : /^-?[\d.]+$/.test(v) ? `${v}deg` : v;
        break;
      // CSS translate takes both axes at once.
      case "translateX":
      case "translateY": {
        const x = changes.translateX?.trim() ? px(changes.translateX.trim()) : "0";
        const y = changes.translateY?.trim() ? px(changes.translateY.trim()) : "0";
        out.translate = x === "0" && y === "0" ? null : `${x} ${y}`;
        break;
      }
      default:
        out[prop] = len;
    }
  }
  return out;
}
