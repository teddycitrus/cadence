import { currentActor } from "../../auth/context";
import { estimateTriggers, scheduleStatus } from "../../runner/estimates";
import { Router, type Response } from "express";
import { z } from "zod";
import type { Container } from "../container";
import { AgentInput, AgentPatchInput, CronFromText } from "../schemas";
import { ForbiddenError, NotFoundError, ValidationError } from "../../core/errors";
import { agentAccess, agentForViewer } from "../../core/agent-commands";
import type { Agent } from "../../core/types";
import { identityOf } from "../auth-middleware";
import { findTemplate } from "../../agents/templates";
import { describeError } from "../../agents/anthropic-llm";
import { isValidCron, nextRun } from "../../runner/scheduler";
import { structuredAnswer } from "../../agents/structured";

const RunNowInput = z.object({ issueId: z.string().max(100).nullish(), note: z.string().max(10_000).optional() });
const CronResult = z.object({ cron: z.string(), description: z.string() });

export function agentRoutes(c: Container): Router {
  const r = Router();

  const checkSchedules = (triggers: { kind: string; cron?: string }[] | undefined) => {
    for (const t of triggers ?? []) {
      if (t.kind === "schedule" && !isValidCron(t.cron ?? "")) throw new ValidationError(`"${t.cron}" is not a valid 5-field cron expression`);
    }
  };

  r.post("/", (req, res) => {
    const input = AgentInput.parse(req.body);
    checkSchedules(input.triggers);
    res.status(201).json(c.agents.createAgent(input));
  });

  r.post("/from-template/:templateId", (req, res) => {
    const template = findTemplate(req.params.templateId);
    if (!template) throw new NotFoundError(`Template ${req.params.templateId} not found`);
    let name = template.name;
    for (let n = 2; c.q.agent(name); n++) name = `${template.name} ${n}`;
    const { id, needs: _needs, ...definition } = template;
    res.status(201).json(c.agents.createAgent({ ...definition, name, templateId: id, enabled: false }));
  });

  /** The agent, if the person behind this request may change and run it. */
  const managed = (res: Response, id: string): Agent => {
    const agent = c.agents.agentOrThrow(id);
    const access = agentAccess(agent, identityOf(res));
    if (!access.read) throw new NotFoundError(`Agent ${id} not found`);
    if (!access.manage) throw new ForbiddenError(`Only ${c.q.member(agent.ownerId)?.name ?? "its owner"} or an admin can change "${agent.name}"; copy it to make your own`);
    return agent;
  };

  r.get("/:id", (req, res) => {
    const agent = c.agents.agentOrThrow(req.params.id);
    if (!agentAccess(agent, identityOf(res)).read) throw new NotFoundError(`Agent ${req.params.id} not found`);
    res.json(agentForViewer(agent, identityOf(res)));
  });

  r.patch("/:id", (req, res) => {
    const patch = AgentPatchInput.parse(req.body);
    checkSchedules(patch.triggers);
    const agent = managed(res, req.params.id);
    // Making an agent private hides it from the team, so only its owner may.
    if (patch.visibility === "private" && agent.visibility === "public" && agent.ownerId !== identityOf(res).memberId) throw new ForbiddenError("Only the agent's owner can make it private");
    // Who may edit it is the owner's (or an admin's) call, not an editor's.
    if (patch.publicAccess !== undefined && patch.publicAccess !== (agent.publicAccess ?? "view") && !agentAccess(agent, identityOf(res)).own) throw new ForbiddenError("Only the agent's owner or an admin can change who may edit it");
    res.json(c.agents.updateAgent(agent.id, patch));
  });

  r.post("/:id/copy", (req, res) => {
    const agent = c.agents.agentOrThrow(req.params.id);
    if (!agentAccess(agent, identityOf(res)).read) throw new NotFoundError(`Agent ${req.params.id} not found`);
    res.status(201).json(c.agents.copyAgent(agent.id));
  });

  r.post("/:id/enable", (req, res) => {
    c.agents.setEnabled(managed(res, req.params.id).id, true);
    res.json(c.agents.agentOrThrow(req.params.id));
  });

  r.post("/:id/disable", (req, res) => {
    c.agents.setEnabled(managed(res, req.params.id).id, false);
    res.json(c.agents.agentOrThrow(req.params.id));
  });

  r.delete("/:id", (req, res) => {
    const agent = managed(res, req.params.id);
    if (!agentAccess(agent, identityOf(res)).own) throw new ForbiddenError(`Only ${c.q.member(agent.ownerId)?.name ?? "its owner"} or an admin can delete "${agent.name}"`);
    c.agents.deleteAgent(agent.id);
    res.json({ ok: true });
  });

  /** Start a run by hand, optionally about one issue. */
  /** When each schedule fires next and last fired, and how often each trigger is likely to run. */
  r.get("/:id/triggers/status", (req, res) => {
    const agent = c.agents.agentOrThrow(req.params.id);
    res.json({ schedules: scheduleStatus(agent, c.q), estimates: estimateTriggers(agent, c.store, c.q) });
  });

  r.post("/:id/run", (req, res) => {
    const input = RunNowInput.parse(req.body);
    const agent = managed(res, req.params.id);
    const issue = input.issueId ? c.issues.issueOrThrow(input.issueId) : null;
    const runId = c.agents.queueRun({ agentId: agent.id, issueId: issue?.id ?? null, trigger: "manual", context: input.note ?? "" }, currentActor());
    res.status(202).json({ runId, queuedWhileDisabled: !agent.enabled });
  });

  /** Turns "weekdays at 9am" into a cron expression. */
  r.post("/cron-from-text", async (req, res) => {
    const { text } = CronFromText.parse(req.body);
    if (isValidCron(text)) {
      res.json({ cron: text, description: text, next: nextRun(text) });
      return;
    }
    try {
      const settings = c.q.settings();
      const out = await structuredAnswer({ llm: c.llm, providers: c.providers, runtime: c.defaultRuntime, cwd: c.dataDir }, {
        model: settings.defaultModel,
        effort: "low",
        system: `Convert a schedule described in plain English into a standard 5-field cron expression (minute hour day-of-month month day-of-week) in the user's local time zone. Also return a short human description. Today is ${new Date().toDateString()}.`,
        prompt: text,
        schema: CronResult,
      });
      if (!isValidCron(out.cron)) throw new ValidationError("Could not turn that into a valid schedule; try a cron expression");
      res.json({ ...out, next: nextRun(out.cron) });
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(describeError(err));
    }
  });

  return r;
}
