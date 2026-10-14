import { useEffect, useState } from "react";
import { Button, ErrorText } from "../ui";

/** The OAuth consent page: a chat app asks to use Cadence's tools as the signed-in person. */
export function OAuthConsent({ query }: { query: string }) {
  const params = Object.fromEntries(new URLSearchParams(query));
  const [info, setInfo] = useState<{ clientName: string; redirectHost: string; organization: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`/api/oauth/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json()) as Record<string, string>;
    if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
    return json;
  };
  useEffect(() => {
    post("request", params).then((r) => setInfo(r as unknown as typeof info), (e: Error) => setError(e.message));
  }, [query]);
  const decide = (allow: boolean) => {
    setBusy(true);
    post("decide", { params, allow }).then(
      (r) => (window.location.href = r.redirect!),
      (e: Error) => (setError(e.message), setBusy(false)),
    );
  };
  return (
    <div className="grid h-dvh place-items-center bg-zinc-950 p-6 text-zinc-100">
      <div className="w-full max-w-md space-y-4 rounded-xl bg-zinc-900 p-6 ring-1 ring-zinc-800">
        <h1 className="text-lg font-medium">Connect to Cadence</h1>
        {info ? (
          <>
            <p className="text-sm text-zinc-300">
              <span className="font-medium text-zinc-100">{info.clientName}</span> wants to use {info.organization}'s issues, docs, agents, and other tools as you. It returns to <span className="font-mono">{info.redirectHost}</span>.
            </p>
            <p className="text-xs text-zinc-500">It gets a personal access token you can revoke at any time in Settings &gt; Integrations. It stops at the same sign-off stages as Cadence's own agents. Only connect apps you trust.</p>
            <div className="flex gap-2">
              <Button variant="primary" disabled={busy} onClick={() => decide(true)}>
                Allow
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => decide(false)}>
                Deny
              </Button>
            </div>
          </>
        ) : !error ? (
          <p className="text-sm text-zinc-500">Loading...</p>
        ) : null}
        <ErrorText>{error}</ErrorText>
      </div>
    </div>
  );
}
