import { useEffect, useState } from "react";
import { McpServersSettings } from "./McpServersSettings";
import { orgParam } from "../../org";
import { api, type Integrations, type LinearStatus, type McpToken, type SlackStatus } from "../../api";
import { Button, ErrorText, Field, inputClass, timeAgo, useAction } from "../ui";

function Card({ title, status, children }: { title: string; status: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl bg-zinc-900/60 p-4 ring-1 ring-zinc-800">
      <div className="flex items-center gap-3">
        <h2 className="font-medium">{title}</h2>
        <span className="text-xs">{status}</span>
      </div>
      {children}
    </section>
  );
}

const on = (label: string) => <span className="text-emerald-400">● {label}</span>;
const off = (label: string) => <span className="text-zinc-500">○ {label}</span>;

/** The name and picture the bot posts with. */
function SlackIdentityForm({ status, onChange }: { status: SlackStatus; onChange: (s: SlackStatus) => void }) {
  const [name, setName] = useState(status.identity?.name ?? "");
  const [icon, setIcon] = useState(status.identity?.iconUrl ?? "");
  const action = useAction();
  const dirty = name !== (status.identity?.name ?? "") || icon !== (status.identity?.iconUrl ?? "");
  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
      <Field label="Posts as">
        <input className={inputClass} placeholder="Cadence" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Picture URL" hint="A public https image. Needs the chat:write.customize scope (in the manifest).">
        <input className={inputClass} placeholder="https://..." value={icon} onChange={(e) => setIcon(e.target.value)} />
      </Field>
      <div className="flex items-end gap-2">
        {icon && <img src={icon} alt="" className="size-8 rounded" />}
        <Button disabled={!dirty || action.busy} onClick={() => void action.run(async () => onChange(await api.setSlackIdentity({ name: name || null, iconUrl: icon || null })))}>
          Save
        </Button>
      </div>
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
}

export function Slack({ status, onChange }: { status: SlackStatus; onChange: (s: SlackStatus) => void }) {
  const [bot, setBot] = useState("");
  const [app, setApp] = useState("");
  const [manifest, setManifest] = useState<string | null>(null);
  const action = useAction();
  const badge = !status.configured ? off("Not connected") : status.connection === "connected" ? on(`Connected to ${status.team}`) : <span className="text-amber-300">● {status.connection}</span>;

  return (
    <Card title="Slack" status={badge}>
      {status.configured ? (
        <div className="space-y-2 text-sm text-zinc-400">
          <p>Invite @Cadence to a channel, then give an agent a Slack trigger. Each thread gets its own workspace; replies in it continue the same chat.</p>
          {status.error && <p className="text-amber-300">{status.error}</p>}
          <SlackIdentityForm status={status} onChange={onChange} />
          <Button variant="ghost" onClick={() => action.run(async () => onChange(await api.disconnectSlack()))}>
            Disconnect
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-zinc-400">
            <li>
              At api.slack.com/apps choose Create New App, From a manifest, and paste{" "}
              <button className="text-violet-300 hover:underline" onClick={() => api.slackManifest().then((m) => setManifest(JSON.stringify(m, null, 2)))}>
                Cadence's manifest
              </button>
              .
            </li>
            <li>Install it to your workspace and copy the Bot User OAuth Token (xoxb-).</li>
            <li>Under Basic Information, create an app-level token with connections:write (xapp-).</li>
          </ol>
          {manifest && (
            <div className="relative">
              <pre className="max-h-48 overflow-auto rounded bg-zinc-950 p-2 text-xs text-zinc-300">{manifest}</pre>
              <button className="absolute top-1 right-2 text-xs text-zinc-400 hover:text-zinc-100" onClick={() => void navigator.clipboard.writeText(manifest)}>
                Copy
              </button>
            </div>
          )}
          <Field label="Bot token">
            <input className={inputClass} type="password" autoComplete="off" placeholder="xoxb-..." value={bot} onChange={(e) => setBot(e.target.value)} />
          </Field>
          <Field label="App-level token" hint="Lets Cadence receive events over Socket Mode, so no public URL is needed.">
            <input className={inputClass} type="password" autoComplete="off" placeholder="xapp-..." value={app} onChange={(e) => setApp(e.target.value)} />
          </Field>
          <Button
            variant="primary"
            disabled={action.busy || !bot.trim() || !app.trim()}
            onClick={() =>
              action.run(async () => {
                onChange(await api.connectSlack(bot.trim(), app.trim()));
                setBot("");
                setApp("");
              })
            }
          >
            {action.busy ? "Connecting..." : "Connect Slack"}
          </Button>
        </div>
      )}
      <ErrorText>{action.error}</ErrorText>
    </Card>
  );
}

