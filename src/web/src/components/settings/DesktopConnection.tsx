import { useState } from "react";
import { desktop } from "../../desktop";
import { Button, ErrorText, inputClass } from "../ui";

/**
 * Desktop app only: whether this app runs Cadence on this computer or joins a team's server
 * (an always-on Cadence the team shares). Pasting an invite link works too.
 */
export function DesktopConnection({ compact = false }: { compact?: boolean }) {
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!desktop) return null;
  const team = desktop.connection.mode === "team";
  const join = async () => {
    setBusy(true);
    setError(null);
    const r = await desktop!.joinServer(address);
    // On success the window moves to the team's server, so this page goes away.
    if (!r.ok) {
      setError(r.error ?? "Could not join that server");
      setBusy(false);
    }
  };
  return (
    <section className="space-y-2">
      {!compact && <p className="text-sm font-medium">Where this app runs Cadence</p>}
      {team ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-zinc-400">
            Joined your team's server at <span className="font-mono text-zinc-200">{desktop.connection.url}</span>.
          </span>
          <Button onClick={() => void desktop!.useThisComputer()}>Use this computer instead</Button>
        </div>
      ) : (
        <>
          <p className="text-sm text-zinc-500">On this computer. If your team runs a Cadence server, join it to work in the same projects, board, and docs.</p>
          <div className="flex gap-2">
            <input
              className={`${inputClass} font-mono text-xs`}
              placeholder="https://cadence.yourteam.com, or paste an invite link"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && address.trim() && !busy && void join()}
            />
            <Button disabled={!address.trim() || busy} onClick={() => void join()}>
              {busy ? "Connecting..." : "Join"}
            </Button>
          </div>
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </section>
  );
}
