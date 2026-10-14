import { useState } from "react";
import { GettingStarted } from "./GettingStarted";
import type { Effort, Snapshot } from "../../../../core/types";
import { EFFORTS } from "../../../../core/types";
import type { ProviderId } from "../../../../core/providers";
import { api, ApiError } from "../../api";
import { navigate } from "../../App";
import { Button, ErrorText, inputClass, modelsFor, ProviderSelect, timeAgo, useAction } from "../ui";
import { localDesktop as desktop } from "../../desktop";

type Kind = "mockup" | "prototype" | "blank";

const KINDS: { id: Kind; label: string; hint: string }[] = [
  { id: "mockup", label: "Static design", hint: "Static HTML screens laid out on a canvas" },
  { id: "prototype", label: "Working React app", hint: "A Vite + React + Tailwind app with a dev server" },
  { id: "blank", label: "Empty project", hint: "An empty repository and a chat" },
];

const small = "rounded-md bg-transparent px-1.5 py-1 text-xs text-zinc-400 hover:bg-zinc-800 focus:outline-none";

export function Generate({ snapshot, onDone }: { snapshot: Snapshot; onDone?: (r: { projectId: string; chatId: string }) => void }) {
  const [idea, setIdea] = useState("");
  const [kind, setKind] = useState<Kind>("prototype");
  const [provider, setProvider] = useState<ProviderId>(snapshot.settings.defaultProvider ?? "claude-code");
  const [model, setModel] = useState(snapshot.settings.defaultModel);
  const [effort, setEffort] = useState<Effort>(snapshot.settings.defaultEffort);
  const action = useAction();
  const go = () =>
    action.run(async () => {
      const r = await api.generateProject({ kind, idea, provider, model, effort });
      if (onDone) onDone(r);
      else navigate("chats", r.chatId);
    });
  return (
    <section className="space-y-3">
      <div className="rounded-xl bg-zinc-900 ring-1 ring-zinc-800 focus-within:ring-zinc-600">
        <textarea
          className="block min-h-28 w-full resize-none bg-transparent px-4 pt-4 pb-2 text-sm placeholder:text-zinc-500 focus:outline-none"
          placeholder={kind === "blank" ? "Optional: what the project is for" : "Describe what to make: a booking flow for a climbing gym, a dashboard for..."}
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void go()}
        />
        <div className="flex flex-wrap items-center gap-1 px-3 pb-3">
          <ProviderSelect
            className={small}
            snapshot={snapshot}
            value={provider}
            onChange={(p) => {
              setProvider(p);
              setModel(p === "claude-code" ? "claude-opus-5-5" : "default");
            }}
          />
          <select className={small} value={model} onChange={(e) => setModel(e.target.value)} title="Model">
            {modelsFor(snapshot, provider, model).map((m) => (
              <option key={m} value={m}>
                {m === "default" ? "Harness default" : m}
              </option>
            ))}
          </select>
          <select className={small} value={effort} onChange={(e) => setEffort(e.target.value as Effort)} title="Effort">
            {EFFORTS.map((e) => (
              <option key={e}>{e}</option>
            ))}
          </select>
          <Button className="ml-auto" variant="primary" disabled={action.busy || (kind !== "blank" && !idea.trim())} onClick={() => void go()}>
            {action.busy ? (kind === "prototype" ? "Setting up (installing packages)..." : "Setting up...") : "Generate"}
          </Button>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {KINDS.map((k) => (
          <button key={k.id} onClick={() => setKind(k.id)} className={`rounded-lg p-3 text-left ring-1 transition ${kind === k.id ? "bg-violet-950/40 ring-violet-600" : "bg-zinc-900 ring-zinc-800 hover:ring-zinc-600"}`}>
            <span className="block text-sm font-medium">{k.label}</span>
            <span className="block text-xs text-zinc-500">{k.hint}</span>
          </button>
        ))}
      </div>
      <ErrorText>{action.error}</ErrorText>
    </section>
  );
}

