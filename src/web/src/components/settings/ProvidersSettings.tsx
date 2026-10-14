import { useEffect, useState } from "react";
import type { ProviderStatus } from "../../../../core/providers";
import { api } from "../../api";
import { Button, ErrorText, Field, inputClass, useAction } from "../ui";
import { ProviderSignIn } from "./ProviderSignIn";

export function KeyField({ provider, name, onSaved }: { provider: ProviderStatus; name: string; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const action = useAction();
  const set = provider.envSet.includes(name);
  return (
    <Field label={name} hint={set ? "Saved. Enter a new value to replace it." : undefined}>
      <div className="flex gap-2">
        <input className={inputClass} type="password" autoComplete="off" placeholder={set ? "••••••••" : "Not set"} value={value} onChange={(e) => setValue(e.target.value)} />
        <Button disabled={!value || action.busy} onClick={() => action.run(async () => (await api.updateProvider(provider.id, { env: { [name]: value } }), setValue(""), onSaved()))}>
          Save
        </Button>
        {set && (
          <Button variant="ghost" disabled={action.busy} onClick={() => action.run(async () => (await api.updateProvider(provider.id, { env: { [name]: null } }), onSaved()))}>
            Remove
          </Button>
        )}
      </div>
      <ErrorText>{action.error}</ErrorText>
    </Field>
  );
}

/** A key for one model: chats on that model use it instead of the harness-wide key or the harness's own sign-in. */
function ModelKeys({ provider, onSaved }: { provider: ProviderStatus; onSaved: () => void }) {
  const name = provider.keyEnvs[0];
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const action = useAction();
  if (!name || provider.models.length === 0) return null;
  const save = (model: string, v: string | null) =>
    action.run(async () => {
      await api.updateProvider(provider.id, { modelEnv: { [model]: { [name]: v } } });
      setEditing(null);
      setValue("");
      onSaved();
    });
  return (
    <details className="rounded-md bg-zinc-900/40 px-3 py-2">
      <summary className="cursor-pointer text-xs text-zinc-400">Keys per model ({Object.keys(provider.modelEnvSet ?? {}).length} set)</summary>
      <p className="mt-1 text-[11px] text-zinc-500">A model with its own {name} uses it; the others use the key above, or the harness's own sign-in.</p>
      <ul className="mt-2 divide-y divide-zinc-800 text-xs">
        {provider.models.map((m) => {
          const own = provider.modelEnvSet?.[m]?.includes(name);
          return (
            <li key={m} className="flex items-center gap-2 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-zinc-300">{m}</span>
              {editing === m ? (
                <>
                  <input autoFocus className={`${inputClass} w-48 text-xs`} type="password" autoComplete="off" placeholder={name} value={value} onChange={(e) => setValue(e.target.value)} />
                  <Button disabled={!value || action.busy} onClick={() => save(m, value)}>
                    Save
                  </Button>
                  <Button variant="ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <span className={own ? "text-emerald-400" : "text-zinc-500"}>{own ? "Own key" : "System default"}</span>
                  <Button variant="ghost" onClick={() => (setEditing(m), setValue(""))}>
                    {own ? "Replace" : "Set key"}
                  </Button>
                  {own && (
                    <Button variant="ghost" disabled={action.busy} onClick={() => save(m, null)}>
                      Remove
                    </Button>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
      <ErrorText>{action.error}</ErrorText>
    </details>
  );
}

function ProviderCard({ provider, onSaved }: { provider: ProviderStatus; onSaved: () => void }) {
  const [command, setCommand] = useState(provider.command ?? "");
  const [cliCommand, setCliCommand] = useState(provider.cliCommand ?? "");
  const [extra, setExtra] = useState("");
  const [extraValue, setExtraValue] = useState("");
  const [check, setCheck] = useState<{ ok: boolean; reply?: string; error?: string } | null>(null);
  const action = useAction();
  useEffect(() => {
    setCommand(provider.command ?? "");
    setCliCommand(provider.cliCommand ?? "");
  }, [provider.command, provider.cliCommand]);
  const keyNames = [...new Set([...provider.keyEnvs, ...(provider.baseUrlEnv ? [provider.baseUrlEnv] : []), ...provider.envSet])];
  const acp = provider.protocol === "acp";
  const dirty = command !== (provider.command ?? "") || cliCommand !== (provider.cliCommand ?? "");
  return (
    <section className="space-y-3 rounded-lg border border-zinc-800 p-4">
      <header className="flex items-center gap-2">
        <h2 className="font-medium">{provider.label}</h2>
        <span className={`rounded px-1.5 py-0.5 text-xs ${provider.installed ? "bg-emerald-950 text-emerald-300" : "bg-zinc-900 text-zinc-500"}`}>{provider.installed ? "Found on this machine" : "Not installed"}</span>
        <span className="text-xs text-zinc-500">{acp ? "Agent Client Protocol" : "Claude Agent SDK"}</span>
        <Button
          className="ml-auto"
          disabled={action.busy}
          onClick={() =>
            action.run(async () => {
              setCheck(null);
              setCheck(await api.checkProvider(provider.id));
            })
          }
        >
          {action.busy ? "Checking..." : "Check"}
        </Button>
      </header>
      {check && <p className={`text-sm ${check.ok ? "text-emerald-400" : "text-red-400"}`}>{check.ok ? `Working. It replied: ${check.reply || "(empty)"}` : check.error}</p>}
      {!provider.installed && <p className="text-sm text-zinc-500">To install: {provider.install}.</p>}
      {acp && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Launch command" hint="Starts the harness's ACP server.">
            <input className={`${inputClass} font-mono text-xs`} value={command} onChange={(e) => setCommand(e.target.value)} />
          </Field>
          <Field label="CLI command" hint="Opens a session in its own terminal UI. {session} is replaced.">
            <input className={`${inputClass} font-mono text-xs`} value={cliCommand} onChange={(e) => setCliCommand(e.target.value)} />
          </Field>
        </div>
      )}
      {acp && dirty && (
        <div className="flex gap-2">
          <Button variant="primary" disabled={action.busy} onClick={() => action.run(async () => (await api.updateProvider(provider.id, { command: command || null, cliCommand: cliCommand || null }), onSaved()))}>
            Save commands
          </Button>
          <Button variant="ghost" onClick={() => (setCommand(provider.command ?? ""), setCliCommand(provider.cliCommand ?? ""))}>
            Discard
          </Button>
        </div>
      )}
      <div className="space-y-2">
        <p className="text-xs font-medium text-zinc-400">Use your account</p>
        {provider.installed ? <ProviderSignIn provider={provider.id} onDone={onSaved} /> : <p className="text-sm text-zinc-500">Install it first (see above), then sign in here.</p>}
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium text-zinc-400">Or use an API key</p>
        <p className="text-xs text-zinc-500">Not needed when you sign in above. Keys stay on this machine and are passed only to this harness.</p>
        {keyNames.map((name) => (
          <KeyField key={name} provider={provider} name={name} onSaved={onSaved} />
        ))}
        <div className="flex gap-2">
          <input className={`${inputClass} font-mono text-xs`} placeholder="Another variable, like OPENROUTER_API_KEY" value={extra} onChange={(e) => setExtra(e.target.value.toUpperCase())} />
          <input className={inputClass} type="password" autoComplete="off" placeholder="Value" value={extraValue} onChange={(e) => setExtraValue(e.target.value)} />
          <Button
            disabled={!/^[A-Z][A-Z0-9_]{0,63}$/.test(extra) || keyNames.includes(extra) || !extraValue || action.busy}
            onClick={() =>
              action.run(async () => {
                await api.updateProvider(provider.id, { env: { [extra]: extraValue } });
                setExtra("");
                setExtraValue("");
                onSaved();
              })
            }
          >
            Add
          </Button>
        </div>
      </div>
      <ModelKeys provider={provider} onSaved={onSaved} />
      <p className="text-xs text-zinc-500">Models: {provider.models.join(", ")}</p>
      <ErrorText>{action.error}</ErrorText>
    </section>
  );
}

export function ProvidersSettings() {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reload = () => void api.providers().then(setProviders, (e: Error) => setError(e.message));
  useEffect(reload, []);
  return (
    <div className="max-w-3xl space-y-4">
      <ErrorText>{error}</ErrorText>
      {providers.map((p) => (
        <ProviderCard key={p.id} provider={p} onSaved={reload} />
      ))}
    </div>
  );
}
