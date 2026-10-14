import { useEffect, useRef, useState } from "react";
import { OPEN_COMMENT_EVENT } from "./ThreadList";
import { REACTIONS, type CanvasComment, type Reaction, type Snapshot } from "../../../../core/types";
import { api } from "../../api";
import { EMOJI } from "../issues/CommentCard";
import { actorName, Button, ErrorText, inputClass, timeAgo, useAction } from "../ui";

export type Attachment = { url: string; name: string };

/** Uploads pasted, dropped, or picked images as assets. */
async function upload(files: FileList | File[]): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const f of [...files].filter((x) => x.type.startsWith("image/")).slice(0, 10)) {
    const data = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
      r.onerror = () => reject(r.error ?? new Error("Could not read the image"));
      r.readAsDataURL(f);
    });
    const asset = await api.uploadAsset({ name: f.name || "image.png", mediaType: f.type, data });
    out.push({ url: asset.url, name: f.name || "image" });
  }
  return out;
}

/** A message box that also takes images (paste, drop, or the Attach button). */
function Composer({ placeholder, autoFocus, label, onSend }: { placeholder: string; autoFocus?: boolean; label: string; onSend: (body: string, attachments: Attachment[]) => Promise<unknown> }) {
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  const action = useAction();
  const add = (list: FileList | File[]) => void action.run(async () => setFiles([...files, ...(await upload(list))]));
  return (
    <div className="space-y-1.5" onDragOver={(e) => e.preventDefault()} onDrop={(e) => (e.preventDefault(), add(e.dataTransfer.files))}>
      <textarea autoFocus={autoFocus} className={`${inputClass} min-h-12 text-xs`} placeholder={placeholder} value={body} onChange={(e) => setBody(e.target.value)} onPaste={(e) => e.clipboardData.files.length && (e.preventDefault(), add(e.clipboardData.files))} />
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {files.map((f) => (
            <button key={f.url} title="Remove" onClick={() => setFiles(files.filter((x) => x.url !== f.url))}>
              <img src={f.url} alt={f.name} className="size-12 rounded object-cover ring-1 ring-zinc-700" />
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          className="py-1! text-xs"
          disabled={(!body.trim() && !files.length) || action.busy}
          onClick={() =>
            void action.run(async () => {
              await onSend(body.trim(), files);
              setBody("");
              setFiles([]);
            })
          }
        >
          {label}
        </Button>
        <button className="text-zinc-400 hover:text-zinc-100" onClick={() => picker.current?.click()} title="Attach images">
          Attach
        </button>
        <input ref={picker} type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && add(e.target.files)} />
      </div>
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
}

function Reactions({ comment, snapshot, onReact }: { comment: CanvasComment; snapshot: Snapshot; onReact: (r: Reaction, on: boolean) => void }) {
  const me = snapshot.viewer.memberId === "me" ? "user" : `member:${snapshot.viewer.memberId}`;
  const [picking, setPicking] = useState(false);
  const reactions = comment.reactions ?? {};
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {(Object.entries(reactions) as [Reaction, string[]][]).map(([r, who]) => (
        <button key={r} title={who.map((a) => actorName(a as CanvasComment["author"], snapshot)).join(", ")} onClick={() => onReact(r, !who.includes(me))} className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 ring-1 ${who.includes(me) ? "bg-violet-950/60 ring-violet-700" : "ring-zinc-800 hover:bg-zinc-800"}`}>
          {EMOJI[r]} <span className="text-zinc-300">{who.length}</span>
        </button>
      ))}
      <span className="relative">
        <button className="rounded-full px-1.5 py-0.5 text-zinc-500 ring-1 ring-zinc-800 hover:text-zinc-200" onClick={() => setPicking(!picking)} title="Add a reaction">
          +
        </button>
        {picking && (
          <span className="absolute top-6 left-0 z-10 flex gap-1 rounded-lg bg-zinc-900 p-1 shadow-xl ring-1 ring-zinc-700">
            {REACTIONS.map((r) => (
              <button key={r} className="rounded px-1 hover:bg-zinc-800" onClick={() => (setPicking(false), onReact(r, !(reactions[r] ?? []).includes(me as never)))}>
                {EMOJI[r]}
              </button>
            ))}
          </span>
        )}
      </span>
    </div>
  );
}

/** A new pin waiting for its first message. */
export interface DraftPin {
  x: number;
  y: number;
  storyId: string | null;
}

/** One message: its author can edit it; its author or an admin can delete it. */
function Message({ c, snapshot, onReact, onEdit, onDelete }: { c: CanvasComment; snapshot: Snapshot; onReact: (r: Reaction, on: boolean) => void; onEdit: (body: string) => Promise<unknown>; onDelete: () => void }) {
  const me = snapshot.viewer.memberId === "me" ? "user" : `member:${snapshot.viewer.memberId}`;
  const [editing, setEditing] = useState<string | null>(null);
  const mine = c.author === me;
  return (
    <div className="group">
      <p className="flex items-center gap-1 text-zinc-500">
        <span className="text-zinc-300">{actorName(c.author, snapshot)}</span> · {timeAgo(c.createdAt)}
        {c.editedAt && <span title={`Edited ${timeAgo(c.editedAt)}`}>(edited)</span>}
        <span className="ml-auto hidden gap-2 group-hover:flex">
          {mine && (
            <button className="hover:text-zinc-100" onClick={() => setEditing(c.body)}>
              Edit
            </button>
          )}
          {(mine || snapshot.viewer.role !== "member") && (
            <button className="hover:text-red-400" onClick={() => confirm(c.parentId ? "Delete this reply?" : "Delete this thread?") && onDelete()}>
              Delete
            </button>
          )}
        </span>
      </p>
      {editing !== null ? (
        <div className="space-y-1">
          <textarea autoFocus className={`${inputClass} min-h-12 text-xs`} value={editing} onChange={(e) => setEditing(e.target.value)} />
          <div className="flex gap-2">
            <Button variant="primary" className="py-0.5! text-xs" disabled={!editing.trim()} onClick={() => void onEdit(editing.trim()).then(() => setEditing(null))}>
              Save
            </Button>
            <Button variant="ghost" className="py-0.5! text-xs" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        c.body && <p className="whitespace-pre-wrap text-zinc-200">{c.body}</p>
      )}
      {c.attachments?.map((a) => (
        <a key={a.url} href={a.url} target="_blank" rel="noreferrer">
          <img src={a.url} alt={a.name} className="mt-1 max-h-40 rounded ring-1 ring-zinc-700" />
        </a>
      ))}
      <Reactions comment={c} snapshot={snapshot} onReact={onReact} />
    </div>
  );
}

function Thread({ root, replies, snapshot, zoom, onReply, onReact, onResolve, onDelete, onClose, onEdit, onDeleteOne, onUnread, link, moveTargets, onMoveTo }: {
  root: CanvasComment;
  replies: CanvasComment[];
  snapshot: Snapshot;
  zoom: number;
  onReply: (body: string, attachments: Attachment[]) => Promise<unknown>;
  onReact: (id: string, reaction: Reaction, on: boolean) => void;
  onResolve: (resolved: boolean) => void;
  onDelete: () => void;
  onClose: () => void;
  onEdit: (id: string, body: string) => Promise<unknown>;
  onDeleteOne: (id: string) => void;
  onUnread: () => void;
  link: string;
  /** Other workspaces whose branch has this canvas. */
  moveTargets: { id: string; label: string }[];
  onMoveTo: (workspaceId: string) => void;
}) {
  return (
    <div className="absolute top-0 left-8 z-30 w-72 space-y-2 rounded-lg bg-zinc-900 p-3 text-xs shadow-2xl ring-1 ring-zinc-700" style={{ transform: `scale(${1 / zoom})`, transformOrigin: "top left" }} onPointerDown={(e) => e.stopPropagation()}>
      {[root, ...replies].map((c) => (
        <Message key={c.id} c={c} snapshot={snapshot} onReact={(r, on) => onReact(c.id, r, on)} onEdit={(b) => onEdit(c.id, b)} onDelete={() => (c.id === root.id ? onDelete() : onDeleteOne(c.id))} />
      ))}
      <Composer placeholder="Reply" label="Reply" onSend={onReply} />
      <div className="flex items-center gap-2">
        <button className="text-zinc-400 hover:text-zinc-100" onClick={() => onResolve(!root.resolved)}>
          {root.resolved ? "Reopen" : "Resolve"}
        </button>
        <button className="text-zinc-500 hover:text-zinc-100" onClick={() => void navigator.clipboard.writeText(link)} title="Copy a link to this thread">
          Link
        </button>
        <button className="text-zinc-500 hover:text-zinc-100" onClick={onUnread} title="Mark as unread">
          Unread
        </button>
        {moveTargets.length > 0 && (
          <select className="max-w-28 rounded bg-zinc-800 px-1 py-0.5 text-zinc-300" value="" onChange={(e) => e.target.value && onMoveTo(e.target.value)} title="Move this thread to another branch's copy of the canvas">
            <option value="">Move to...</option>
            {moveTargets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        )}
        <button className="ml-auto text-zinc-500 hover:text-zinc-100" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/** Comment pins on the board, with their threads. */
export function CommentsLayer({
  comments,
  draft,
  snapshot,
  zoom,
  showResolved,
  onCreate,
  onCancelDraft,
  onReply,
  onReact,
  onResolve,
  onDelete,
  onEdit,
  onMove,
  onRead,
  onUnread,
  linkFor,
  initialOpen,
  moveTargets,
}: {
  comments: CanvasComment[];
  draft: DraftPin | null;
  snapshot: Snapshot;
  zoom: number;
  showResolved: boolean;
  onCreate: (body: string, attachments: Attachment[]) => Promise<unknown>;
  onCancelDraft: () => void;
  onReply: (root: CanvasComment, body: string, attachments: Attachment[]) => Promise<unknown>;
  onReact: (id: string, reaction: Reaction, on: boolean) => void;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, body: string) => Promise<unknown>;
  onMove: (id: string, to: { x?: number; y?: number; workspaceId?: string }) => void;
  onRead: (id: string) => void;
  onUnread: (id: string) => void;
  linkFor: (id: string) => string;
  /** A thread to open on load (from a shared link). */
  initialOpen?: string | null;
  moveTargets: { id: string; label: string }[];
}) {
  const [open, setOpen] = useState<string | null>(initialOpen ?? null);
  // A thread picked in the Comments list opens here.
  useEffect(() => {
    const on = (e: Event) => setOpen((e as CustomEvent<string>).detail);
    window.addEventListener(OPEN_COMMENT_EVENT, on);
    return () => window.removeEventListener(OPEN_COMMENT_EVENT, on);
  }, []);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; sx: number; sy: number } | null>(null);
  const me = snapshot.viewer.memberId;
  const unread = (root: CanvasComment) => {
    const latest = comments.filter((x) => x.id === root.id || x.parentId === root.id).filter((x) => x.author !== (me === "me" ? "user" : `member:${me}`)).map((x) => x.editedAt ?? x.createdAt).sort().at(-1);
    return Boolean(latest && latest > (root.readBy?.[me] ?? ""));
  };
  const roots = comments.filter((c) => !c.parentId && (showResolved || !c.resolved));
  const pin = (n: number | string, resolved: boolean) => (
    <span className={`grid size-7 place-items-center rounded-full rounded-bl-none text-[11px] font-semibold shadow-lg ${resolved ? "bg-zinc-700 text-zinc-300" : "bg-violet-500 text-white"}`}>{n}</span>
  );
  return (
    <>
      {roots.map((c, i) => (
        <div key={c.id} className="absolute z-20" style={{ left: c.x + (drag?.id === c.id ? drag.dx : 0), top: c.y + (drag?.id === c.id ? drag.dy : 0), transform: `translate(0, -100%) scale(${1 / zoom})`, transformOrigin: "bottom left" }}>
          <button
            className="relative cursor-grab"
            title={`${c.body}\nDrag to move`}
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              setDrag({ id: c.id, dx: 0, dy: 0, sx: e.clientX, sy: e.clientY });
            }}
            onPointerMove={(e) => drag?.id === c.id && setDrag({ ...drag, dx: (e.clientX - drag.sx) / zoom, dy: (e.clientY - drag.sy) / zoom })}
            onPointerUp={() => {
              if (!drag || drag.id !== c.id) return;
              setDrag(null);
              if (Math.abs(drag.dx) + Math.abs(drag.dy) > 4) onMove(c.id, { x: Math.round(c.x + drag.dx), y: Math.round(c.y + drag.dy) });
              else {
                const next = open === c.id ? null : c.id;
                setOpen(next);
                if (next && unread(c)) onRead(c.id);
              }
            }}
          >
            {pin(i + 1, c.resolved)}
            {unread(c) && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-sky-400 ring-2 ring-zinc-950" />}
          </button>
          {open === c.id && (
            <div style={{ transform: `scale(${zoom})`, transformOrigin: "top left" }}>
              <Thread
                root={c}
                replies={comments.filter((r) => r.parentId === c.id)}
                snapshot={snapshot}
                zoom={zoom}
                onReply={(b, a) => onReply(c, b, a)}
                onReact={onReact}
                onEdit={onEdit}
                onDeleteOne={onDelete}
                onUnread={() => {
                  onUnread(c.id);
                  setOpen(null);
                }}
                link={linkFor(c.id)}
                moveTargets={moveTargets}
                onMoveTo={(ws) => {
                  onMove(c.id, { workspaceId: ws });
                  setOpen(null);
                }}
                onResolve={(r) => onResolve(c.id, r)}
                onDelete={() => {
                  onDelete(c.id);
                  setOpen(null);
                }}
                onClose={() => setOpen(null)}
              />
            </div>
          )}
        </div>
      ))}
      {draft && (
        <div className="absolute z-30" style={{ left: draft.x, top: draft.y, transform: `translate(0, -100%) scale(${1 / zoom})`, transformOrigin: "bottom left" }} onPointerDown={(e) => e.stopPropagation()}>
          {pin("+", false)}
          <div className="mt-1 w-64 space-y-2 rounded-lg bg-zinc-900 p-2 shadow-2xl ring-1 ring-zinc-700">
            <Composer autoFocus placeholder="Leave a comment" label="Comment" onSend={onCreate} />
            <Button variant="ghost" className="py-1! text-xs" onClick={onCancelDraft}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
