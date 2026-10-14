import { useEffect, useState } from "react";
import { api, type OrgInfo } from "../../api";
import { DEFAULT_ORG, switchOrg } from "../../org";
import { Button, ErrorText, Field, inputClass, useAction } from "../ui";

/** The organization's name and short name, and deleting it (owners only). */
export function OrgSettings() {
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [saved, setSaved] = useState(false);
  const action = useAction();
  useEffect(() => {
    api.orgs().then((list) => {
      const cur = list.find((o) => o.current) ?? null;
      setOrg(cur);
      setName(cur?.name ?? "");
      setSlug(cur?.slug ?? "");
    }, () => undefined);
  }, []);
  if (!org) return <p className="text-sm text-zinc-500">Loading...</p>;
  const owner = org.role === "owner";
  const setLogo = (file: File | null) =>
    action.run(async () => {
      let logo: string | null = null;
      if (file) {
        if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error("Use a PNG, JPEG, GIF, or WebP image");
        if (file.size > 2 * 1024 * 1024) throw new Error("Use an image under 2 MB");
        const data = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
          r.onerror = () => reject(r.error ?? new Error("Could not read the image"));
          r.readAsDataURL(file);
        });
        logo = (await api.uploadAsset({ name: file.name, mediaType: file.type, data })).id;
      }
      setOrg({ ...org, ...(await api.updateOrg(org.id, { logo })) });
    });
  return (
    <div className="max-w-2xl space-y-6">
      <Field label="Logo" hint="Shown in the organization switcher. Square images look best.">
        <div className="flex items-center gap-3">
          {org.logo ? <img src={org.logo} alt="" className="size-12 rounded-lg object-cover ring-1 ring-zinc-800" /> : <span className="grid size-12 place-items-center rounded-lg bg-violet-500 text-sm font-semibold text-zinc-950">{org.name.slice(0, 2).toUpperCase()}</span>}
          {owner && (
            <>
              <label className="cursor-pointer rounded-md px-3 py-1.5 text-sm ring-1 ring-zinc-700 hover:bg-zinc-900">
                Upload
                <input type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => e.target.files?.[0] && void setLogo(e.target.files[0])} />
              </label>
              {org.logo && (
                <Button variant="ghost" onClick={() => void setLogo(null)}>
                  Remove
                </Button>
              )}
            </>
          )}
        </div>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <input className={inputClass} disabled={!owner} value={name} onChange={(e) => (setName(e.target.value), setSaved(false))} />
        </Field>
        <Field label="Short name" hint="Lowercase letters, digits, and dashes.">
          <input className={`${inputClass} font-mono`} disabled={!owner} value={slug} onChange={(e) => (setSlug(e.target.value.toLowerCase()), setSaved(false))} />
        </Field>
      </div>
      {owner && (
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            disabled={action.busy || (name === org.name && slug === org.slug)}
            onClick={() =>
              action.run(async () => {
                const r = await api.updateOrg(org.id, { name, slug });
                setOrg({ ...org, ...r });
                setSaved(true);
              })
            }
          >
            Save
          </Button>
          {saved && <span className="text-sm text-emerald-400">Saved.</span>}
        </div>
      )}
      <p className="text-xs text-zinc-500">{org.members} member{org.members === 1 ? "" : "s"}. Each organization has its own members, projects, agents, docs, canvases, and integrations.</p>
      {owner && org.id !== DEFAULT_ORG && (
        <section className="space-y-2 rounded-lg border border-red-950 p-4">
          <h2 className="font-medium text-red-300">Delete organization</h2>
          <p className="text-sm text-zinc-400">Signs everyone out of it and stops its agents. Its folder is moved to orgs-deleted in the data folder, where it can still be recovered by hand.</p>
          <Button
            variant="danger"
            onClick={() => {
              if (prompt(`Type the organization's name (${org.name}) to delete it`) !== org.name) return;
              void action.run(async () => {
                await api.deleteOrg(org.id);
                switchOrg(DEFAULT_ORG);
              });
            }}
          >
            Delete {org.name}
          </Button>
        </section>
      )}
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
}
