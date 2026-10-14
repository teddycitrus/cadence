import { useState } from "react";
import type { GitOverview } from "../../api";
import { inputClass, timeAgo } from "../ui";
import { webUrl } from "../../../../git/web-url";

type Run = (action: string, body?: Record<string, unknown>) => Promise<boolean>;

function Fold({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="border-t border-zinc-900">
      <button className="w-full px-3 py-2 text-left text-[11px] font-medium tracking-wide text-zinc-500 uppercase hover:text-zinc-300" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} {title}
        {count !== undefined && <span className="ml-1 rounded bg-zinc-800 px-1 text-zinc-400">{count}</span>}
      </button>
      {open && <div className="space-y-1 px-3 pb-3 text-xs">{children}</div>}
    </section>
  );
}

/** Inline one-field form: type a value, press Enter. */
function Prompt({ placeholder, onSubmit }: { placeholder: string; onSubmit: (value: string) => Promise<boolean> }) {
  const [value, setValue] = useState("");
  return (
    <input
      className={`${inputClass} py-1! text-xs`}
      placeholder={placeholder}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={async (e) => {
        if (e.key === "Enter" && value.trim() && (await onSubmit(value.trim()))) setValue("");
      }}
    />
  );
}

/** Branches, history, stashes, tags, and remotes. */
export function GitExtras({ overview, run, busy }: { workspaceId: string; overview: GitOverview; run: Run; busy: boolean }) {
  const local = overview.branches.filter((b) => !b.remote);
  const remote = overview.branches.filter((b) => b.remote);
  return (
    <div>
      <Fold title="Branches" count={local.length}>
        {local.map((b) => (
          <div key={b.name} className="group flex items-center gap-2">
            <span className={`min-w-0 flex-1 truncate font-mono ${b.current ? "text-violet-300" : "text-zinc-300"}`}>
              {b.current ? "● " : ""}
              {b.name}
            </span>
            {!b.current && (
              <span className="hidden gap-2 group-hover:flex">
                <button className="text-zinc-400 hover:text-zinc-100" disabled={busy} onClick={() => void run("branches/switch", { name: b.name })}>
                  Switch
                </button>
                <button className="text-zinc-500 hover:text-red-400" onClick={() => confirm(`Delete branch ${b.name}?`) && void run("branches/delete", { name: b.name })}>
                  Delete
                </button>
              </span>
            )}
            {b.current && (
              <button
                className="hidden text-zinc-500 group-hover:inline hover:text-zinc-100"
                onClick={() => {
                  const to = prompt("Rename branch to", b.name);
                  if (to && to !== b.name) void run("branches/rename", { from: b.name, to });
                }}
              >
                Rename
              </button>
            )}
          </div>
        ))}
        <Prompt placeholder="New branch from here, then Enter" onSubmit={(name) => run("branches", { name })} />
        {remote.length > 0 && <p className="pt-1 text-[11px] text-zinc-600">Remote: {remote.map((b) => b.name).join(", ")}</p>}
      </Fold>
      <Fold title="History" count={overview.log.length}>
        {overview.log.map((c, i) => (
          <div key={c.sha} className="group flex items-baseline gap-2" title={`${c.sha}\n${c.author}`}>
            <span className="font-mono text-zinc-600">{c.shortSha}</span>
            <span className="min-w-0 flex-1 truncate text-zinc-300">{c.subject}</span>
            <span className="shrink-0 text-zinc-600">{timeAgo(c.date)}</span>
            {i === 0 && overview.log.length > 1 && (
              <button className="hidden text-zinc-500 group-hover:inline hover:text-amber-300" title="Undo this commit, keeping its changes staged" onClick={() => void run("undo-commit")}>
                Undo
              </button>
            )}
          </div>
        ))}
      </Fold>
      <Fold title="Stashes" count={overview.stashes.length}>
        {overview.stashes.map((s) => (
          <div key={s.index} className="group flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-zinc-300">{s.message}</span>
            <button className="text-zinc-400 hover:text-zinc-100" onClick={() => void run("stash/pop", { index: s.index })}>
              Pop
            </button>
            <button className="text-zinc-500 hover:text-red-400" onClick={() => confirm("Drop this stash?") && void run("stash/drop", { index: s.index })}>
              Drop
            </button>
          </div>
        ))}
        <Prompt placeholder="Stash all changes with a message, then Enter" onSubmit={(message) => run("stash", { message })} />
      </Fold>
      <Fold title="Tags" count={overview.tags.length}>
        {overview.tags.map((t) => (
          <div key={t} className="group flex items-center gap-2">
            <span className="flex-1 font-mono text-zinc-300">{t}</span>
            <button className="hidden text-zinc-500 group-hover:inline hover:text-red-400" onClick={() => void run("tags/delete", { name: t })}>
              Delete
            </button>
          </div>
        ))}
        <Prompt placeholder="Tag this commit, then Enter" onSubmit={(name) => run("tags", { name })} />
      </Fold>
      <Fold title="Remotes" count={overview.remotes.length}>
        {overview.remotes.map((r) => (
          <div key={r.name} className="group flex items-center gap-2">
            <span className="font-mono text-zinc-300">{r.name}</span>
            <span className="min-w-0 flex-1 truncate text-zinc-500">{r.url}</span>
            <button className="hidden text-zinc-500 group-hover:inline hover:text-zinc-100" onClick={() => void navigator.clipboard.writeText(r.url)}>
              Copy
            </button>
            {webUrl(r.url) && (
              <a className="hidden text-zinc-500 group-hover:inline hover:text-zinc-100" href={webUrl(r.url)!} target="_blank" rel="noreferrer" title="Open the remote in the browser">
                Open
              </a>
            )}
            <button
              className="hidden text-zinc-500 group-hover:inline hover:text-zinc-100"
              onClick={() => {
                const newName = prompt("Rename remote", r.name);
                if (newName && newName !== r.name) void run("remotes/rename", { name: r.name, newName });
              }}
            >
              Rename
            </button>
            <button
              className="hidden text-zinc-500 group-hover:inline hover:text-zinc-100"
              onClick={() => {
                const url = prompt(`New URL for ${r.name}`, r.url);
                if (url && url !== r.url) void run("remotes/set-url", { name: r.name, url });
              }}
            >
              Change URL
            </button>
            <button className="hidden text-zinc-500 group-hover:inline hover:text-red-400" onClick={() => confirm(`Remove remote ${r.name}?`) && void run("remotes/remove", { name: r.name })}>
              Remove
            </button>
          </div>
        ))}
        <Prompt
          placeholder={overview.remotes.length ? "name url, then Enter" : "origin https://github.com/you/repo.git"}
          onSubmit={(v) => {
            const [name, url] = v.split(/\s+/);
            return url ? run("remotes", { name, url }) : run("remotes", { name: "origin", url: name });
          }}
        />
        {!overview.remotes.some((r) => r.name === "origin") && (
          <button
            className="text-violet-300 hover:underline"
            onClick={() => {
              const spec = prompt("New GitHub repository (name, or owner/name for an organization)");
              if (!spec?.trim()) return;
              const [owner, name] = spec.includes("/") ? (spec.trim().split("/") as [string, string]) : [null, spec.trim()];
              const isPrivate = confirm("Make it private? (Cancel for public)");
              void run("remotes/github", { name, owner, private: isPrivate });
            }}
          >
            Create on GitHub and push
          </button>
        )}
      </Fold>
    </div>
  );
}
