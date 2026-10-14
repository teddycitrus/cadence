import { useEffect, useState } from "react";
import { inputClass } from "../ui";

type Value = string | number | boolean;

/**
 * Edits the literal props a frame renders its component with. Each
 * change is written to the canvas source, keeping the value's type.
 */
export function PropsPopover({ name, load, onSet, onClose }: { name: string; load: () => Promise<{ name: string; value: Value }[]>; onSet: (name: string, value: Value) => Promise<unknown>; onClose: () => void }) {
  const [props, setProps] = useState<{ name: string; value: Value }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    load().then(setProps, (e: Error) => setError(e.message));
  }, []);

  const commit = (prop: string, value: Value) => {
    setProps((ps) => ps?.map((p) => (p.name === prop ? { ...p, value } : p)) ?? ps);
    void onSet(prop, value).catch((e: Error) => setError(e.message));
  };

  return (
    <div className="absolute top-3 right-3 z-30 w-72 rounded-lg bg-zinc-900 p-3 text-xs shadow-xl ring-1 ring-zinc-700">
      <div className="mb-2 flex items-center">
        <span className="font-medium text-zinc-200">Props of {name}</span>
        <button className="ml-auto text-zinc-500 hover:text-zinc-100" onClick={onClose}>
          x
        </button>
      </div>
      {error && <p className="mb-2 text-red-400">{error}</p>}
      {props === null && !error && <p className="text-zinc-500">Loading...</p>}
      {props?.length === 0 && <p className="text-zinc-500">No plain props to edit. Props set from variables, arrays, or callbacks are edited in code.</p>}
      <div className="grid grid-cols-[6rem_1fr] items-center gap-x-2 gap-y-1.5">
        {props?.map((p) => (
          <label key={p.name} className="contents">
            <span className="truncate font-mono text-zinc-400" title={p.name}>
              {p.name}
            </span>
            {typeof p.value === "boolean" ? (
              <input type="checkbox" className="justify-self-start" checked={p.value} onChange={(e) => commit(p.name, e.target.checked)} />
            ) : (
              <input
                className={`${inputClass} py-0.5! text-xs`}
                type={typeof p.value === "number" ? "number" : "text"}
                defaultValue={String(p.value)}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                onBlur={(e) => {
                  const raw = e.target.value;
                  const value = typeof p.value === "number" ? Number(raw) : raw;
                  if (value !== p.value && !(typeof value === "number" && !Number.isFinite(value))) commit(p.name, value);
                }}
              />
            )}
          </label>
        ))}
      </div>
    </div>
  );
}
