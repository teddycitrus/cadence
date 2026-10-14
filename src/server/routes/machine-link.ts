import express, { Router } from "express";
import { z } from "zod";
import type { MachineLink } from "../../machines/link";
import type { RequestIdentity } from "../../auth/context";
import type { IncomingMessage } from "node:http";

/**
 * This machine's connection to a hub. It belongs to the whole Cadence
 * install, not one org, so only the default org's owner may change it.
 */
export function machineLinkRoutes(link: MachineLink, who: (req: IncomingMessage) => RequestIdentity | null): Router {
  const r = Router();
  r.use(express.json());
  r.use((req, res, next) => {
    if (who(req)?.role !== "owner") {
      res.status(403).json({ error: "Only the owner can connect this machine to a hub." });
      return;
    }
    next();
  });

  r.get("/", (_req, res) => {
    res.json(link.current());
  });

  r.put("/", (req, res, next) => {
    try {
      const input = z.object({ hubUrl: z.string().trim().min(1).max(500), token: z.string().trim().min(1).max(300) }).parse(req.body);
      res.json(link.set(input));
    } catch (err) {
      next(err);
    }
  });

  r.delete("/", (_req, res) => {
    res.json(link.clear());
  });

  r.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: err instanceof z.ZodError ? (err.issues[0]?.message ?? "Invalid input") : err.message });
  });

  return r;
}
