import { useEffect, useState } from "react";
import { api, type SharingStatus } from "../../api";
import { setLinkOrigin } from "../../public-url";
import { Button, ErrorText, Field, inputClass, useAction } from "../ui";

const TEAM_SERVER_GUIDE = "https://github.com/teddycitrus/cadence/blob/main/docs/team-server.md";

/**
 * How teammates on other computers reach this Cadence: a team server's own address, or this
 * computer shared through a Cloudflare tunnel (owner only, and only once sign-in is set up).
 */
export function AccessSettings() {
  const [status, setStatus] = useState<(SharingStatus & { canManage?: boolean }) | null>(null);
  const [named, setNamed] = useState({ token: "", url: "" });
  const [copied, setCopied] = useState(false);
  const action = useAction();
  const update = (s: SharingStatus & { canManage?: boolean }) => {
    setStatus((prev) => ({ ...s, canManage: s.canManage ?? prev?.canManage }));
    setLinkOrigin(s.publicUrl);
  };
  useEffect(() => {
    void api.sharing().then(update, () => undefined);
  }, []);
  // While a tunnel is connecting, check back until it is up.
  useEffect(() => {
    if (status?.state !== "starting") return;
    const t = window.setInterval(() => void api.sharing().then(update, () => undefined), 1500);
    return () => window.clearInterval(t);
  }, [status?.state]);
  if (!status) return null;

  const url = status.publicUrl;
  return (
    <section className="space-y-3">
      <h2 className="font-medium">Let teammates in</h2>
      {status.fixed ? (
        <p className="text-sm text-zinc-400">
          This is a team server. Teammates sign in at <span className="font-mono text-zinc-200">{url}</span>, and invite links use that address.
        </p>
      ) : (
        <>
          <p className="text-sm text-zinc-400">Teammates on other computers reach Cadence through a public address. Everyone who arrives that way signs in with their own account; nothing is open without one.</p>
          <div className="space-y-3 rounded-lg bg-zinc-900 p-4 ring-1 ring-zinc-800">
            <div className="flex items-center gap-2">
              <span className={`size-2.5 rounded-full ${status.state === "on" ? "bg-emerald-400" : status.state === "starting" ? "animate-pulse bg-amber-400" : status.state === "error" ? "bg-red-400" : "bg-zinc-600"}`} />
              <p className="font-medium">Share this computer</p>
              <span className="text-sm text-zinc-500">{status.state === "on" ? "On" : status.state === "starting" ? "Connecting..." : status.state === "error" ? "Stopped" : "Off"}</span>
            </div>
            {url && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 truncate rounded bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-200 ring-1 ring-zinc-800">{url}</span>
                <Button className="py-1! text-xs" onClick={() => void navigator.clipboard.writeText(url).then(() => (setCopied(true), window.setTimeout(() => setCopied(false), 1500)))}>
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            )}
            {status.error && <p className="text-sm text-red-400">{status.error}</p>}
            {status.canManage ? (
              <>
                <div className="flex flex-wrap gap-2">
                  {status.state === "on" || status.state === "starting" ? (
                    <Button disabled={action.busy} onClick={() => action.run(async () => update(await api.stopSharing()))}>
                      Stop sharing
                    </Button>
                  ) : (
                    <>
                      <Button variant="primary" disabled={action.busy} onClick={() => action.run(async () => update(await api.startSharing("quick")))}>
                        {action.busy ? "Starting..." : "Share with a temporary address"}
                      </Button>
                      {status.named.configured && (
                        <Button disabled={action.busy} onClick={() => action.run(async () => update(await api.startSharing("named")))}>
                          Share at {status.named.url}
                        </Button>
                      )}
                    </>
                  )}
                </div>
                <p className="text-xs text-zinc-500">
                  Runs through Cloudflare's free tunnel (installed on first use). A temporary address changes each time sharing starts, so send new invite links after a restart; it works while this computer is on and awake.
                </p>
                <details className="text-sm">
                  <summary className="cursor-pointer text-zinc-400 hover:text-zinc-200">Use a fixed address from your own Cloudflare account</summary>
                  <div className="mt-3 space-y-2">
                    <p className="text-xs text-zinc-500">
                      In Cloudflare's dashboard, create a tunnel (Zero Trust &gt; Networks &gt; Tunnels), point a public hostname at http://localhost:{window.location.port || "4317"}, and paste its token and that hostname here.
                    </p>
                    <Field label="Tunnel token">
                      <input className={inputClass} type="password" autoComplete="off" value={named.token} onChange={(e) => setNamed({ ...named, token: e.target.value })} placeholder="eyJh..." />
                    </Field>
                    <Field label="Its address">
                      <input className={inputClass} value={named.url} onChange={(e) => setNamed({ ...named, url: e.target.value })} placeholder="https://cadence.example.com" />
                    </Field>
                    <div className="flex gap-2">
                      <Button disabled={!named.token.trim() || !named.url.trim() || action.busy} onClick={() => action.run(async () => (update(await api.setNamedTunnel(named)), setNamed({ token: "", url: "" })))}>
                        Save tunnel
                      </Button>
                      {status.named.configured && (
                        <Button variant="ghost" onClick={() => action.run(async () => update(await api.setNamedTunnel(null)))}>
                          Remove it
                        </Button>
                      )}
                    </div>
                  </div>
                </details>
              </>
            ) : (
              <p className="text-xs text-zinc-500">Only the owner can share this computer.</p>
            )}
          </div>
          <p className="text-sm text-zinc-500">
            For a team that keeps working when this computer is off, run Cadence as a team server (Docker, or a one-click host) and have everyone join it from the app.{" "}
            <a className="text-violet-300 hover:underline" href={TEAM_SERVER_GUIDE} target="_blank" rel="noreferrer">
              How to set one up
            </a>
          </p>
        </>
      )}
      <ErrorText>{action.error}</ErrorText>
    </section>
  );
}
