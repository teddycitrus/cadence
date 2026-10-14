import { Router } from "express";
import type { Container } from "../container";
import { NotFoundError } from "../../core/errors";
import { currentActor } from "../../auth/context";

export function runRoutes(c: Container): Router {
  const r = Router();

  r.get("/:id", (req, res) => {
    const run = c.q.run(req.params.id);
    if (!run) throw new NotFoundError(`Run ${req.params.id} not found`);
    res.json(run);
  });

  /** Every queued run (or one agent's) is cancelled; running ones finish. */
  r.post("/cancel-queued", (req, res) => {
    const agentId = typeof req.body?.agentId === "string" ? req.body.agentId : null;
    res.json({ cancelled: c.queue.cancelQueued(agentId, currentActor()) });
  });

  r.post("/:id/retry", (req, res) => {
    res.status(201).json({ runId: c.queue.retry(req.params.id, currentActor()) });
  });

  r.post("/:id/cancel", (req, res) => {
    c.queue.cancel(req.params.id);
    res.json({ ok: true });
  });

  return r;
}
