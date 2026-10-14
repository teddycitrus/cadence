import express, { Router, type Request, type Response } from "express";
import { z } from "zod";
import { ZodError } from "zod";
import { ConflictError, NotFoundError, ValidationError } from "../../core/errors";
import { DEFAULT_ORG } from "../../orgs/registry";
import { identify, type AuthOptions } from "../auth-middleware";
import { orgOf, type OrgEntry, type OrgHost } from "../org-host";

const OrgInput = z.object({ name: z.string().trim().min(1).max(60), slug: z.string().trim().max(40).optional() });
const OrgPatch = z.object({ name: z.string().trim().min(1).max(60), slug: z.string().trim().max(40), logo: z.string().max(100).nullable() }).partial();
/** The logo as an image URL that names its org, so any org's page can show it. */
const logoUrl = (o: { id: string; logo?: string | null }) => (o.logo ? `/api/assets/${o.logo}?org=${encodeURIComponent(o.id)}` : null);

/**
 * /api/orgs, outside any one org: the orgs a person can open, and creating,
 * renaming, and deleting them. Creating one runs it on this machine, so only
 * the owner of the first org can; each org's own owner renames or deletes it.
 */
export function orgRoutes(host: OrgHost, o: AuthOptions): Router {
  const r = Router();
  r.use(express.json({ limit: "100kb" }));
  const who = (req: Request, e: OrgEntry) => identify(req, e.container.auth, { ...o, cookie: e.cookie });
  const ownerOf = (req: Request, e: OrgEntry) => who(req, e)?.role === "owner";

  r.get("/", (req, res) => {
    const current = orgOf(req);
    const visible = host.all().flatMap((e) => {
      const id = who(req, e);
      if (!id) return [];
      // Activity in other orgs shows on the switcher: chats running there, and unread ones.
      const chats = e.container.q.chats().filter((ch) => !ch.archived);
      return [{ id: e.org.id, name: e.org.name, slug: e.org.slug, logo: logoUrl(e.org), role: id.role, current: e.org.id === current, members: e.container.q.members().length, running: chats.filter((ch) => ch.status === "running").length, unread: chats.filter((ch) => ch.unread).length }];
    });
    res.json(visible);
  });

  r.post("/", (req, res) => {
    const first = host.get(DEFAULT_ORG)!;
    if (!ownerOf(req, first)) return void res.status(403).json({ error: "Only this Cadence's owner can create organizations" });
    const input = OrgInput.parse(req.body);
    const e = host.create(input.name, input.slug);
    res.status(201).json({ id: e.org.id, name: e.org.name, slug: e.org.slug, role: "owner", current: false, members: e.container.q.members().length });
  });

  const entry = (req: Request, res: Response): OrgEntry | null => {
    const e = host.get(String(req.params.id));
    if (!e || !who(req, e)) {
      res.status(404).json({ error: "Organization not found" });
      return null;
    }
    if (!ownerOf(req, e)) {
      res.status(403).json({ error: "Only the organization's owner can change it" });
      return null;
    }
    return e;
  };

  r.patch("/:id", (req, res) => {
    const e = entry(req, res);
    if (!e) return;
    const patch = OrgPatch.parse(req.body);
    if (patch.logo) {
      const asset = e.container.q.asset(patch.logo);
      if (!asset || !/^image\/(png|jpeg|gif|webp)$/.test(asset.mediaType)) return void res.status(400).json({ error: "The logo must be a PNG, JPEG, GIF, or WebP image uploaded to this organization" });
    }
    const org = host.registry.update(e.org.id, patch);
    // The host keeps its own copy of the record; keep it in step.
    Object.assign(e.org, org);
    res.json({ id: org.id, name: org.name, slug: org.slug, logo: logoUrl(org) });
  });

  r.delete("/:id", (req, res) => {
    const e = entry(req, res);
    if (!e) return;
    host.remove(e.org.id);
    res.json({ ok: true });
  });

  r.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    if (err instanceof ZodError) res.status(400).json({ error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    else if (err instanceof ValidationError) res.status(400).json({ error: err.message });
    else if (err instanceof ConflictError) res.status(409).json({ error: err.message });
    else if (err instanceof NotFoundError) res.status(404).json({ error: err.message });
    else res.status(500).json({ error: "Internal server error" });
  });
  return r;
}
