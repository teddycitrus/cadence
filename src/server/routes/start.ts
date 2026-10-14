import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Router } from "express";
import { z } from "zod";
import { currentActor } from "../../auth/context";
import { CHAT_MODES, EFFORTS } from "../../core/types";
import { PROVIDER_IDS } from "../../core/providers";
import { ConflictError, ValidationError } from "../../core/errors";
import { currentBranch, git } from "../../git/git";
import { cloneRepo, NotGitError, openFolder, scaffoldProject } from "../../projects/starter";
import { starterPrompt } from "../../projects/templates";
import { STARTER_TASK_INFO, STARTER_TASKS, starterTaskPrompt } from "../../projects/starter-tasks";
import type { Container } from "../container";
import { checkRequirements } from "../../projects/requirements";
import { modelAccess } from "../../agents/model-access";
import { installToolchain } from "../../projects/node-toolchain";
import { WELCOME_ANSWER, WELCOME_QUESTION, writeWelcomeCanvas } from "../../projects/welcome";

const ImportInput = z.object({ url: z.string().trim().min(5).max(500), name: z.string().trim().max(80).optional(), parent: z.string().trim().max(1000).optional() });
const OpenInput = z.object({ path: z.string().trim().min(1).max(1000), initialize: z.boolean().default(false) });
const GenerateInput = z.object({
  kind: z.enum(["mockup", "prototype", "blank"]),
  idea: z.string().trim().max(20_000).default(""),
  name: z.string().trim().max(80).optional(),
  provider: z.enum(PROVIDER_IDS).optional(),
  model: z.string().regex(/^[A-Za-z0-9._:/@[\]-]{1,120}$/).optional(),
  effort: z.enum(EFFORTS).optional(),
  mode: z.enum(CHAT_MODES).default("acceptEdits"),
});

/** A short project name from the idea's first words. */
function nameFrom(idea: string): string {
  const words = idea.replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 5);
  return words.length ? words.join(" ").slice(0, 60) : "New project";
}

