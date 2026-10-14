import { useEffect, useRef, useState } from "react";
import type { CanvasEmbed } from "../../../../docs/canvas-embed";
import { api, type CanvasEntry, type CanvasInfo } from "../../api";

type OpenCanvas = CanvasEntry & { workspaceId: string };
let catalog: Promise<OpenCanvas[]> | null = null;
/** Every canvas in a live workspace (embeds need one to render), fetched once per page. */
const allCanvases = () =>
  (catalog ??= api
    .canvases()
    .then((list) => list.filter((e): e is OpenCanvas => e.workspaceId !== null))
    .catch((e) => ((catalog = null), Promise.reject(e))));

/** Picks a canvas (and optionally one frame) for an empty embed. */
function Picker({ onPick }: { onPick: (e: CanvasEmbed) => void }) {
  const [list, setList] = useState<OpenCanvas[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState("");
  useEffect(() => {
    allCanvases().then(setList, (e: Error) => setError(e.message));
  }, []);
  const canvas = list?.find((c) => `${c.workspaceId}|${c.path}` === choice);
  if (error) return <p className="text-xs text-red-400">{error}</p>;
  if (!list) return <p className="text-xs text-zinc-500">Loading canvases...</p>;
  if (!list.length) return <p className="text-xs text-zinc-500">No canvases yet. Create one under Canvases, or generate them from this doc.</p>;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <select className="rounded bg-zinc-800 px-2 py-1" value={choice} onChange={(e) => setChoice(e.target.value)}>
        <option value="">Choose a canvas...</option>
        {list.map((c) => (
          <option key={`${c.workspaceId}|${c.path}`} value={`${c.workspaceId}|${c.path}`}>
            {c.name} ({c.workspaceName})
          </option>
        ))}
      </select>
      {canvas && (
        <select className="rounded bg-zinc-800 px-2 py-1" defaultValue="" onChange={(e) => onPick({ workspaceId: canvas.workspaceId, path: canvas.path, story: e.target.value || null })}>
          <option value="" disabled>
            Frame...
          </option>
          <option value="">Whole canvas</option>
          {canvas.storyboards.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      {canvas && (
        <button className="rounded bg-zinc-700 px-2 py-1 hover:bg-zinc-600" onClick={() => onPick({ workspaceId: canvas.workspaceId, path: canvas.path, story: null })}>
          Embed whole canvas
        </button>
      )}
    </div>
  );
}

/** The frame at its real size, scaled to the doc's width. */
function LiveFrame({ src, title, width, height }: { src: string; title: string; width: number; height: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(el.clientWidth / width);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);
  return (
    <div ref={box} className="overflow-hidden rounded-lg bg-white ring-1 ring-zinc-800" style={{ height: height * scale }}>
      <iframe title={title} src={src} className="border-0" style={{ width, height, transform: `scale(${scale})`, transformOrigin: "top left" }} />
    </div>
  );
}

/**
 * A canvas or frame shown inside a doc. `static` (shared pages) shows
 * only what it is; signed-in views show a rendered preview that can go live.
 */
export function CanvasEmbedView({ embed, mode = "preview", onPick }: { embed: CanvasEmbed | null; mode?: "preview" | "static"; onPick?: (e: CanvasEmbed) => void }) {
  const [info, setInfo] = useState<CanvasInfo | null>(null);
  const [live, setLive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!embed || mode === "static") return;
    setInfo(null);
    setError(null);
    api.canvasFile(embed.workspaceId, embed.path).then(setInfo, (e: Error) => setError(e.message));
  }, [embed?.workspaceId, embed?.path, mode]);

  if (!embed) return onPick ? <Picker onPick={onPick} /> : <p className="text-xs text-zinc-500">Empty canvas embed.</p>;
  const story = embed.story ? info?.storyboards.find((s) => s.id === embed.story) : null;
  const title = `${info?.name ?? embed.path}${embed.story ? ` · ${story?.name ?? embed.story}` : ""}`;
  const href = `#/canvas/${encodeURIComponent(`${embed.workspaceId}|${embed.path}`)}`;
  if (mode === "static") {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-300">
        Canvas: <span className="font-mono text-xs">{embed.path}</span>
        {embed.story && <span className="text-zinc-500"> · {embed.story}</span>}
      </div>
    );
  }
  const base = `/api/workspaces/${encodeURIComponent(embed.workspaceId)}/canvas`;
  const image = embed.story ? `${base}/screenshot?path=${encodeURIComponent(embed.path)}&story=${encodeURIComponent(embed.story)}` : `${base}/thumbnail?path=${encodeURIComponent(embed.path)}`;
  const goLive = async () => {
    setError(null);
    try {
      if (!info) return;
      const s = story ?? info.storyboards[0];
      if (!s) return;
      const dev = await api.canvasDev(embed.workspaceId);
      if (s.kind === "route") {
        const app = info.appUrl || info.appCommand ? await api.canvasApp(embed.workspaceId, embed.path) : null;
        setLive(`${app?.proxyUrl ?? dev.url}${s.route!.startsWith("/") ? "" : "/"}${s.route}`);
      } else if (s.kind === "html") setLive(`${dev.url}/${s.html!.replace(/^\/+/, "")}`);
      else setLive(`${dev.url}/__cadence/story?canvas=${encodeURIComponent(embed.path)}&story=${encodeURIComponent(s.id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const frame = story?.frame ?? info?.storyboards[0]?.frame;
  return (
    <figure className="space-y-1">
      <div className="flex items-center gap-2 text-xs text-zinc-400">
        <span className="truncate font-medium text-zinc-200">{title}</span>
        <a href={href} className="ml-auto shrink-0 text-violet-300 hover:underline">
          Open canvas
        </a>
        {embed.story && info && (
          <button className="shrink-0 hover:text-zinc-100" onClick={() => (live ? setLive(null) : void goLive())}>
            {live ? "Show image" : "Go live"}
          </button>
        )}
      </div>
      {live && frame ? (
        <LiveFrame src={live} title={title} width={frame.width} height={frame.height} />
      ) : (
        <div className="relative min-h-24 overflow-hidden rounded-lg bg-zinc-900 ring-1 ring-zinc-800">
          {!loaded && !error && <p className="absolute inset-0 grid place-items-center text-xs text-zinc-500">Rendering...</p>}
          <img src={image} alt={title} className={`block w-full ${loaded ? "" : "opacity-0"}`} onLoad={() => setLoaded(true)} onError={() => setError("Could not render this canvas. Open it to see what is wrong.")} />
        </div>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </figure>
  );
}
