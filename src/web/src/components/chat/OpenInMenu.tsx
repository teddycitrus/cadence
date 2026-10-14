import { useState } from "react";
import { api } from "../../api";
import { Button, ErrorText } from "../ui";

/** Opens the workspace's folder in the file manager or an editor installed on the host machine. */
export function OpenInMenu({ workspaceId }: { workspaceId: string }) {
  const [targets, setTargets] = useState<{ id: string; label: string }[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = () => {
    setOpen((o) => !o);
    setError(null);
    if (!targets) void api.openInTargets(workspaceId).then((r) => setTargets(r.targets), (e: Error) => setError(e.message));
  };
  return (
    <div className="relative">
      <Button variant="ghost" onClick={toggle} title="Open this workspace's folder in another app">
        Open in...
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 z-50 mt-1 w-48 rounded-lg bg-zinc-900 py-1 text-sm shadow-2xl ring-1 ring-zinc-700">
            {!targets && !error && <p className="px-3 py-1.5 text-zinc-500">Looking for apps...</p>}
            {targets?.map((t) => (
              <button
                key={t.id}
                className="block w-full px-3 py-1.5 text-left text-zinc-200 hover:bg-zinc-800"
                onClick={() =>
                  void api.openIn(workspaceId, t.id).then(
                    () => setOpen(false),
                    (e: Error) => setError(e.message),
                  )
                }
              >
                {t.label}
              </button>
            ))}
            {targets && targets.length === 1 && <p className="px-3 py-1.5 text-xs text-zinc-500">No editors found on PATH (VS Code, Cursor, Zed, and others are listed when installed).</p>}
            {error && (
              <div className="px-3 py-1.5">
                <ErrorText>{error}</ErrorText>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
