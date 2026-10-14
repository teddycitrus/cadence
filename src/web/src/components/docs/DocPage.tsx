import { useEffect, useRef, useState } from "react";
import type { Doc, Snapshot } from "../../../../core/types";
import { api, ApiError } from "../../api";
import { useLive } from "../../live";
import { actorName, Button, ErrorText, timeAgo } from "../ui";
import { DocChatPanel } from "./DocChatPanel";
import { HistoryPanel } from "./HistoryPanel";
import { Viewers } from "../Viewers";
import { ShareButton } from "../share/ShareButton";
import { headingSlug, RichEditor } from "./RichEditor";
import { FindBar } from "../chat/FindBar";
import { CollabProvider } from "./collab";
import { GenerateCanvases } from "./GenerateCanvases";
import { DOC_AI_EVENT } from "./doc-ai";
import { ExportMenu } from "./ExportMenu";
import { IssuePicker } from "../IssuePicker";

type SaveState = "saved" | "saving" | "unsaved" | "conflict";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}

export async function uploadImage(file: File): Promise<string> {
  const res = await api.uploadAsset({ name: file.name || "image.png", mediaType: file.type, data: await fileToBase64(file) });
  return res.url;
}

export { fileToBase64 };

export function DocPage({ docId, snapshot }: { docId: string; snapshot: Snapshot }) {
  const { data: doc, error } = useLive(() => api.doc(docId), [docId], (e) => e.aggregate === "doc" && e.aggregateId === docId);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [state, setState] = useState<SaveState>("saved");
  const [conflict, setConflict] = useState<Doc | null>(null);
  const [panel, setPanel] = useState<"chat" | "history" | null>(null);
  // "Keep writing" and "Ask the assistant" from the editor go to this doc's assistant.
  useEffect(() => {
    const on = (e: Event) => {
      const prompt = (e as CustomEvent<string>).detail;
      setPanel("chat");
      void api.docChat(docId).then((c) => api.sendMessage(c.id, { text: prompt, attachments: [], mentions: [], steer: false }));
    };
    window.addEventListener(DOC_AI_EVENT, on);
    return () => window.removeEventListener(DOC_AI_EVENT, on);
  }, [docId]);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The editor mounts only once the doc has loaded, so it never starts empty.
  const [loaded, setLoaded] = useState(false);
  const version = useRef(0);
  const dirty = useRef(false);
  const timer = useRef<number | null>(null);
  // Live co-editing: "pending" until the room answers, "solo" if it cannot be reached.
  const [mode, setMode] = useState<"pending" | "collab" | "solo">("pending");
  const [provider, setProvider] = useState<CollabProvider | null>(null);
  const [peers, setPeers] = useState(0);
  const lastSaved = useRef<string | null>(null);
  // Nothing from the room is saved until its content is really loaded: an editor
  // bound to a still-empty room reports an empty doc, and saving that would wipe it.
  const ready = useRef(false);
  const me = snapshot.members.find((m) => m.id === snapshot.viewer.memberId);

  useEffect(() => {
    if (!loaded || !doc) return;
    if (doc.kind === "pdf") return setMode("solo");
    const p = new CollabProvider(docId);
    p.awareness.setLocalStateField("user", { name: me?.name ?? "Someone", color: me?.color ?? "#8a5a7a" });
    setProvider(p);
    const off = p.on((c) => {
      // A seed always arrives before the sync reply, so a synced room without one already had content.
      if (c.type === "status" && p.synced && !p.gotSeed) ready.current = true;
      if (c.type === "role") {
        setMode("collab");
        // Taking over saving: save whatever differs from the stored doc.
        if (c.saver && lastSaved.current === null) lastSaved.current = doc.body;
      }
      setPeers(p.peers().length);
    });
    const onAwareness = () => setPeers(p.peers().length);
    p.awareness.on("change", onAwareness);
    const fallback = window.setTimeout(() => setMode((m) => (m === "pending" ? "solo" : m)), 4000);
    return () => {
      off();
      p.awareness.off("change", onAwareness);
      window.clearTimeout(fallback);
      p.destroy();
      setProvider(null);
    };
  }, [docId, loaded]);

  // The save waiting on the timer, so it can also run at once (when leaving or closing).
  const pendingSave = useRef<((closing: boolean) => void) | null>(null);
  const later = (fn: (closing: boolean) => void, ms: number) => {
    if (timer.current) window.clearTimeout(timer.current);
    pendingSave.current = fn;
    timer.current = window.setTimeout(() => runPending(false), ms);
  };
  const runPending = (closing: boolean) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    const fn = pendingSave.current;
    pendingSave.current = null;
    fn?.(closing);
  };

  /** In a room, only the saver writes the markdown, and only when it really changed. */
  const saveFromRoom = (md: string) => {
    if (!provider?.saver || !ready.current || md === lastSaved.current) return;
    if (timer.current) window.clearTimeout(timer.current);
    setState("unsaved");
    later(async (closing) => {
      setState("saving");
      try {
        const saved = await api.updateDoc(docId, { body: md, baseVersion: version.current, collab: true }, { keepalive: closing });
        version.current = saved.version;
        lastSaved.current = md;
        setState("saved");
      } catch (e) {
        // Changed outside the room: the server is sending that version in; it is saved after.
        if (!(e instanceof ApiError && e.status === 409)) setSaveError(e instanceof Error ? e.message : String(e));
        setState("saved");
      }
    }, 1200);
  };

  // Adopt server content on first load, and whenever it changes while we have nothing unsaved.
  useEffect(() => {
    if (!doc) return;
    if (mode === "collab") {
      // Others save the body; only keep the title and version in step.
      version.current = Math.max(version.current, doc.version);
      if (!dirty.current) setTitle(doc.title);
      return;
    }
    if (!dirty.current || version.current === 0) {
      setTitle(doc.title);
      setBody(doc.body);
      version.current = doc.version;
      setState("saved");
      setLoaded(true);
    } else if (doc.version !== version.current && doc.updatedBy !== "user") {
      setConflict(doc);
      setState("conflict");
    }
  }, [doc?.version, doc?.id, mode]);

  const save = async (next: { title: string; body: string }, force = false, closing = false) => {
    setState("saving");
    try {
      // In a room the body is saved by the room; a title change saves on its own.
      const saved =
        mode === "collab"
          ? await api.updateDoc(docId, { title: next.title.trim() || "Untitled" }, { keepalive: closing })
          : await api.updateDoc(docId, { title: next.title.trim() || "Untitled", body: next.body, baseVersion: force && conflict ? conflict.version : version.current }, { keepalive: closing });
      version.current = saved.version;
      dirty.current = false;
      setConflict(null);
      setSaveError(null);
      setState("saved");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.body.current) {
        setConflict(e.body.current as Doc);
        setState("conflict");
      } else {
        setSaveError(e instanceof Error ? e.message : String(e));
        setState("unsaved");
      }
    }
  };

  const schedule = (next: { title: string; body: string }) => {
    dirty.current = true;
    setState((s) => (s === "conflict" ? s : "unsaved"));
    later((closing) => {
      if (!conflict) void save(next, false, closing);
    }, 900);
  };

  // Leaving the doc or closing the tab saves what is pending right away instead of dropping it.
  useEffect(() => {
    const now = () => runPending(true);
    const hidden = () => document.visibilityState === "hidden" && runPending(true);
    window.addEventListener("pagehide", now);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", now);
      document.removeEventListener("visibilitychange", hidden);
      runPending(false);
    };
  }, []);

  const article = useRef<HTMLElement>(null);
  const [finding, setFinding] = useState(false);
  useEffect(() => {
    // Ctrl+F finds in the doc (a second press falls through to the browser's find).
    const onKey = (e: KeyboardEvent) => {
      // A chat panel beside the doc finds in itself when it has focus.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && !finding && !document.activeElement?.closest("[data-chat-view]")) {
        e.preventDefault();
        setFinding(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [finding]);
  useEffect(() => {
    // A link to a heading (?h=slug) scrolls to it once the content is in.
    const h = new URLSearchParams(location.hash.split("?")[1] ?? "").get("h");
    if (!h) return;
    const t = window.setTimeout(() => {
      const el = [...(article.current?.querySelectorAll("h1, h2, h3, h4") ?? [])].find((x) => headingSlug(x.textContent ?? "") === h);
      el?.scrollIntoView({ block: "start" });
    }, 300);
    return () => window.clearTimeout(t);
  }, [doc?.id, mode, loaded]);

  if (error) return <p className="p-8 text-sm text-red-400">{error}</p>;
  if (!doc || !loaded) return null;
  const issue = doc.issueId ? snapshot.issues.find((i) => i.id === doc.issueId) : null;

  return (
    <div className="flex h-full min-w-0 flex-1">
      <div className="min-w-0 flex-1 overflow-y-auto">
        {finding && (
          <div className="sticky top-0 z-20 bg-zinc-950">
            <FindBar scope={article} onClose={() => setFinding(false)} />
          </div>
        )}
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-zinc-900 bg-zinc-950/95 px-6 py-2 text-xs text-zinc-500 backdrop-blur">
          <span>
            {state === "saved" && `Saved · v${version.current} · ${actorName(doc.updatedBy, snapshot)} ${timeAgo(doc.updatedAt)}`}
            {state === "saving" && "Saving..."}
            {state === "unsaved" && "Unsaved changes"}
            {state === "conflict" && <span className="text-amber-300">Changed elsewhere</span>}
          </span>
          {mode === "collab" && <span className="text-emerald-400/80" title="Edits from everyone here appear live">● Live{peers > 0 ? ` with ${peers} other${peers === 1 ? "" : "s"}` : ""}</span>}
          <IssuePicker className="ml-2 w-56" issues={snapshot.issues} value={doc.issueId ?? null} none="No linked issue" onChange={(id) => api.updateDoc(doc.id, { issueId: id }).catch((err: Error) => setSaveError(err.message))} />
          {issue && (
            <a href={`#/issues/${issue.key}`} className="text-violet-300 hover:underline">
              Open {issue.key}
            </a>
          )}
          <div className="ml-auto flex items-center gap-1">
            <Viewers place={`doc:${doc.id}`} snapshot={snapshot} />
            <ShareButton kind="doc" refId={doc.id} />
            <GenerateCanvases doc={doc} snapshot={snapshot} />
            <ExportMenu docId={doc.id} title={doc.title} />
            <Button variant={panel === "history" ? "secondary" : "ghost"} onClick={() => setPanel(panel === "history" ? null : "history")}>
              History
            </Button>
            <Button variant={panel === "chat" ? "secondary" : "ghost"} onClick={() => setPanel(panel === "chat" ? null : "chat")}>
              Ask the assistant
            </Button>
          </div>
        </div>

        {conflict && (
          <div className="mx-6 mt-4 flex flex-wrap items-center gap-2 rounded-lg bg-amber-950/40 p-3 text-sm ring-1 ring-amber-900">
            <span>
              {conflict.updatedBy === "user" ? "This doc was changed in another tab or window" : `${actorName(conflict.updatedBy, snapshot)} changed this doc`} while you were editing (now v
              {conflict.version}).
            </span>
            <Button
              onClick={() => {
                dirty.current = false;
                version.current = conflict.version;
                setTitle(conflict.title);
                setBody(conflict.body);
                setConflict(null);
                setState("saved");
              }}
            >
              Load their version
            </Button>
            <Button variant="danger" onClick={() => save({ title, body }, true)}>
              Keep mine
            </Button>
          </div>
        )}
        <ErrorText>{saveError}</ErrorText>

        <article ref={article} className="mx-auto max-w-3xl px-8 pt-8 pb-32">
          <input
            className="font-display mb-4 w-full bg-transparent text-4xl leading-tight focus:outline-none"
            value={title}
            placeholder="Untitled"
            onChange={(e) => {
              setTitle(e.target.value);
              schedule({ title: e.target.value, body });
            }}
          />
          {doc.kind === "pdf" && doc.assetId ? (
            <iframe title={doc.title} src={`/api/assets/${doc.assetId}`} className="h-[80vh] w-full rounded-lg bg-white" />
          ) : mode === "pending" ? (
            <p className="text-sm text-zinc-500">Connecting...</p>
          ) : mode === "collab" && provider ? (
            <RichEditor
              key="collab"
              markdown={body}
              editable
              uploadImage={uploadImage}
              collab={{ provider, user: { name: me?.name ?? "Someone", color: me?.color ?? "#8a5a7a" } }}
              onLoaded={(md, v) => {
                // Anything scheduled before the content arrived is stale.
                if (timer.current) window.clearTimeout(timer.current);
                pendingSave.current = null;
                ready.current = true;
                lastSaved.current = md;
                version.current = Math.max(version.current, v);
              }}
              onChange={(md) => {
                setBody(md);
                saveFromRoom(md);
              }}
            />
          ) : (
            <RichEditor
              key="solo"
              markdown={body}
              editable={!conflict}
              uploadImage={uploadImage}
              onChange={(md) => {
                setBody(md);
                schedule({ title, body: md });
              }}
            />
          )}
        </article>
      </div>
      {panel === "history" && <HistoryPanel docId={doc.id} snapshot={snapshot} currentVersion={doc.version} onClose={() => setPanel(null)} />}
      {panel === "chat" && <DocChatPanel docId={doc.id} snapshot={snapshot} onClose={() => setPanel(null)} />}
    </div>
  );
}