export function Linear({ status, onChange }: { status: LinearStatus; onChange: (s: LinearStatus) => void }) {
  const [key, setKey] = useState("");
  const [teams, setTeams] = useState<{ id: string; key: string; name: string }[] | null>(null);
  const action = useAction();
  useEffect(() => {
    if (status.connected) api.linearTeams().then(setTeams, (e: Error) => action.setError(e.message));
  }, [status.connected]);

  return (
    <Card title="Linear" status={status.connected ? on(`Connected${status.organization ? ` to ${status.organization}` : ""}`) : off("Not connected")}>
      {status.connected ? (
        <div className="space-y-3 text-sm">
          <div>
            <p className="mb-1 text-zinc-400">Teams to sync onto the board</p>
            <div className="flex flex-wrap gap-1">
              {(teams ?? []).map((t) => {
                const selected = status.teamIds.includes(t.id);
                return (
                  <button
                    key={t.id}
                    className={`rounded-full px-2.5 py-0.5 text-xs ${selected ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 ring-1 ring-zinc-800 hover:text-zinc-300"}`}
                    onClick={() => action.run(async () => onChange(await api.configureLinear({ teamIds: selected ? status.teamIds.filter((x) => x !== t.id) : [...status.teamIds, t.id] })))}
                  >
                    {t.key} · {t.name}
                  </button>
                );
              })}
              {teams === null && <span className="text-xs text-zinc-500">Loading teams...</span>}
            </div>
          </div>
          <label className="flex items-start gap-2 text-zinc-300">
            <input type="checkbox" className="mt-1" checked={status.writeBack} onChange={(e) => action.run(async () => onChange(await api.configureLinear({ writeBack: e.target.checked })))} />
            <span>
              Write back to Linear
              <span className="block text-xs text-zinc-500">Moves and comments made in Cadence (by people or agents) update the Linear issue, and agents get tools to comment and change state.</span>
            </span>
          </label>
          <p className="text-xs text-zinc-500">
            {status.lastSyncAt ? `Last synced ${timeAgo(status.lastSyncAt)}. ` : "Not synced yet. "}
            {status.lastError && <span className="text-amber-300">{status.lastError}</span>}
          </p>
          <div className="flex gap-2">
            <Button disabled={action.busy || !status.teamIds.length} onClick={() => action.run(async () => onChange((await api.syncLinear()).status))}>
              {action.busy ? "Syncing..." : "Sync now"}
            </Button>
            <Button variant="ghost" onClick={() => action.run(async () => onChange(await api.disconnectLinear()))}>
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <Field label="Personal API key" hint="Linear > Settings > Security & access > Personal API keys. Stored on this machine only.">
            <input className={inputClass} type="password" autoComplete="off" placeholder="lin_api_..." value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
          <Button
            variant="primary"
            disabled={action.busy || !key.trim()}
            onClick={() =>
              action.run(async () => {
                onChange(await api.connectLinear(key.trim()));
                setKey("");
              })
            }
          >
            Connect Linear
          </Button>
        </div>
      )}
      <ErrorText>{action.error}</ErrorText>
    </Card>
  );
}

export function Figma({ connected, onChange }: { connected: boolean; onChange: (c: boolean) => void }) {
  const [token, setToken] = useState("");
  const action = useAction();
  return (
    <Card title="Figma" status={connected ? on("Token saved") : off("Not connected")}>
      <p className="text-sm text-zinc-400">Paste a Figma frame link onto a canvas to add it as a reference frame next to your real components.</p>
      {connected ? (
        <Button variant="ghost" onClick={() => action.run(async () => onChange((await api.saveFigmaToken(null)).connected))}>
          Remove token
        </Button>
      ) : (
        <div className="space-y-2">
          <Field label="Personal access token" hint="Figma > Settings > Security > Personal access tokens, with file read access.">
            <input className={inputClass} type="password" autoComplete="off" placeholder="figd_..." value={token} onChange={(e) => setToken(e.target.value)} />
          </Field>
          <Button
            variant="primary"
            disabled={!token.trim() || action.busy}
            onClick={() =>
              action.run(async () => {
                onChange((await api.saveFigmaToken(token.trim())).connected);
                setToken("");
              })
            }
          >
            Save token
          </Button>
        </div>
      )}
      <ErrorText>{action.error}</ErrorText>
    </Card>
  );
}

