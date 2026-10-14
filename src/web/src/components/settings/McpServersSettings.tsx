import { useEffect, useState } from "react";
import { api, type McpServerView } from "../../api";
import { Button, ErrorText, Field, inputClass, useAction } from "../ui";

const MARK = "********";

interface Draft {
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string;
  url: string;
  /** KEY=value per line; saved values show as the mark and are kept unless changed. */
  secrets: string;
  defaultOn: boolean;
}

const blank: Draft = { name: "", transport: "stdio", command: "", args: "", url: "", secrets: "", defaultOn: true };

function toDraft(s: McpServerView): Draft {
  const keys = s.transport === "stdio" ? s.envKeys : s.headerKeys;
  return { name: s.name, transport: s.transport, command: s.command, args: s.args.join(" "), url: s.url, secrets: keys.map((k) => `${k}=${MARK}`).join("\n"), defaultOn: s.defaultOn };
}

function pairs(text: string, sep: "=" | ":"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(sep);
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** The team's own MCP servers: added to chats and agents next to Cadence's tools. */
export function McpServersSettings({ canEdit }: { canEdit: boolean }) {
  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [editing, setEditing] = useState<{ original: string | null; draft: Draft } | null>(null);
  const action = useAction();
  useEffect(() => {
    api.mcpServers().then(setServers, (e: Error) => action.setError(e.message));
  }, []);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const d = editing.draft;
    const secret = d.transport === "stdio" ? pairs(d.secrets, "=") : pairs(d.secrets.replace(/^([^:=\n]+)=/gm, "$1:"), ":");
    void action.run(async () => {
      setServers(
        await api.saveMcpServer(editing.original ?? d.name, {
          name: d.name.trim(),
          transport: d.transport,
          command: d.command,
          args: d.args.match(/"[^"]*"|\S+/g)?.map((a) => a.replace(/^"|"$/g, "")) ?? [],
          env: d.transport === "stdio" ? secret : {},
          url: d.url,
          headers: d.transport === "http" ? secret : {},
          defaultOn: d.defaultOn,
        }),
      );
      setEditing(null);
    });
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="font-medium">MCP servers</h2>
        {canEdit && (
          <Button className="ml-auto" onClick={() => setEditing({ original: null, draft: blank })}>
            Add server
          </Button>
        )}
      </div>
      <p className="text-sm text-zinc-400">Your own tools for chats and agents: a database, a search index, an internal API. Each chat can turn them on or off from its MCP menu. Their tools ask for approval like any other.</p>
      {servers?.length === 0 && <p className="text-sm text-zinc-500">No servers yet.</p>}
      {servers?.map((s) => (
        <div key={s.name} className="flex items-center gap-3 rounded-lg p-3 ring-1 ring-zinc-800">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-sm">{s.name}</p>
            <p className="truncate font-mono text-xs text-zinc-500">{s.transport === "stdio" ? `${s.command} ${s.args.join(" ")}` : s.url}</p>
          </div>
          <span className="text-xs text-zinc-500">{s.defaultOn ? "On by default" : "Off by default"}</span>
          {canEdit && (
            <>
              <Button className="py-1! text-xs" variant="ghost" onClick={() => setEditing({ original: s.name, draft: toDraft(s) })}>
                Edit
              </Button>
              <Button className="py-1! text-xs text-red-400" variant="ghost" onClick={() => confirm(`Remove ${s.name}?`) && void action.run(async () => setServers(await api.removeMcpServer(s.name)))}>
                Remove
              </Button>
            </>
          )}
        </div>
      ))}
      {editing && (
        <form className="space-y-3 rounded-lg bg-zinc-900 p-4 ring-1 ring-zinc-700" onSubmit={save}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" hint="Tools appear as mcp__name__tool">
              <input className={`${inputClass} font-mono`} value={editing.draft.name} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, name: e.target.value } })} />
            </Field>
            <Field label="Runs">
              <select className={inputClass} value={editing.draft.transport} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, transport: e.target.value as Draft["transport"] } })}>
                <option value="stdio">On this machine (a command)</option>
                <option value="http">Remote (an HTTP URL)</option>
              </select>
            </Field>
          </div>
          {editing.draft.transport === "stdio" ? (
            <div className="grid grid-cols-[1fr_2fr] gap-3">
              <Field label="Command">
                <input className={`${inputClass} font-mono`} placeholder="npx" value={editing.draft.command} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, command: e.target.value } })} />
              </Field>
              <Field label="Arguments">
                <input className={`${inputClass} font-mono`} placeholder="-y @modelcontextprotocol/server-postgres postgres://..." value={editing.draft.args} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, args: e.target.value } })} />
              </Field>
            </div>
          ) : (
            <Field label="URL">
              <input className={`${inputClass} font-mono`} placeholder="https://mcp.example.com/mcp" value={editing.draft.url} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, url: e.target.value } })} />
            </Field>
          )}
          <Field label={editing.draft.transport === "stdio" ? "Environment variables (KEY=value per line)" : "Headers (Name=value per line)"} hint="Stored with the other integration secrets; never shown again.">
            <textarea className={`${inputClass} min-h-20 font-mono text-xs`} value={editing.draft.secrets} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, secrets: e.target.value } })} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={editing.draft.defaultOn} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, defaultOn: e.target.checked } })} /> On in new chats
          </label>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={action.busy}>
              Save
            </Button>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      <ErrorText>{action.error}</ErrorText>
    </section>
  );
}
