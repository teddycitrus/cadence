import { Router } from "express";
import { z } from "zod";
import type { Container } from "../container";
import { currentActor } from "../../auth/context";
import { sendAsset } from "./assets";

/** Public, read-only: what a share link shows (no sign-in). */
export function publicShareRoutes(c: Container): Router {
  const r = Router();

  r.get("/:id", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(c.shares.view(req.params.id));
  });

  r.get("/:id/assets/:assetId", (req, res) => {
    sendAsset(c, res, c.shares.docAsset(req.params.id, req.params.assetId));
  });

  /** A shared canvas's frame, rendered (visitors cannot reach the live canvas server). */
  r.get("/:id/story/:storyId", async (req, res) => {
    const s = c.shares.canvasStory(req.params.id, req.params.storyId);
    const png = await c.canvasRender.screenshot(s.workspaceId, s.path, s.storyId);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "private, max-age=60");
    res.end(png);
  });

  return r;
}

const ShareInput = z.object({ kind: z.enum(["doc", "issue", "canvas"]), ref: z.string().min(1).max(700) });

/** Creating and revoking links (signed in). */
export function shareRoutes(c: Container): Router {
  const r = Router();

  r.get("/", (req, res) => {
    const kind = req.query.kind;
    const ref = req.query.ref;
    if (typeof kind === "string" && typeof ref === "string") return void res.json(c.shares.forRef(ShareInput.shape.kind.parse(kind), ref));
    res.json(c.q.shares().filter((s) => !s.revoked));
  });

  r.post("/", (req, res) => {
    const input = ShareInput.parse(req.body);
    res.status(201).json(c.shares.create(input.kind, input.ref, currentActor()));
  });

  r.delete("/:id", (req, res) => {
    c.shares.revoke(req.params.id, currentActor());
    res.json({ ok: true });
  });

  return r;
}
