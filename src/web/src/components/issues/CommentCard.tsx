import { memo, useState } from "react";
import { REACTIONS, type Comment, type Reaction, type Snapshot } from "../../../../core/types";
import { api } from "../../api";
import { Markdown } from "../Markdown";
import { actorName, Button, ErrorText, inputClass, timeAgo, useAction } from "../ui";

export const EMOJI: Record<Reaction, string> = { "+1": "\u{1F44D}", tada: "\u{1F389}", heart: "❤️", eyes: "\u{1F440}", rocket: "\u{1F680}", confused: "\u{1F615}" };

/** One comment: edit and delete for its author (delete for admins too), and reactions for everyone. */
type CardProps = { comment: Comment; issueId: string; snapshot: Snapshot; /** The current minute, so "5m ago" stays fresh. */ minute?: number };

/**
 * Long threads re-render on every update; a card is skipped when nothing it
 * shows changed: the comment, the viewer, the names it displays, or the minute.
 */
function sameCard(a: CardProps, b: CardProps): boolean {
  if (a.issueId !== b.issueId || a.minute !== b.minute || a.snapshot.viewer.memberId !== b.snapshot.viewer.memberId || a.snapshot.viewer.role !== b.snapshot.viewer.role) return false;
  const x = a.comment;
  const y = b.comment;
  if (x.seq !== y.seq || x.body !== y.body || x.editedAt !== y.editedAt || x.author !== y.author || JSON.stringify(x.reactions) !== JSON.stringify(y.reactions)) return false;
  const actors = [y.author, ...Object.values(y.reactions).flat()] as Comment["author"][];
  return actors.every((who) => actorName(who, a.snapshot) === actorName(who, b.snapshot));
}

export const CommentCard = memo(function CommentCard({ comment, issueId, snapshot }: CardProps) {
  const me = snapshot.viewer.memberId === "me" ? "user" : `member:${snapshot.viewer.memberId}`;
  const mine = comment.author === me;
  const canDelete = mine || snapshot.viewer.role !== "member";
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  const [picking, setPicking] = useState(false);
  const action = useAction();
  const react = (r: Reaction) => action.run(() => api.reactToComment(issueId, comment.seq, r, !(comment.reactions[r] ?? []).includes(me as never)));

  return (
    <div className="group text-sm">
      <p className="flex items-center gap-2 text-zinc-400">
        <span className="font-medium text-zinc-200">{actorName(comment.author, snapshot)}</span>
        commented <span className="text-xs text-zinc-600">{timeAgo(comment.ts)}</span>
        {comment.editedAt && <span className="text-xs text-zinc-600" title={`Edited ${new Date(comment.editedAt).toLocaleString()}`}>(edited)</span>}
        <span className="ml-auto hidden gap-2 text-xs group-hover:flex">
          {mine && !editing && (
            <button className="text-zinc-500 hover:text-zinc-100" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          {canDelete && (
            <button className="text-zinc-500 hover:text-red-400" onClick={() => confirm("Delete this comment?") && void action.run(() => api.deleteComment(issueId, comment.seq))}>
              Delete
            </button>
          )}
        </span>
      </p>
      {editing ? (
        <div className="mt-1 space-y-1.5">
          <textarea className={`${inputClass} min-h-16`} value={body} onChange={(e) => setBody(e.target.value)} autoFocus />
          <div className="flex gap-1">
            <Button variant="primary" disabled={!body.trim()} onClick={async () => (await action.run(() => api.editComment(issueId, comment.seq, body))) && setEditing(false)}>
              Save
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setBody(comment.body);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-1 rounded-lg bg-zinc-900 px-3 py-2">
          <Markdown>{comment.body}</Markdown>
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {(Object.entries(comment.reactions) as [Reaction, string[]][]).map(([r, who]) => (
          <button
            key={r}
            title={who.map((a) => actorName(a as Comment["author"], snapshot)).join(", ")}
            onClick={() => void react(r)}
            className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ring-1 ${who.includes(me) ? "bg-violet-950/60 ring-violet-700" : "ring-zinc-800 hover:bg-zinc-900"}`}
          >
            {EMOJI[r]} <span className="text-zinc-300">{who.length}</span>
          </button>
        ))}
        <span className="relative">
          <button className="hidden rounded-full px-2 py-0.5 text-xs text-zinc-500 ring-1 ring-zinc-800 group-hover:inline hover:text-zinc-200" onClick={() => setPicking(!picking)} title="Add a reaction">
            +
          </button>
          {picking && (
            <span className="absolute top-6 left-0 z-10 flex gap-1 rounded-lg bg-zinc-900 p-1 shadow-xl ring-1 ring-zinc-700">
              {REACTIONS.map((r) => (
                <button
                  key={r}
                  className="rounded px-1.5 py-0.5 hover:bg-zinc-800"
                  onClick={() => {
                    setPicking(false);
                    void react(r);
                  }}
                >
                  {EMOJI[r]}
                </button>
              ))}
            </span>
          )}
        </span>
      </div>
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
}, sameCard);