function McpAccess() {
  const [tokens, setTokens] = useState<McpToken[]>([]);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const action = useAction();
  useEffect(() => {
    api.mcpTokens().then(setTokens, () => undefined);
  }, []);
  const url = `${window.location.origin}/mcp${orgParam()}`;

  return (
    <Card title="MCP access for outside agents" status={tokens.length ? on(`${tokens.length} token${tokens.length === 1 ? "" : "s"}`) : off("No tokens")}>
      <p className="text-sm text-zinc-400">
        Agents outside Cadence (a cloud agent, a teammate's editor) can use Cadence's tools at <code className="text-zinc-300">{url}</code> with a token. They stop at sign-off stages like Cadence's own agents.
      </p>
      <div className="space-y-1 text-xs text-zinc-500">
        <p>
          A coding agent on this machine can use the <code className="text-zinc-300">cadence-mcp</code> package over stdio instead, which also brings the canvas tools of the workspace it runs in: <code className="text-zinc-300">claude mcp add cadence -- node packages/cadence-mcp/bin.mjs</code>, then <code className="text-zinc-300">node packages/cadence-mcp/bin.mjs login</code>.
        </p>
        <p>
          Narrow a connection with <code className="text-zinc-300">?toolsets=issues,docs</code> (issues, docs, comments, agents, scripts, slack, linear, canvas, skills, browser, git, host), make it read-only with <code className="text-zinc-300">?readonly=1</code>, and bind a workspace with <code className="text-zinc-300">?workspace=&lt;id&gt;</code>.
        </p>
      </div>
      {fresh && (
        <div className="space-y-1 rounded-lg bg-emerald-950/40 p-3 text-xs ring-1 ring-emerald-900">
          <p className="text-emerald-300">Copy this token now; it will not be shown again.</p>
          <code className="block break-all text-zinc-200">{fresh}</code>
          <p className="text-zinc-400">Example: claude mcp add --transport http cadence {url} --header "Authorization: Bearer {fresh.slice(0, 8)}..."</p>
        </div>
      )}
      <ul className="divide-y divide-zinc-800 text-sm">
        {tokens.map((t) => (
          <li key={t.id} className="flex items-center gap-3 py-1.5">
            <span className="flex-1">{t.name}</span>
            <code className="text-xs text-zinc-500">{t.prefix}...</code>
            <span className="text-xs text-zinc-500">{t.lastUsedAt ? `used ${timeAgo(t.lastUsedAt)}` : "never used"}</span>
            <button
              className="text-xs text-zinc-500 hover:text-red-400"
              onClick={() =>
                confirm(`Revoke "${t.name}"? Agents using it lose access immediately.`) &&
                action.run(async () => {
                  await api.revokeMcpToken(t.id);
                  setTokens(await api.mcpTokens());
                })
              }
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <input className={inputClass} placeholder="Name, e.g. codex-cloud" value={name} onChange={(e) => setName(e.target.value)} />
        <Button
          disabled={!name.trim() || action.busy}
          onClick={() =>
            action.run(async () => {
              const created = await api.createMcpToken(name.trim());
              setFresh(created.token);
              setName("");
              setTokens(await api.mcpTokens());
            })
          }
        >
          Create token
        </Button>
      </div>
      <ErrorText>{action.error}</ErrorText>
    </Card>
  );
}

/** Slack, Linear, Figma, and MCP access. GitHub has its own section. */
export function IntegrationsSettings({ canEdit = true }: { canEdit?: boolean }) {
  const [data, setData] = useState<Integrations | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.integrations().then(setData, (e: Error) => setError(e.message));
  }, []);
  if (!data) return <p className="text-sm text-zinc-500">{error ?? "Loading..."}</p>;
  return (
    <div className="max-w-2xl space-y-4">
      <Slack status={data.slack} onChange={(slack) => setData({ ...data, slack })} />
      <Linear status={data.linear} onChange={(linear) => setData({ ...data, linear })} />
      <Figma connected={data.figma.connected} onChange={(connected) => setData({ ...data, figma: { connected } })} />
      <McpServersSettings canEdit={canEdit} />
      <McpAccess />
    </div>
  );
}
