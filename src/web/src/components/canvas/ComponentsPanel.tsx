import { useEffect, useState } from "react";
import { api, type AssetLibraries, type CanvasAsset, type LibraryComponent } from "../../api";
import { ErrorText, inputClass, useAction } from "../ui";

/**
 * The project's building blocks, inserted into the selected element: assets
 * the canvases declare (grouped by library, with usage notes and variants),
 * then every other component the canvases render.
 */
export function ComponentsPanel({ workspaceId, selectedLoc, onInserted, onClose }: { workspaceId: string; selectedLoc: string | null; onInserted: () => void; onClose: () => void }) {
  const [items, setItems] = useState<LibraryComponent[] | null>(null);
  const [assets, setAssets] = useState<AssetLibraries | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const action = useAction();
  useEffect(() => {
    api.componentLibrary(workspaceId).then(setItems, (e: Error) => action.setError(e.message));
    api.canvasAssets(workspaceId).then(setAssets, () => setAssets({ assets: [], libraries: {}, errors: {} }));
  }, [workspaceId]);
  const needle = query.toLowerCase();
  const declared = new Set((assets?.assets ?? []).map((a) => `${a.file}#${a.imported}`));
  const others = (items ?? []).filter((c) => !declared.has(`${c.file}#${c.imported}`) && (!needle || `${c.name} ${c.file}`.toLowerCase().includes(needle)));
  const byName = new Map((assets?.assets ?? []).map((a) => [a.name, a]));
  const insert = (a: Pick<CanvasAsset, "name" | "file" | "imported">, variant: CanvasAsset["variants"][number] | null) =>
    void action.run(async () => {
      await api.insertComponent(workspaceId, selectedLoc!, { name: a.name, file: a.file, imported: a.imported }, variant ? { props: variant.props, children: variant.children } : null);
      onInserted();
    });
  const problems = Object.entries(assets?.errors ?? {}).flatMap(([p, errs]) => errs.map((e) => `${p}: ${e}`));
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-zinc-900 bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-900 px-3 py-2">
        <p className="text-sm font-medium">Assets</p>
        <button className="ml-auto text-zinc-500 hover:text-zinc-100" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="space-y-2 p-3">
        <input className={`${inputClass} text-xs`} placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)} />
        <p className="text-[11px] text-zinc-500">{selectedLoc ? "Click one (or a variant) to add it inside the selected element." : "Select an element with the Select tool, then click an asset to add it inside."}</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {Object.entries(assets?.libraries ?? {}).map(([lib, names]) => {
          const shown = names.map((n) => byName.get(n)!).filter((a) => a && (!needle || `${a.name} ${a.usage ?? ""}`.toLowerCase().includes(needle)));
          if (!shown.length) return null;
          return (
            <section key={lib} className="mb-3">
              <p className="px-1 pb-1 text-[11px] font-medium tracking-wide text-zinc-400 uppercase">{lib}</p>
              {shown.map((a) => (
                <div key={a.name} className="rounded-md hover:bg-zinc-900/60">
                  <button disabled={!selectedLoc || action.busy} className="block w-full px-2 pt-1.5 text-left disabled:opacity-50" onClick={() => insert(a, null)}>
                    <p className="font-mono text-xs text-zinc-200">&lt;{a.name} /&gt;</p>
                  </button>
                  {a.usage && <p className="px-2 text-[11px] text-zinc-400">{a.usage}</p>}
                  <div className="flex flex-wrap gap-1 px-2 pt-1 pb-1.5">
                    {a.variants.map((v) => (
                      <button key={v.name} disabled={!selectedLoc || action.busy} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-700 disabled:opacity-50" title={JSON.stringify(v.props)} onClick={() => insert(a, v)}>
                        {v.name}
                      </button>
                    ))}
                    <button className="text-[10px] text-zinc-500 hover:text-zinc-300" onClick={() => setOpen(open === a.name ? null : a.name)}>
                      {open === a.name ? "less" : "details"}
                    </button>
                  </div>
                  {open === a.name && (
                    <div className="space-y-0.5 px-2 pb-2 font-mono text-[10px] text-zinc-500">
                      <p className="truncate">{a.file}</p>
                      <p className="truncate">declared in {a.canvasPath}</p>
                      {a.warnings.map((w) => (
                        <p key={w} className="text-amber-400">
                          {w}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </section>
          );
        })}
        {others.length > 0 && (
          <section>
            <p className="px-1 pb-1 text-[11px] font-medium tracking-wide text-zinc-400 uppercase">{assets?.assets.length ? "Other components" : "Components"}</p>
            {others.map((c) => (
              <button key={`${c.file}#${c.imported}`} disabled={!selectedLoc || action.busy} className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-zinc-900 disabled:opacity-50" onClick={() => insert(c, null)}>
                <p className="font-mono text-xs text-zinc-200">&lt;{c.name} /&gt;</p>
                <p className="truncate font-mono text-[11px] text-zinc-500">{c.file}</p>
              </button>
            ))}
          </section>
        )}
        {items?.length === 0 && !assets?.assets.length && (
          <p className="px-1 text-xs text-zinc-500">
            No components yet. Frames that render project components make them available here; declare them under <code>assets</code> in a canvas's default export to add usage notes, libraries, and variants.
          </p>
        )}
        {problems.map((p) => (
          <p key={p} className="px-1 text-[11px] text-amber-400">
            {p}
          </p>
        ))}
      </div>
      <ErrorText>{action.error}</ErrorText>
    </aside>
  );
}
