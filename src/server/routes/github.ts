import { currentActor } from "../../auth/context";
import { Router } from "express";
import type { Container } from "../container";
import { NotFoundError, ValidationError } from "../../core/errors";
import { isValidGithubRepo, verifyToken } from "../../git/github";
import { pullRequestInsights } from "../../git/insights";
import { GithubToken, PrTrack } from "../schemas";

/** Pull requests Cadence follows, the GitHub connection, and PR insights. */
export function githubRoutes(c: Container): Router {
  const r = Router();

  r.get("/prs", (_req, res) => {
    res.json(c.q.pullRequests());
  });

  r.post("/prs", async (req, res) => {
    const input = PrTrack.parse(req.body);
    res.status(201).json(await c.prs.track(input.url, input.issueId, null, currentActor()));
  });

  r.post("/prs/:id/refresh", async (req, res) => {
    const id = decodeURIComponent(req.params.id);
    await c.prs.refresh(id);
    const pr = c.q.pullRequest(id);
    if (!pr) throw new NotFoundError("Pull request not tracked");
    res.json(pr);
  });

  r.get("/github", async (_req, res) => {
    const source = await c.github.source();
    res.json({ connected: source !== null, source });
  });

  /** Saves (or clears) a personal access token. It is stored server-side and never returned. */
  r.put("/github/token", async (req, res) => {
    const { token } = GithubToken.parse(req.body);
    if (token) await verifyToken(token, c.fetchImpl);
    c.github.save(token || null);
    const source = await c.github.source();
    res.json({ connected: source !== null, source });
  });

  r.get("/github/insights", async (req, res) => {
    const repo = String(req.query.repo ?? "");
    if (!isValidGithubRepo(repo)) throw new ValidationError("Pass repo as owner/name");
    const days = Math.min(Math.max(Number(req.query.days ?? 30) || 30, 1), 365);
    const prs = await (await c.prs.api()).recentPullRequests(repo);
    res.json(pullRequestInsights(prs, days, new Date()));
  });

  return r;
}
