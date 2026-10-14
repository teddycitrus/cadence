import { Router } from "express";
import { z } from "zod";
import type { Container } from "../container";

const Answer = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tool"), allow: z.boolean(), always: z.boolean().optional(), message: z.string().max(2000).optional() }),
  z.object({ kind: z.literal("plan"), action: z.enum(["approve", "revise", "execute_fresh"]), feedback: z.string().max(10_000).optional() }),
]);

/** Machines this hub can open (owner and admins). */
export function machineRoutes(c: Container): Router {
  const r = Router();

  r.get("/", (_req, res) => {
    res.json(c.machines.list());
  });

  r.post("/", (req, res) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    res.status(201).json(c.machines.add(name));
  });

  r.patch("/:id", (req, res) => {
    res.json(c.machines.rename(req.params.id, z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body).name));
  });

  r.delete("/:id", (req, res) => {
    c.machines.remove(req.params.id);
    res.status(204).end();
  });

  r.post("/:id/open", async (req, res) => {
    res.json({ url: await c.machines.open(req.params.id, req.headers.host) });
  });

  r.get("/:id/summary", async (req, res) => {
    res.json(await c.machines.summary(req.params.id));
  });

  r.post("/:id/workspaces", async (req, res) => {
    const input = z.object({ projectId: z.string().max(100).nullable(), name: z.string().trim().min(1).max(120) }).parse(req.body);
    res.status(201).json(await c.machines.createWorkspace(req.params.id, input));
  });

  r.post("/:id/interactions/:interactionId", async (req, res) => {
    res.json(await c.machines.answer(req.params.id, req.params.interactionId, Answer.parse(req.body)));
  });

  return r;
}
