import { useEffect, useState, type ReactNode } from "react";
import type { ProviderStatus } from "../../../../core/providers";
import type { Snapshot } from "../../../../core/types";
import { api, type ClaudeAccount, type Integrations } from "../../api";
import { GitHubConnect } from "../settings/GitHubSettings";
import { Figma, Linear, Slack } from "../settings/IntegrationsSettings";
import { EmailSettings } from "../settings/MembersSettings";
import { ProviderSignIn } from "../settings/ProviderSignIn";
import { KeyField } from "../settings/ProvidersSettings";
import { Button } from "../ui";

// First-run step: the accounts and keys Cadence uses, all of them the
// person's own. Models first (agents need at least one), then GitHub, then the
// optional integrations. Everything here is also in Settings later.

/** A row that opens to show how to connect it. */
function Row({ title, status, ready, open, onToggle, children }: { title: string; status: string; ready: boolean; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="rounded-lg bg-zinc-900 ring-1 ring-zinc-800">
      <button className="flex w-full items-center gap-3 px-4 py-3 text-left" onClick={onToggle} aria-expanded={open}>
        <span className={`size-2.5 shrink-0 rounded-full ${ready ? "bg-emerald-400" : "bg-zinc-600"}`} />
        <span className="font-medium">{title}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-zinc-500">{status}</span>
        <span className="text-xs text-violet-300">{open ? "Hide" : ready ? "Change" : "Set up"}</span>
      </button>
      {open && <div className="space-y-3 border-t border-zinc-800 px-4 py-3">{children}</div>}
    </div>
  );
}

function providerStatus(p: ProviderStatus, claude: ClaudeAccount | null | undefined): { ready: boolean; text: string } {
  const key = p.keyEnvs.find((k) => p.envSet.includes(k));
  if (p.id === "claude-code" && claude?.loggedIn) return { ready: true, text: `Signed in${claude.email ? ` as ${claude.email}` : ""}` };
  if (key) return { ready: true, text: `${key} saved` };
  if (!p.installed) return { ready: false, text: "Not installed on this computer" };
  return { ready: false, text: p.id === "claude-code" ? "Not signed in" : "Sign in or add a key" };
}

function Models() {
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [claude, setClaude] = useState<ClaudeAccount | null | undefined>(undefined);
  const [open, setOpen] = useState<string | null>(null);
  const [check, setCheck] = useState<Record<string, string>>({});
  const reload = () => {
    void api.providers().then(setProviders, () => setProviders([]));
    void api.providerAccount("claude-code").then((r) => setClaude(r.account), () => setClaude(null));
  };
  useEffect(reload, []);
  // Open Claude Code first when no model is ready yet.
  useEffect(() => {
    if (!providers || claude === undefined || open !== null) return;
    if (!providers.some((p) => providerStatus(p, claude).ready)) setOpen("claude-code");
  }, [providers, claude]);
  if (!providers) return <p className="text-sm text-zinc-500">Looking at this computer...</p>;
  const anyReady = providers.some((p) => providerStatus(p, claude).ready);
  return (
    <div className="space-y-2">
      {!anyReady && <p className="text-sm text-amber-300">Agents need at least one. Claude Code comes with Cadence: sign in with your Claude account, or paste an Anthropic API key.</p>}
      {providers.map((p) => {
        const s = providerStatus(p, claude);
        return (
          <Row key={p.id} title={p.label} status={s.text} ready={s.ready} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)}>
            {p.installed ? (
              <>
                <p className="text-xs font-medium text-zinc-400">Use your account</p>
                <ProviderSignIn provider={p.id} onDone={reload} />
              </>
            ) : (
              <p className="text-sm text-zinc-500">To install: {p.install}.</p>
            )}
            <p className="text-xs font-medium text-zinc-400">Or use an API key</p>
            {p.keyEnvs.map((name) => (
              <KeyField key={name} provider={p} name={name} onSaved={reload} />
            ))}
            <div className="flex items-center gap-3">
              <Button
                onClick={() => {
                  setCheck({ ...check, [p.id]: "Checking..." });
                  void api.checkProvider(p.id).then((r) => setCheck((c) => ({ ...c, [p.id]: r.ok ? "Working." : (r.error ?? "It did not answer.") })));
                }}
              >
                Test it
              </Button>
              {check[p.id] && <p className={`text-sm ${check[p.id] === "Working." ? "text-emerald-400" : check[p.id] === "Checking..." ? "text-zinc-500" : "text-red-400"}`}>{check[p.id]}</p>}
            </div>
          </Row>
        );
      })}
    </div>
  );
}

function Optional({ snapshot }: { snapshot: Snapshot }) {
  const [data, setData] = useState<Integrations | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [github, setGithub] = useState(snapshot.github);
  useEffect(() => {
    void api.integrations().then(setData, () => undefined);
  }, []);
  const toggle = (id: string) => setOpen(open === id ? null : id);
  return (
    <div className="space-y-2">
      <Row title="GitHub" status={github.connected ? "Connected" : "Pull requests, checks, and reviews"} ready={github.connected} open={open === "github"} onToggle={() => toggle("github")}>
        <GitHubConnect snapshot={snapshot} onChange={setGithub} />
      </Row>
      {data && (
        <>
          <Row title="Slack" status={data.slack.configured ? (data.slack.team ? `Connected to ${data.slack.team}` : "Tokens saved") : "Agents in your Slack threads"} ready={data.slack.configured} open={open === "slack"} onToggle={() => toggle("slack")}>
            <Slack status={data.slack} onChange={(slack) => setData({ ...data, slack })} />
          </Row>
          <Row title="Linear" status={data.linear.connected ? "Connected" : "Two-way issue sync"} ready={data.linear.connected} open={open === "linear"} onToggle={() => toggle("linear")}>
            <Linear status={data.linear} onChange={(linear) => setData({ ...data, linear })} />
          </Row>
          <Row title="Figma" status={data.figma.connected ? "Token saved" : "Figma frames on your canvases"} ready={data.figma.connected} open={open === "figma"} onToggle={() => toggle("figma")}>
            <Figma connected={data.figma.connected} onChange={(connected) => setData({ ...data, figma: { connected } })} />
          </Row>
        </>
      )}
      <Row title="Email invites" status="Send invites from your own mail server" ready={false} open={open === "email"} onToggle={() => toggle("email")}>
        <EmailSettings />
      </Row>
    </div>
  );
}

export function ConnectAccounts({ snapshot }: { snapshot: Snapshot }) {
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="text-xl">AI models</h2>
        <p className="text-sm text-zinc-500">The harnesses agents run on. Each uses your own sign-in or key; nothing goes through a Cadence service.</p>
        <Models />
      </section>
      <section className="space-y-2">
        <h2 className="text-xl">Tools you already use</h2>
        <p className="text-sm text-zinc-500">All optional, and all in Settings later.</p>
        <Optional snapshot={snapshot} />
      </section>
      <p className="text-xs text-zinc-500">Keys and tokens stay on this computer, in Cadence's data folder. They are never shown again or sent to teammates.</p>
    </div>
  );
}
