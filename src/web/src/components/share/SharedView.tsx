import { useEffect, useState } from "react";
import { Markdown } from "../Markdown";

type View =
  | { kind: "doc"; title: string; body: string; updatedAt: string }
  | { kind: "issue"; key: string; title: string; body: string; stage: string; priority: string; type: string; comments: { author: string; body: string; at: string }[]; links: { kind: string; title: string; ref: string }[] }
  | { kind: "canvas"; title: string; background: string; storyboards: { id: string; name: string; width: number; height: number }[] };

/** The public, read-only page behind a share link. */
export function SharedView({ id }: { id: string }) {
  const [view, setView] = useState<View | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    fetch(`/api/share/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? (r.json() as Promise<View>) : Promise.reject(new Error("missing"))))
      .then((v) => {
        setView(v);
        document.title = `${v.kind === "issue" ? `${v.key} ` : ""}${v.title} · Cadence`;
      }, () => setMissing(true));
  }, [id]);

  if (missing) {
    return (
      <div className="grid h-dvh place-items-center bg-zinc-950 p-6 text-center">
        <div className="space-y-2">
          <p className="font-display text-2xl">This link is not available</p>
          <p className="text-sm text-zinc-500">It may have been turned off by whoever shared it.</p>
        </div>
      </div>
    );
  }
  if (!view) return <div className="h-dvh bg-zinc-950" />;

  return (
    <div className="min-h-dvh overflow-y-auto bg-zinc-950">
      <header className="flex items-center gap-2 border-b border-zinc-900 px-6 py-3 text-sm text-zinc-500">
        <span className="grid size-6 place-items-center rounded bg-violet-500 text-zinc-950">
          <svg viewBox="0 0 32 32" className="size-4" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 20l5-8 4 6 5-8" />
          </svg>
        </span>
        Shared from Cadence · read only
      </header>
      {view.kind === "doc" && (
        <article className="mx-auto max-w-3xl px-8 py-10">
          <h1 className="mb-6 text-3xl font-semibold">{view.title}</h1>
          <Markdown embeds="static">{view.body}</Markdown>
          <p className="mt-10 text-xs text-zinc-600">Last updated {new Date(view.updatedAt).toLocaleString()}</p>
        </article>
      )}
      {view.kind === "issue" && (
        <article className="mx-auto max-w-3xl space-y-6 px-8 py-10">
          <div>
            <p className="font-mono text-sm text-zinc-500">{view.key}</p>
            <h1 className="mt-1 text-2xl font-semibold">{view.title}</h1>
            <p className="mt-2 flex gap-3 text-xs text-zinc-400">
              <span>{view.stage}</span>
              <span className="capitalize">{view.type}</span>
              <span className="capitalize">{view.priority} priority</span>
            </p>
          </div>
          {view.body ? <Markdown embeds="static">{view.body}</Markdown> : <p className="text-sm text-zinc-500">No description.</p>}
          {view.links.length > 0 && (
            <ul className="space-y-1 text-sm">
              {view.links.map((l) => (
                <li key={l.ref}>
                  <span className="mr-2 rounded bg-zinc-800 px-1.5 text-xs text-zinc-400">{l.kind}</span>
                  {/^https?:\/\//.test(l.ref) ? (
                    <a className="text-violet-300 hover:underline" href={l.ref} target="_blank" rel="noreferrer noopener">
                      {l.title}
                    </a>
                  ) : (
                    l.title
                  )}
                </li>
              ))}
            </ul>
          )}
          {view.comments.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-zinc-400">Comments</h2>
              {view.comments.map((c, i) => (
                <div key={i} className="rounded-lg bg-zinc-900 p-3 text-sm ring-1 ring-zinc-800">
                  <p className="mb-1 text-xs text-zinc-500">
                    {c.author} · {new Date(c.at).toLocaleString()}
                  </p>
                  <Markdown embeds="static">{c.body}</Markdown>
                </div>
              ))}
            </section>
          )}
        </article>
      )}
      {view.kind === "canvas" && (
        <div className="space-y-6 px-8 py-10" style={{ background: view.background }}>
          <h1 className="text-2xl font-semibold">{view.title}</h1>
          <div className="flex flex-wrap items-start gap-8">
            {view.storyboards.map((s) => (
              <figure key={s.id} className="space-y-2">
                <figcaption className="text-xs text-zinc-300">
                  {s.name} <span className="text-zinc-500">{s.width}×{s.height}</span>
                </figcaption>
                <img
                  src={`/api/share/${encodeURIComponent(id)}/story/${s.id}`}
                  alt={s.name}
                  loading="lazy"
                  className="max-w-full bg-white shadow-2xl"
                  style={{ width: Math.min(s.width, 1200), aspectRatio: `${s.width} / ${s.height}` }}
                />
              </figure>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
