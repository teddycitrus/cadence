import { useEffect, useState } from "react";
import { api, type DesignToken } from "../../api";
import { Button, ErrorText, inputClass, useAction } from "../ui";

const KINDS: { id: DesignToken["kind"]; label: string }[] = [
  { id: "color", label: "Colors" },
  { id: "length", label: "Spacing and sizes" },
  { id: "font", label: "Fonts" },
  { id: "shadow", label: "Shadows" },
  { id: "other", label: "Other" },
];

/** Variables Tailwind defines itself, so a reference to one is not broken. */
const TAILWIND_VARS = /^--(?:tw-|color-|spacing|font-|text-|radius-|shadow-|inset-shadow-|drop-shadow-|leading-|tracking-|breakpoint-|container-|ease-|animate-|blur-|perspective-|aspect-|default-)/;

/** Tokens for the whole page (root, theme, dark mode) rather than one component's selector. */
const isGlobal = (scope: string) => /^(:root|@theme.*|html|body|:host|\.dark|\.light|\[data-[^\]]+\].*|@media.*|@layer.*)$/.test(scope);

function TokenRow({ token, all, onSave, onFind }: { token: DesignToken; all: DesignToken[]; onSave: (value: string) => Promise<unknown>; onFind: (name: string) => void }) {
  const [value, setValue] = useState(token.value);
  useEffect(() => setValue(token.value), [token.value]);
  // An alias shows the color it ends up as.
  const resolved = (() => {
    let t: DesignToken | undefined = token;
    for (let i = 0; i < 5 && t?.aliasOf; i++) t = all.find((x) => x.name === t!.aliasOf);
    return t?.value ?? token.value;
  })();
  const commit = () => value.trim() && value !== token.value && void onSave(value.trim());
  return (
    <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 py-1">
      {token.kind === "color" ? (
        <input type="color" className="h-6 w-6 cursor-pointer rounded bg-transparent" disabled={Boolean(token.aliasOf)} value={/^#[0-9a-f]{6}$/i.test(resolved) ? resolved : "#000000"} onChange={(e) => setValue(e.target.value)} onBlur={commit} title={token.aliasOf ? `Alias of ${token.aliasOf}` : undefined} />
      ) : (
        <span />
      )}
      <span className="truncate font-mono text-xs text-zinc-300" title={`${token.name} in ${token.scope} (${token.file})`}>
        {token.name}
        {token.scope !== ":root" && <span className="ml-1 text-zinc-600">{token.scope}</span>}
      </span>
      <div className="min-w-0 space-y-0.5">
        <input className={`${inputClass} py-1! font-mono text-xs`} value={value} onChange={(e) => setValue(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
        {token.aliasOf && (
          <button className="truncate rounded bg-zinc-800 px-1.5 font-mono text-[10px] text-violet-300 hover:underline" onClick={() => onFind(token.aliasOf!)} title="Show the variable this one points at">
            {"-> "}
            {token.aliasOf}
          </button>
        )}
      </div>
    </div>
  );
}

/** The project's design tokens (CSS custom properties), edited where they are declared. */
export function VariablesPanel({ workspaceId, onClose, onChanged }: { workspaceId: string; onClose: () => void; onChanged: (tokens: DesignToken[]) => void }) {
  const [tokens, setTokens] = useState<DesignToken[] | null>(null);
  const [query, setQuery] = useState("");
  const [scoped, setScoped] = useState(false);
  const [adding, setAdding] = useState({ name: "--", value: "", file: "" });
  const action = useAction();
  useEffect(() => {
    api.designTokens(workspaceId).then((t) => {
      setTokens(t);
      setAdding((a) => ({ ...a, file: t[0]?.file ?? "" }));
    }, (e: Error) => action.setError(e.message));
  }, [workspaceId]);
  const save = (change: { file: string; name: string; scope?: string; value: string; add?: boolean }) =>
    action.run(async () => {
      const next = await api.saveDesignToken(workspaceId, change);
      setTokens(next);
      onChanged(next);
    });
  const files = [...new Set((tokens ?? []).map((t) => t.file))];
  const shown = (tokens ?? []).filter((t) => (scoped || isGlobal(t.scope)) && (!query || t.name.includes(query) || t.value.includes(query)));
  const scopedCount = (tokens ?? []).filter((t) => !isGlobal(t.scope)).length;
  // var(--x) references to variables no stylesheet defines.
  const defined = new Set((tokens ?? []).map((t) => t.name));
  const broken = (tokens ?? []).flatMap((t) => [...t.value.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]!).filter((n) => !defined.has(n) && !TAILWIND_VARS.test(n)).map((n) => ({ token: t.name, missing: n })));
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-zinc-900 bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-900 px-3 py-2">
        <p className="text-sm font-medium">Variables</p>
        <button className="ml-auto text-zinc-500 hover:text-zinc-100" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <input className={`${inputClass} text-xs`} placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)} />
        {scopedCount > 0 && (
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <input type="checkbox" checked={scoped} onChange={(e) => setScoped(e.target.checked)} /> Show {scopedCount} component-scoped
          </label>
        )}
        {broken.length > 0 && (
          <div className="space-y-0.5 rounded-md bg-amber-950/40 p-2 text-[11px] text-amber-200 ring-1 ring-amber-900">
            {broken.slice(0, 6).map((b, i) => (
              <p key={i} className="font-mono">
                {b.token} uses {b.missing}, which is not defined
              </p>
            ))}
          </div>
        )}
        {tokens && !tokens.length && <p className="text-xs text-zinc-500">No CSS variables yet. Add one below; it goes in your stylesheet's :root (or Tailwind @theme) block.</p>}
        {KINDS.map((k) => {
          const list = shown.filter((t) => t.kind === k.id);
          if (!list.length) return null;
          return (
            <section key={k.id}>
              <p className="mb-1 text-[11px] tracking-wide text-zinc-500 uppercase">{k.label}</p>
              {list.map((t) => (
                <TokenRow key={`${t.file}${t.scope}${t.name}`} token={t} all={tokens!} onSave={(value) => save({ file: t.file, name: t.name, scope: t.scope, value })} onFind={setQuery} />
              ))}
            </section>
          );
        })}
      </div>
      {files.length > 0 && (
        <div className="space-y-2 border-t border-zinc-900 p-3 text-xs">
          <p className="text-[11px] tracking-wide text-zinc-500 uppercase">New variable</p>
          <div className="grid grid-cols-2 gap-2">
            <input className={`${inputClass} py-1! font-mono text-xs`} value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
            <input className={`${inputClass} py-1! font-mono text-xs`} placeholder="#2563eb or 12px" value={adding.value} onChange={(e) => setAdding({ ...adding, value: e.target.value })} />
          </div>
          {files.length > 1 && (
            <select className={`${inputClass} py-1! text-xs`} value={adding.file} onChange={(e) => setAdding({ ...adding, file: e.target.value })}>
              {files.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          )}
          <Button className="py-1! text-xs" disabled={!/^--[a-zA-Z0-9_-]+$/.test(adding.name) || !adding.value.trim() || action.busy} onClick={() => void save({ file: adding.file, name: adding.name, value: adding.value, add: true }).then(() => setAdding({ ...adding, name: "--", value: "" }))}>
            Add
          </Button>
        </div>
      )}
      <ErrorText>{action.error}</ErrorText>
    </aside>
  );
}
