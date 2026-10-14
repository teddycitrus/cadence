import { Router } from "express";
import { isAbsolute, resolve } from "node:path";
import type { Container } from "../container";
import { ProjectInput, ProjectPatch, ScriptsInput } from "../schemas";
import { identityOf } from "../auth-middleware";
import { scriptsFor } from "../../projects/scripts";
import { NotFoundError } from "../../core/errors";
import { ConflictError, ValidationError } from "../../core/errors";
import { currentBranch, isGitRepo } from "../../git/git";

export function projectRoutes(c: Container): Router {
  const r = Router();

  r.post("/", async (req, res) => {
    const input = ProjectInput.parse(req.body);
    if (!isAbsolute(input.path)) throw new ValidationError("Use an absolute path to a local git repository");
    const path = resolve(input.path);
    if (!(await isGitRepo(path))) throw new ValidationError(`${path} is not a git repository`);
    if (c.q.projects().some((p) => resolve(p.path) === path)) throw new ConflictError("That repository is already a project");
    const baseBranch = input.baseBranch || (await currentBranch(path));
    res.status(201).json(c.agents.addProject({ ...input, path, baseBranch }));
  });

  r.patch("/:id", (req, res) => {
    res.json(c.agents.updateProject(req.params.id, ProjectPatch.parse(req.body)));
  });

  /** Shared scripts plus the caller's own. */
  r.get("/:id/scripts", (req, res) => {
    const project = c.q.project(req.params.id);
    if (!project) throw new NotFoundError(`Project ${req.params.id} not found`);
    res.json(scriptsFor(project, identityOf(res).memberId));
  });

  /** Members may change their own scripts; shared ones need the owner or an admin. */
  r.put("/:id/scripts", (req, res) => {
    const input = ScriptsInput.parse(req.body);
    const who = identityOf(res);
    const patch = { ...(input.setupScript !== undefined ? { setupScript: input.setupScript } : {}), ...(input.commands ? { commands: input.commands } : {}) };
    if (input.scope === "org") {
      if (who.role === "member") throw new ValidationError("Only the owner and admins can change shared scripts");
      c.agents.updateProject(req.params.id, patch);
    } else {
      if (!who.memberId) throw new ValidationError("Sign in to keep personal scripts");
      c.agents.setPersonalScripts(req.params.id, who.memberId, patch);
    }
    res.json(scriptsFor(c.q.project(req.params.id)!, who.memberId));
  });

  r.delete("/:id", (req, res) => {
    c.agents.removeProject(req.params.id);
    res.json({ ok: true });
  });

  return r;
}
