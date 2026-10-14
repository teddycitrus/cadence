import express, { Router } from "express";
import type { Container } from "../container";
import { NotFoundError } from "../../core/errors";
import { verifyGithubSignature } from "../../runner/triggers";

// Inbound integrations. These authenticate with per-trigger secrets instead of
// the API token, so they are mounted before the token check.
export function hookRoutes(c: Container): Router {
  const r = Router();

  // Any tool can POST JSON or text here; the body becomes the run's context.
  r.post("/agents/:agentId/:secret", express.text({ type: ["text/*"], limit: "1mb" }), express.json({ limit: "1mb" }), (req, res) => {
    const runId = c.triggers.fireWebhook(req.params.agentId, req.params.secret, req.body);
    res.status(202).json({ runId });
  });

  // GitHub webhook: verify X-Hub-Signature-256 over the raw body.
  r.post("/github/:agentId", express.raw({ type: "application/json", limit: "5mb" }), (req, res) => {
    const secret = c.triggers.githubSecretFor(req.params.agentId);
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    if (!secret || !verifyGithubSignature(secret, raw, req.header("x-hub-signature-256"))) throw new NotFoundError("Unknown webhook");
    const event = req.header("x-github-event") ?? "";
    if (event === "ping") {
      res.json({ ok: true });
      return;
    }
    const runId = c.triggers.fireGithub(req.params.agentId, event, JSON.parse(raw.toString("utf8")) as Record<string, unknown>);
    res.status(202).json({ runId });
  });

  return r;
}
