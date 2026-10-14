import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors";

export interface Org {
  id: string;
  name: string;
  /** Short name for URLs and share links. */
  slug: string;
  /** Folder with the org's database, secrets, and workspaces. */
  dir: string;
  /** An image asset in the org's own store, shown in the switcher. */
  logo?: string | null;
  createdAt: string;
}

/** The org that lives in the data dir itself, so data from before orgs existed is its data. */
export const DEFAULT_ORG = "default";

const SLUG = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "org";

/**
 * Organizations on this Cadence. Each has its own folder (event log, members,
 * secrets, workspaces), so nothing crosses between them. The list is kept in
 * orgs.json in the data dir.
 */
export class OrgRegistry {
  private file: string;

  constructor(private dataDir: string) {
    this.file = join(dataDir, "orgs.json");
  }

  private read(): Org[] {
    const saved = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Org[]) : [];
    if (saved.some((o) => o.id === DEFAULT_ORG)) return saved;
    return [{ id: DEFAULT_ORG, name: "My organization", slug: "my-org", dir: this.dataDir, createdAt: new Date(0).toISOString() }, ...saved];
  }

  private write(list: Org[]): void {
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(list, null, 2));
    renameSync(tmp, this.file);
  }

  list(): Org[] {
    return this.read();
  }

  get(id: string): Org | null {
    return this.read().find((o) => o.id === id) ?? null;
  }

  getOrThrow(id: string): Org {
    const org = this.get(id);
    if (!org) throw new NotFoundError(`Organization ${id} not found`);
    return org;
  }

  bySlug(slug: string): Org | null {
    return this.read().find((o) => o.slug === slug) ?? null;
  }

  create(name: string, slug?: string): Org {
    const list = this.read();
    const clean = name.trim().slice(0, 60);
    if (!clean) throw new ValidationError("Give the organization a name");
    let s = slug ? slug.trim().toLowerCase() : slugify(clean);
    if (!SLUG.test(s)) throw new ValidationError("Slugs are 2 to 40 lowercase letters, digits, and dashes");
    if (slug && list.some((o) => o.slug === s)) throw new ConflictError(`The slug "${s}" is taken`);
    for (let n = 2; list.some((o) => o.slug === s); n++) s = `${slugify(clean).slice(0, 36)}-${n}`;
    const id = randomUUID();
    const org: Org = { id, name: clean, slug: s, dir: join(this.dataDir, "orgs", id), createdAt: new Date().toISOString() };
    mkdirSync(org.dir, { recursive: true });
    this.write([...list, org]);
    return org;
  }

  update(id: string, patch: { name?: string; slug?: string; logo?: string | null }): Org {
    const list = this.read();
    const org = list.find((o) => o.id === id);
    if (!org) throw new NotFoundError(`Organization ${id} not found`);
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new ValidationError("Give the organization a name");
      org.name = patch.name.trim().slice(0, 60);
    }
    if (patch.slug !== undefined) {
      const s = patch.slug.trim().toLowerCase();
      if (!SLUG.test(s)) throw new ValidationError("Slugs are 2 to 40 lowercase letters, digits, and dashes");
      if (list.some((o) => o.slug === s && o.id !== id)) throw new ConflictError(`The slug "${s}" is taken`);
      org.slug = s;
    }
    if (patch.logo !== undefined) org.logo = patch.logo;
    this.write(list);
    return org;
  }

  /**
   * Removes an org from the list and moves its folder to orgs-deleted/, so a
   * mistake can still be undone by hand. The default org cannot be deleted.
   */
  remove(id: string): void {
    if (id === DEFAULT_ORG) throw new ValidationError("The first organization holds this Cadence's own data and cannot be deleted");
    const list = this.read();
    const org = list.find((o) => o.id === id);
    if (!org) throw new NotFoundError(`Organization ${id} not found`);
    this.write(list.filter((o) => o.id !== id));
    if (existsSync(org.dir)) {
      const trash = join(this.dataDir, "orgs-deleted");
      mkdirSync(trash, { recursive: true });
      renameSync(org.dir, join(trash, `${org.slug}-${Date.now()}`));
    }
  }
}