/** The home page's three ways in: generate a project, open a folder, import a repository. */
export function startRoutes(c: Container): Router {
  const r = Router();

  const addProject = async (path: string, name: string, setupScript: string | null = null) => {
    if (c.q.projects().some((p) => resolve(p.path) === resolve(path))) throw new ConflictError("That repository is already a project");
    return c.agents.addProject({ name, path, baseBranch: await currentBranch(path), githubRepo: null, setupScript });
  };

  r.post("/import", async (req, res) => {
    const input = ImportInput.parse(req.body);
    // Into a folder of the person's choosing, or Cadence's own repos folder.
    let parent = join(c.dataDir, "repos");
    if (input.parent) {
      if (!isAbsolute(input.parent) || !existsSync(input.parent) || !statSync(input.parent).isDirectory()) throw new ValidationError("Pick an existing folder (a full path) to clone into");
      parent = input.parent;
    }
    const dir = await cloneRepo(parent, input.url, input.name);
    const project = await addProject(dir, input.name || dir.split(/[\\/]/).pop()!);
    res.status(201).json(project);
  });

  r.post("/open", async (req, res) => {
    const input = OpenInput.parse(req.body);
    if (!isAbsolute(input.path)) throw new ValidationError("Use the folder's full path");
    try {
      const { path } = await openFolder(resolve(input.path), { initialize: input.initialize });
      res.status(201).json(await addProject(path, path.split(/[\\/]/).pop() || "Project"));
    } catch (err) {
      if (err instanceof NotGitError) return void res.status(409).json({ error: err.message, needsInit: true });
      throw err;
    }
  });

  /** Makes a project, a workspace in it, and a chat with the agent already building. */
  r.post("/generate", async (req, res) => {
    const input = GenerateInput.parse(req.body);
    if (input.kind !== "blank" && !input.idea) throw new ValidationError("Describe what to make");
    const name = input.name || nameFrom(input.idea);
    const dir = await scaffoldProject(join(c.dataDir, "projects"), input.kind, name);
    // Every workspace of a prototype gets its dependencies.
    const project = await addProject(dir, name, input.kind === "prototype" ? "npm install --no-audit --no-fund" : null);
    const ws = await c.workspaces.createInProject(project.id, input.kind === "blank" ? "Start" : `First ${input.kind}`, currentActor());
    const chat = c.engine.createChat({ workspaceId: ws.id, title: name, provider: input.provider, model: input.model, effort: input.effort, mode: input.mode });
    await c.engine.send(chat.id, { text: starterPrompt(input.kind, input.idea) }, currentActor());
    res.status(201).json({ projectId: project.id, workspaceId: ws.id, chatId: chat.id });
  });

  /** Onboarding's first tasks: each opens its own workspace in a project with an agent on it. */
  r.get("/tasks", (_req, res) => {
    res.json(STARTER_TASK_INFO);
  });

  /** The prompt a first task will send, to read or edit before starting it. */
  r.get("/tasks/:task/prompt", (req, res) => {
    const task = z.enum(STARTER_TASKS).parse(req.params.task);
    res.json({ prompt: starterTaskPrompt(task, String(req.query.note ?? "").slice(0, 10_000)) });
  });

  /** The first-run tour: a Welcome workspace, its opening exchange, and the tour canvas beside it. */
  /** Whether this machine has Node, Git, and a model for agents (first-run setup checks these). */
  r.get("/requirements", async (_req, res) => {
    res.json(await checkRequirements(undefined, () => modelAccess(c.providers)));
  });

  /** Installs Node.js into Cadence's data folder for machines without one. */
  r.post("/requirements/node", async (_req, res) => {
    const version = await installToolchain(c.dataDir);
    res.json({ version, requirements: await checkRequirements(undefined, () => modelAccess(c.providers)) });
  });

  r.post("/welcome", async (req, res) => {
    const { projectId } = z.object({ projectId: z.string().max(100).nullish() }).parse(req.body ?? {});
    if (projectId && !c.q.project(projectId)) throw new ValidationError("Pick a project");
    // Without a project named, the tour runs in the first one (or a scratch folder).
    const ws = await c.workspaces.createInProject(projectId ?? c.q.projects()[0]?.id ?? null, "Welcome", currentActor());
    // A scratch folder has no git, and canvases are found through git.
    if (!ws.branch) await git(ws.path, ["init", "-q"]);
    const canvasPath = writeWelcomeCanvas(ws.path);
    const chat = c.engine.createChat({ workspaceId: ws.id, title: "Welcome" });
    c.engine.seed(chat.id, [
      { kind: "user", text: WELCOME_QUESTION, attachments: [], author: currentActor(), steer: false },
      { kind: "assistant", text: WELCOME_ANSWER },
    ]);
    res.status(201).json({ workspaceId: ws.id, chatId: chat.id, canvasPath });
  });

  r.post("/tasks", async (req, res) => {
    const input = z
      .object({ task: z.enum(STARTER_TASKS), projectId: z.string().max(100), note: z.string().max(10_000).default(""), prompt: z.string().trim().max(50_000).optional(), model: z.string().max(100).optional(), effort: z.enum(EFFORTS).optional() })
      .parse(req.body);
    const info = STARTER_TASK_INFO.find((t) => t.id === input.task)!;
    if (info.needsNote && !input.note.trim() && !input.prompt) throw new ValidationError("Describe the feature to spec");
    if (!c.q.project(input.projectId)) throw new ValidationError("Pick a project");
    const ws = await c.workspaces.createInProject(input.projectId, info.title, currentActor());
    const chat = c.engine.createChat({ workspaceId: ws.id, title: info.title, mode: "acceptEdits", model: input.model, effort: input.effort });
    await c.engine.send(chat.id, { text: input.prompt || starterTaskPrompt(input.task, input.note) }, currentActor());
    res.status(201).json({ workspaceId: ws.id, chatId: chat.id });
  });

  return r;
}
