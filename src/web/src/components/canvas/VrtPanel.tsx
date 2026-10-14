import { useState } from "react";
import { api, type StoryboardInfo, type VrtResult } from "../../api";
import { Button, ErrorText, useAction } from "../ui";

const LABEL: Record<VrtResult["status"], string> = { pass: "Matches baseline", fail: "Changed", new: "No baseline yet", size_changed: "Size changed", disabled: "Visual checks off" };

/** Results of a visual check: baseline, current, and diff images, with accept. */
export function VrtPanel({
  workspaceId,
  path,
  stories,
  results,
  busy,
  onCheck,
  onAccept,
  onClose,
}: {
  workspaceId: string;
  path: string;
  stories: StoryboardInfo[];
  results: VrtResult[];
  busy: boolean;
  onCheck: () => void;
  onAccept: (storyId: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [open, setOpen] = useState<string | null>(results.find((r) => r.status === "fail")?.storyId ?? null);
  const [stamp, setStamp] = useState(Date.now());
  const [posted, setPosted] = useState<string | null>(null);
  const post = useAction();
  const img = (kind: string, story: string) => `/api/workspaces/${workspaceId}/canvas/vrt/image?kind=${kind}&path=${encodeURIComponent(path)}&story=${story}&t=${stamp}`;
  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-zinc-900 bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-900 px-3 py-2 text-sm">
        <span className="font-medium">Visual checks</span>
        <Button className="ml-auto py-1! text-xs" disabled={busy} onClick={onCheck}>
          {busy ? "Rendering..." : "Run again"}
        </Button>
        {results.some((r) => r.status === "fail" || r.status === "size_changed" || r.status === "new") && (
          <Button
            className="py-1! text-xs"
            disabled={post.busy}
            title="Make the current render the baseline for every frame that changed or has none"
            onClick={() =>
              confirm("Accept every changed frame as the new baseline?") &&
              void post.run(async () => {
                await api.acceptAllVisuals(workspaceId, path);
                setStamp(Date.now());
                onCheck();
              })
            }
          >
            Accept all
          </Button>
        )}
        <button className="text-zinc-500 hover:text-zinc-100" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="px-3 pt-2 text-[11px] text-zinc-500">Baselines live in .cadence/vrt in the repo, so accepting one is part of the change and is reviewed with it.</p>
      <div className="flex items-center gap-2 px-3 pt-2 text-xs">
        <Button
          className="py-1! text-xs"
          disabled={post.busy}
          title="Checks every canvas in this workspace and posts the result on its pull request, replacing the last report"
          onClick={() =>
            void post.run(async () => {
              const r = await api.postVisualsToPr(workspaceId);
              setPosted(r.url);
            })
          }
        >
          {post.busy ? "Checking all canvases..." : "Post to pull request"}
        </Button>
        {posted && (
          <a href={posted} target="_blank" rel="noreferrer" className="text-violet-300 hover:underline">
            View comment
          </a>
        )}
      </div>
      <ErrorText>{post.error}</ErrorText>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {stories.map((s) => {
          const r = results.find((x) => x.storyId === s.id);
          return (
            <div key={s.id} className="rounded-lg bg-zinc-900 p-2 text-xs ring-1 ring-zinc-800">
              <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(open === s.id ? null : s.id)}>
                <span className="flex-1 truncate text-zinc-200">{s.name}</span>
                {r ? <span className={r.status === "pass" ? "text-emerald-400" : r.status === "new" || r.status === "disabled" ? "text-zinc-400" : "text-red-400"}>{LABEL[r.status]}</span> : <span className="text-zinc-600">Not checked</span>}
              </button>
              {r && r.status === "fail" && <p className="mt-1 text-zinc-500">{r.diffPixels.toLocaleString()} pixels differ ({(r.diffRatio * 100).toFixed(2)}%)</p>}
              {open === s.id && r && r.status !== "disabled" && (
                <div className="mt-2 space-y-2">
                  {r.status !== "new" && (
                    <div className="grid grid-cols-2 gap-2">
                      <figure>
                        <figcaption className="mb-1 text-zinc-500">Baseline</figcaption>
                        <img className="w-full bg-white" src={img("baseline", s.id)} alt="" />
                      </figure>
                      <figure>
                        <figcaption className="mb-1 text-zinc-500">Now</figcaption>
                        <img className="w-full bg-white" src={img("current", s.id)} alt="" />
                      </figure>
                    </div>
                  )}
                  {r.status === "fail" && (
                    <figure>
                      <figcaption className="mb-1 text-zinc-500">Difference</figcaption>
                      <img className="w-full" src={img("diff", s.id)} alt="" />
                    </figure>
                  )}
                  {r.status === "new" && <img className="w-full bg-white" src={img("current", s.id)} alt="" />}
                  {r.status !== "pass" && (
                    <Button
                      className="py-1! text-xs"
                      onClick={async () => {
                        await onAccept(s.id);
                        setStamp(Date.now());
                      }}
                    >
                      {r.status === "new" ? "Save as baseline" : "Accept as new baseline"}
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