export function OpenFolder({ onDone }: { onDone?: () => void }) {
  const [path, setPath] = useState("");
  const [needsInit, setNeedsInit] = useState(false);
  const action = useAction();
  const [dropping, setDropping] = useState(false);
  const open = (initialize: boolean, chosen = path) =>
    action.run(async () => {
      try {
        await api.openFolder(chosen.trim(), initialize);
        setNeedsInit(false);
        if (onDone) onDone();
        else navigate("chats");
      } catch (e) {
        if (e instanceof ApiError && e.body.needsInit) setNeedsInit(true);
        else throw e;
      }
    });
  // In the desktop app: the system folder picker, and folders dropped from the file manager.
  const use = (chosen: string | null) => {
    if (!chosen) return;
    setPath(chosen);
    setNeedsInit(false);
    void open(false, chosen);
  };
  return (
    <div
      className={`space-y-2 rounded-xl bg-zinc-900 p-4 ring-1 ${dropping ? "ring-violet-500" : "ring-zinc-800"}`}
      onDragOver={(e) => {
        if (!desktop || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        setDropping(false);
        const file = e.dataTransfer.files[0];
        if (!desktop || !file) return;
        e.preventDefault();
        use(desktop.pathForFile(file));
      }}
    >
      <p className="font-display text-lg">Use a folder on this computer</p>
      <p className="text-xs text-zinc-500">A git repository on this machine (or an empty folder) becomes a project.{desktop ? " Drop a folder here, or browse for one." : ""}</p>
      <div className="flex gap-2">
        <input className={`${inputClass} font-mono text-xs`} placeholder="C:\code\my-app or /home/me/my-app" value={path} onChange={(e) => (setPath(e.target.value), setNeedsInit(false))} />
        {desktop && (
          <Button disabled={action.busy} onClick={() => void desktop!.pickFolder("Open a project folder").then(use)}>
            Browse...
          </Button>
        )}
        <Button disabled={!path.trim() || action.busy} onClick={() => void open(false)}>
          Open
        </Button>
      </div>
      {needsInit && (
        <div className="space-y-2 rounded-md bg-amber-950/40 p-2 text-xs ring-1 ring-amber-900">
          <p className="text-amber-200">That folder has files but no git repository. Cadence can start one there and commit everything in it (a .gitignore keeps node_modules and .env files out).</p>
          <Button className="py-1! text-xs" onClick={() => void open(true)}>
            Start a repository and open it
          </Button>
        </div>
      )}
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
}

/** A clone link (#/home?clone=<git url>) fills in the import box. */
function cloneParam(): string {
  try {
    return new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("clone") ?? "";
  } catch {
    return "";
  }
}

export function ImportRepo({ onDone }: { onDone?: () => void }) {
  const [url, setUrl] = useState(cloneParam);
  const [parent, setParent] = useState("");
  const action = useAction();
  return (
    <div className="space-y-2 rounded-xl bg-zinc-900 p-4 ring-1 ring-zinc-800">
      <p className="font-display text-lg">Clone a repository</p>
      <p className="text-xs text-zinc-500">Clone a repository with this machine's git credentials.</p>
      <div className="flex gap-2">
        <input className={`${inputClass} font-mono text-xs`} placeholder="https://github.com/owner/repo.git" value={url} onChange={(e) => setUrl(e.target.value)} />
        <Button
          disabled={!url.trim() || action.busy}
          onClick={() =>
            void action.run(async () => {
              await api.importProject(url.trim(), parent.trim() || undefined);
              if (onDone) onDone();
              else navigate("chats");
            })
          }
        >
          {action.busy ? "Cloning..." : "Import"}
        </Button>
      </div>
      <div className="flex gap-2">
        <input className={`${inputClass} font-mono text-xs`} placeholder="Into folder (optional), e.g. C:\code" value={parent} onChange={(e) => setParent(e.target.value)} />
        {desktop && <Button onClick={() => void desktop!.pickFolder("Clone into which folder?").then((p) => p && setParent(p))}>Browse...</Button>}
      </div>
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
}

/** Home: start something new, open or import a project, or pick up recent work. */
export function HomeView({ snapshot }: { snapshot: Snapshot }) {
  const recent = [...snapshot.workspaces].filter((w) => !w.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6);
  const canRun = snapshot.viewer.role !== "member";
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-10 px-8 py-14">
        <header className="space-y-2">
          <h1 className="text-4xl font-semibold tracking-tight">What are we making?</h1>
          <p className="text-zinc-400">Describe something new, or bring a project you already have. Agents work on their own branches and stop at your gates.</p>
        </header>
        <GettingStarted snapshot={snapshot} />
        {canRun ? (
          <>
            <Generate snapshot={snapshot} />
            <div className="grid gap-4 sm:grid-cols-2">
              <OpenFolder />
              <ImportRepo />
            </div>
          </>
        ) : (
          <p className="rounded-lg bg-zinc-900 p-4 text-sm text-zinc-400 ring-1 ring-zinc-800">Starting projects runs code on the host machine, so the owner and admins do it. You can work the board, docs, and canvases.</p>
        )}
        {recent.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-xs font-medium tracking-wide text-zinc-500 uppercase">Recent workspaces</h2>
            <ul className="divide-y divide-zinc-900 rounded-lg ring-1 ring-zinc-800">
              {recent.map((w) => (
                <li key={w.id}>
                  <a href={`#/chats/${w.id}`} className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-zinc-900">
                    <span className="min-w-0 flex-1 truncate">{w.name}</span>
                    <span className="truncate font-mono text-xs text-zinc-500">{snapshot.projects.find((p) => p.id === w.projectId)?.name ?? "scratch"}</span>
                    <span className="text-xs text-zinc-500">{timeAgo(w.updatedAt)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
