import { Router } from "express";
import { identityOf } from "../auth-middleware";
import type { Container } from "../container";
import { LabelInput, StageDelete, StageInput, StageOrder, StagePatch } from "../schemas";

/** Org-level board configuration: stages and labels. */
export function boardRoutes(c: Container): Router {
  const r = Router();
  // Stages shape everyone's workflow, so changing them is for the owner and admins.
  r.use("/stages", (req, res, next) => (req.method !== "GET" && identityOf(res).role === "member" ? res.status(403).json({ error: "Only admins can change stages" }) : next()));

  r.post("/stages", (req, res) => {
    res.status(201).json({ id: c.issues.createStage(StageInput.parse(req.body)) });
  });
  r.patch("/stages/:id", (req, res) => {
    c.issues.updateStage(req.params.id, StagePatch.parse(req.body));
    res.json({ ok: true });
  });
  r.post("/stages/reorder", (req, res) => {
    c.issues.reorderStages(StageOrder.parse(req.body).order);
    res.json({ ok: true });
  });
  r.delete("/stages/:id", (req, res) => {
    c.issues.deleteStage(req.params.id, StageDelete.parse(req.body).moveIssuesTo);
    res.json({ ok: true });
  });

  r.post("/labels", (req, res) => {
    res.status(201).json({ id: c.issues.createLabel(LabelInput.parse(req.body)) });
  });
  r.delete("/labels/:id", (req, res) => {
    c.issues.deleteLabel(req.params.id);
    res.json({ ok: true });
  });

  return r;
}
