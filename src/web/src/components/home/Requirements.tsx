import { useEffect, useState } from "react";
import { api, type Requirement } from "../../api";
import { Button } from "../ui";

/** Node, Git, and Claude Code on this machine: each found (with its version) or a link to install it, and a re-check. */
export function Requirements({ onContinue }: { onContinue: () => void }) {
  const [items, setItems] = useState<Requirement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const installNode = () => {
    setInstalling(true);
    setError(null);
    api
      .installNode()
      .then((r) => setItems(r.requirements), (e: Error) => setError(`Could not install Node.js: ${e.message}`))
      .finally(() => setInstalling(false));
  };
  const check = () => {
    setChecking(true);
    setError(null);
    api
      .requirements()
      .then(setItems, (e: Error) => setError(e.message))
      .finally(() => setChecking(false));
  };
  useEffect(check, []);
  const missing = items?.filter((r) => r.required && !r.installed) ?? [];
  return (
    <div className="space-y-4">
      <div className="divide-y divide-zinc-800 rounded-lg bg-zinc-900 ring-1 ring-zinc-800">
        {!items && !error && <p className="p-4 text-sm text-zinc-500">Checking this machine...</p>}
        {error && <p className="p-4 text-sm text-red-400">{error}</p>}
        {items?.map((r) => (
          <div key={r.id}>
          <div className="flex items-start gap-3 p-4">
            <span className={`mt-1 size-2.5 shrink-0 rounded-full ${r.installed ? "bg-emerald-400" : r.required ? "bg-red-400" : "bg-amber-400"}`} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {r.label} {!r.required && <span className="text-xs font-normal text-zinc-500">recommended</span>}
              </p>
              <p className="text-xs text-zinc-500">{r.why}</p>
            </div>
            {r.installed ? (
              <span className="shrink-0 font-mono text-xs text-zinc-400">{r.version}</span>
            ) : (
              <div className="flex shrink-0 items-center gap-3">
                {r.id === "node" && (
                  <Button className="py-1! text-xs" disabled={installing} onClick={installNode} title="Download the official Node.js 24 release into Cadence's data folder">
                    {installing ? "Installing..." : "Install for me"}
                  </Button>
                )}
                <a className="text-xs text-violet-300 hover:underline" href={r.installUrl} target="_blank" rel="noreferrer">
                  {r.id === "node" ? "Install yourself" : r.id === "ai" ? "Get an API key" : "Install"}
                </a>
              </div>
            )}
          </div>
          {r.id === "ai" && !r.installed && <p className="px-4 pb-4 pl-9 text-xs text-zinc-500">You will connect one in the next step: sign in with your Claude account or paste an API key.</p>}
          </div>
        ))}
      </div>
      {missing.length > 0 && <p className="text-sm text-amber-300">Still needed: {missing.map((r) => (r.id === "ai" ? "a model for agents" : r.label)).join(" and ")}. You can continue now and finish this in Settings later, but projects and agents will not run until then.</p>}
      <div className="flex gap-2">
        <Button variant="primary" onClick={onContinue}>
          Continue
        </Button>
        <Button disabled={checking} onClick={check}>
          {checking ? "Checking..." : "Check again"}
        </Button>
      </div>
    </div>
  );
}
