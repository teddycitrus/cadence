import { useEffect, useState } from "react";
import { inputClass } from "../ui";

type Kind = "solid" | "linear" | "radial" | "image";
interface Stop {
  color: string;
  at: number;
}

export interface Fill {
  kind: Kind;
  angle: number;
  stops: Stop[];
  url: string;
  size: string;
  position: string;
  repeat: string;
}

const SIDES: Record<string, number> = { "to top": 0, "to right": 90, "to bottom": 180, "to left": 270, "to top right": 45, "to right top": 45, "to bottom right": 135, "to right bottom": 135, "to bottom left": 225, "to left bottom": 225, "to top left": 315, "to left top": 315 };

// Computed background-position values for the keywords the panel offers.
const POSITIONS: Record<string, string> = { "50% 50%": "center", "50% 0%": "top", "50% 100%": "bottom", "0% 50%": "left", "100% 50%": "right" };

function toHex(color: string): string {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(color);
  if (!m) return color.trim();
  return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
}

/** Splits on commas that are not inside parentheses. */
function topLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The fill as the panel edits it, from computed styles. */
export function readFill(styles: Record<string, string>): Fill {
  const base: Fill = { kind: "solid", angle: 90, stops: [{ color: "#8b5cf6", at: 0 }, { color: "#0ea5e9", at: 100 }], url: "", size: styles.backgroundSize || "cover", position: POSITIONS[styles.backgroundPosition ?? ""] ?? "center", repeat: styles.backgroundRepeat || "no-repeat" };
  const image = styles.backgroundImage ?? "none";
  const url = /url\(["']?(.*?)["']?\)/.exec(image)?.[1];
  if (url) return { ...base, kind: "image", url: url.replace(/^https?:\/\/127\.0\.0\.1:\d+/, "") };
  const g = /^(linear|radial)-gradient\((.*)\)$/s.exec(image.trim());
  if (!g) return base;
  const parts = topLevel(g[2]!);
  let angle = 180;
  if (g[1] === "linear" && parts[0] && /deg$|^to /.test(parts[0])) {
    const first = parts.shift()!;
    angle = first.endsWith("deg") ? Number.parseFloat(first) : (SIDES[first] ?? 180);
  } else if (g[1] === "radial" && parts[0] && !/^(rgb|#|hsl)/.test(parts[0])) parts.shift();
  const stops = parts.map((p, i) => {
    const m = /^(.*?\))?\s*(#[0-9a-f]+|[a-z]+)?\s*([\d.]+)%?$/i.exec(p);
    const color = toHex(m?.[1] ?? m?.[2] ?? p.split(" ")[0]!);
    return { color, at: m?.[3] !== undefined ? Number(m[3]) : Math.round((i / Math.max(1, parts.length - 1)) * 100) };
  });
  return { ...base, kind: g[1] as Kind, angle, stops: stops.length >= 2 ? stops : base.stops };
}

/** The CSS background-image for a fill, or "none" for a solid one. */
export function fillImage(f: Fill): string {
  const stops = [...f.stops].sort((a, b) => a.at - b.at).map((s) => `${s.color} ${s.at}%`).join(", ");
  if (f.kind === "linear") return `linear-gradient(${f.angle}deg, ${stops})`;
  if (f.kind === "radial") return `radial-gradient(circle, ${stops})`;
  if (f.kind === "image") return f.url ? `url(${f.url})` : "none";
  return "none";
}

const small = `${inputClass} py-1! text-xs`;

/** Gradient and image fills; solid colors stay in the regular Fill field. */
export function FillEditor({ styles, onCommit, onUpload, onListImages }: { styles: Record<string, string>; onCommit: (styles: Record<string, string>) => void; onUpload: (file: File) => Promise<string>; onListImages?: () => Promise<{ url: string; path: string }[]> }) {
  const [images, setImages] = useState<{ url: string; path: string }[] | null>(null);
  const [fill, setFill] = useState(() => readFill(styles));
  const [uploading, setUploading] = useState(false);
  useEffect(() => setFill(readFill(styles)), [styles.backgroundImage, styles.backgroundSize, styles.backgroundPosition, styles.backgroundRepeat]);

  const commit = (next: Fill) => {
    setFill(next);
    if (next.kind === "solid") return onCommit({ backgroundImage: "" });
    if (next.kind === "image" && !next.url) return;
    onCommit({ backgroundImage: fillImage(next), ...(next.kind === "image" ? { backgroundSize: next.size, backgroundPosition: next.position, backgroundRepeat: next.repeat } : {}) });
  };
  const setStop = (i: number, patch: Partial<Stop>) => setFill((f) => ({ ...f, stops: f.stops.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-[5rem_1fr] items-center gap-x-2">
        <span className="text-zinc-400">Fill type</span>
        <select className={small} value={fill.kind} onChange={(e) => commit({ ...fill, kind: e.target.value as Kind })}>
          <option value="solid">Solid color</option>
          <option value="linear">Linear gradient</option>
          <option value="radial">Radial gradient</option>
          <option value="image">Image</option>
        </select>
      </div>
      {(fill.kind === "linear" || fill.kind === "radial") && (
        <div className="space-y-1 rounded-md bg-zinc-900 p-2">
          <div className="h-5 rounded" style={{ backgroundImage: fillImage(fill) }} />
          {fill.kind === "linear" && (
            <label className="flex items-center gap-2 text-zinc-400">
              Angle
              <input type="range" min={0} max={360} value={fill.angle} onChange={(e) => setFill({ ...fill, angle: Number(e.target.value) })} onPointerUp={() => commit(fill)} className="flex-1" />
              <span className="w-9 text-right font-mono">{fill.angle}°</span>
            </label>
          )}
          {fill.stops.map((s, i) => (
            <div key={i} className="grid grid-cols-[1.5rem_minmax(0,1fr)_3.25rem_1rem] items-center gap-1">
              <input type="color" className="h-6 w-6 cursor-pointer rounded bg-transparent" value={/^#[0-9a-f]{6}$/i.test(s.color) ? s.color : "#000000"} onChange={(e) => setStop(i, { color: e.target.value })} onBlur={() => commit(fill)} />
              <input className={`${small} font-mono`} value={s.color} onChange={(e) => setStop(i, { color: e.target.value })} onBlur={() => commit(fill)} aria-label="Stop color" />
              <input type="number" min={0} max={100} className={`${small} px-1!`} value={s.at} onChange={(e) => setStop(i, { at: Number(e.target.value) })} onBlur={() => commit(fill)} aria-label="Stop position (%)" />
              <button className="text-zinc-500 hover:text-red-400 disabled:opacity-30" disabled={fill.stops.length <= 2} onClick={() => commit({ ...fill, stops: fill.stops.filter((_, j) => j !== i) })} title="Remove stop">
                ×
              </button>
            </div>
          ))}
          <button className="text-violet-300 hover:underline" onClick={() => commit({ ...fill, stops: [...fill.stops, { color: fill.stops.at(-1)!.color, at: 100 }] })}>
            + Add stop
          </button>
        </div>
      )}
      {fill.kind === "image" && (
        <div className="space-y-1 rounded-md bg-zinc-900 p-2">
          <div className="flex gap-1">
            <input className={`${small} font-mono`} placeholder="/images/hero.jpg or https://..." value={fill.url} onChange={(e) => setFill({ ...fill, url: e.target.value })} onBlur={() => commit(fill)} />
            <label className="shrink-0 cursor-pointer rounded-md bg-zinc-800 px-2 py-1 text-zinc-200 hover:bg-zinc-700">
              {uploading ? "..." : "Upload"}
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setUploading(true);
                  try {
                    commit({ ...fill, url: await onUpload(file) });
                  } finally {
                    setUploading(false);
                  }
                }}
              />
            </label>
          </div>
          {onListImages && (
            <select
              className={small}
              value=""
              onFocus={() => images === null && void onListImages().then(setImages, () => setImages([]))}
              onChange={(e) => e.target.value && commit({ ...fill, url: e.target.value })}
              title="Images in the repo's public folder"
            >
              <option value="">{images?.length === 0 ? "No images in public/ or static/" : "Repo images..."}</option>
              {images?.map((i) => (
                <option key={i.path} value={i.url} title={i.path}>
                  {i.url}
                </option>
              ))}
            </select>
          )}
          <div className="grid grid-cols-3 gap-1">
            <select className={small} value={fill.size} onChange={(e) => commit({ ...fill, size: e.target.value })} title="Size">
              {["cover", "contain", "auto"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
            <select className={small} value={fill.position} onChange={(e) => commit({ ...fill, position: e.target.value })} title="Position">
              {["center", "top", "bottom", "left", "right"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
            <select className={small} value={fill.repeat} onChange={(e) => commit({ ...fill, repeat: e.target.value })} title="Repeat">
              {["no-repeat", "repeat", "repeat-x", "repeat-y"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}
