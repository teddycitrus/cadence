import { useEffect, useState } from "react";
import { orgParam } from "../../org";
import type { ShareLink } from "../../../../core/types";
import { api } from "../../api";
import { Button, ErrorText, useAction } from "../ui";
import { linkOrigin } from "../../public-url";

const urlOf = (id: string) => `${linkOrigin()}/#/share/${id}${orgParam()}`;

/** Turns a read-only public link for a doc, issue, or canvas on and off. */
export function ShareButton({ kind, refId }: { kind: ShareLink["kind"]; refId: string }) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<ShareLink | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const action = useAction();
  useEffect(() => {
    if (open) api.shareFor(kind, refId).then(setLink, () => setLink(null));
  }, [open, kind, refId]);

  return (
    <span className="relative">
      <Button variant={open ? "secondary" : "ghost"} onClick={() => setOpen(!open)}>
        Share
      </Button>
      {open && (
        <div className="absolute top-9 right-0 z-30 w-80 space-y-3 rounded-lg bg-zinc-900 p-3 text-sm shadow-2xl ring-1 ring-zinc-700">
          {link ? (
            <>
              <p className="text-zinc-300">Anyone with this link can view it (read only), without signing in.</p>
              <div className="flex gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-zinc-950 px-2 py-1 text-xs text-zinc-300">{urlOf(link.id)}</code>
                <button
                  className="text-xs text-zinc-300 hover:text-zinc-50"
                  onClick={() => {
                    void navigator.clipboard.writeText(urlOf(link.id));
                    setCopied(true);
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <Button variant="danger" className="text-xs" onClick={() => action.run(async () => (await api.revokeShare(link.id), setLink(null)))}>
                Turn off link
              </Button>
            </>
          ) : link === null ? (
            <>
              <p className="text-zinc-400">Create a read-only link anyone can open without an account. You can turn it off at any time.</p>
              <Button variant="primary" className="text-xs" disabled={action.busy} onClick={() => action.run(async () => setLink(await api.createShare(kind, refId)))}>
                Create link
              </Button>
            </>
          ) : (
            <p className="text-zinc-500">Loading...</p>
          )}
          <ErrorText>{action.error}</ErrorText>
        </div>
      )}
    </span>
  );
}
