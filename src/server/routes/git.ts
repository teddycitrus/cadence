import { currentActor } from "../../auth/context";
import { Router, type Request } from "express";
import { z } from "zod";
import type { Container } from "../container";
import { GitClient } from "../../git/client";
import { ValidationError } from "../../core/errors";
import { GitHunk, GitBranchInput, GitBranchRename, GitCommit, GitPaths, GitPull, GitPush, GitRef, GitRemoteInput, GitStash, GitStashIndex, GitTagInput, PrOpen } from "../schemas";

const COMMIT_SYSTEM =
  "You write git commit messages. Reply with only the message: a subject line under 72 characters in the imperative mood, then, if the change needs it, a blank line and a short body explaining why. No code fences, no quotes, no preamble.";

/** The source-control panel for one workspace, mounted at /api/workspaces/:id/git. */
export function gitRoutes(c: Container): Router {
  const r = Router({ mergeParams: true });

  const client = (req: Request) => {
    const ws = c.workspaces.workspaceOrThrow(String((req.params as Record<string, string>).id));
    if (!ws.branch) throw new ValidationError("This workspace is a scratch folder without git");
    return new GitClient(ws.path);
  };

  /** Every mutation answers with the fresh repository state so the panel redraws at once. */
  const mutate = (fn: (g: GitClient, req: Request) => Promise<unknown>) => async (req: Request, res: import("express").Response) => {
    const g = client(req);
    await fn(g, req);
    const state = await g.state();
    // Switching or renaming the branch here keeps the workspace's record (PRs, canvases, links) in step.
    const ws = c.workspaces.workspaceOrThrow(String((req.params as Record<string, string>).id));
    if (state.branch && state.branch !== ws.branch) c.store.append({ aggregate: "workspace", type: "WorkspaceUpdated", aggregateId: ws.id, payload: { branch: state.branch } });
    res.json(state);
  };

  r.get("/", async (req, res) => {
    const g = client(req);
    const [state, { branches, tags }, remotes, stashes, log] = await Promise.all([g.state(), g.refs(), g.remotes(), g.stashes(), g.log(30)]);
    res.json({ state, branches, remotes, stashes, tags, log });
  });

  r.get("/file-diff", async (req, res) => {
    const path = String(req.query.path ?? "");
    res.json({ diff: await client(req).fileDiff(path, req.query.staged === "true") });
  });

  r.post("/stage", mutate((g, req) => g.stage(GitPaths.parse(req.body).paths)));
  r.post("/stage-all", mutate((g) => g.stageAll()));
  r.post("/unstage", mutate((g, req) => g.unstage(GitPaths.parse(req.body).paths)));
  r.post("/unstage-all", mutate((g) => g.unstageAll()));
  r.post("/discard", mutate((g, req) => g.discard(GitPaths.parse(req.body).paths)));
  r.post("/discard-all", mutate((g) => g.discardAll()));
  r.post("/commit", mutate(async (g, req) => {
    const { sync, ...input } = GitCommit.parse(req.body);
    await g.commit(input);
    if (sync) await g.sync();
  }));
  r.post("/sync", mutate((g) => g.sync()));
  r.post("/stage-hunk", mutate((g, req) => {
    const b = GitHunk.parse(req.body);
    return g.stageHunk(b.path, b.hunk, b.unstage);
  }));
  r.post("/discard-hunk", mutate((g, req) => {
    const b = GitHunk.parse(req.body);
    return g.discardHunk(b.path, b.hunk);
  }));
  r.get("/hunks", async (req, res) => {
    res.json({ hunks: await client(req).hunks(String(req.query.path ?? ""), req.query.staged === "true") });
  });
  r.post("/undo-commit", mutate((g) => g.undoLastCommit()));
  r.post("/branches", mutate((g, req) => {
    const b = GitBranchInput.parse(req.body);
    return g.createBranch(b.name, b.from, b.checkout);
  }));
  r.post("/branches/rename", mutate((g, req) => {
    const b = GitBranchRename.parse(req.body);
    return g.renameBranch(b.from, b.to);
  }));
  r.post("/branches/switch", mutate((g, req) => g.switchBranch(GitRef.parse(req.body).name)));
  r.post("/branches/delete", mutate((g, req) => {
    const b = GitRef.parse(req.body);
    return g.deleteBranch(b.name, b.force);
  }));
  r.post("/remotes", mutate((g, req) => {
    const b = GitRemoteInput.parse(req.body);
    return g.addRemote(b.name, b.url);
  }));
  r.post("/remotes/set-url", mutate((g, req) => {
    const b = GitRemoteInput.parse(req.body);
    return g.setRemoteUrl(b.name, b.url);
  }));
  /** Starts a review of this branch's changes in a new chat, reported as findings. */
  r.post("/review", async (req, res) => {
    const { deep } = z.object({ deep: z.boolean().default(false) }).parse(req.body ?? {});
    const ws = c.workspaces.workspaceOrThrow(String((req.params as Record<string, string>).id));
    const chat = c.engine.createChat({ workspaceId: ws.id, title: deep ? "Deep code review" : "Code review", mode: "default", effort: deep ? "xhigh" : undefined });
    const prompt = [
      `Review the changes on this branch against ${ws.baseBranch ?? "its base branch"} (committed and uncommitted). Do not change any files.`,
      "",
      "Look for real defects: wrong behavior, crashes, security problems (injection, path traversal, secrets), races, data loss, and broken edge cases. Skip style and taste.",
      deep ? "Be thorough: read the surrounding code each change relies on, and trace how changed functions are called before deciding." : "Focus on what the diff touches.",
      "Verify each suspected problem by reading the code (and running it if that is cheap) before reporting it. Drop anything you could not confirm.",
      "",
      "Finish by calling report_findings once with the confirmed findings, worst first (an empty list if there are none), then say in one line what you checked.",
    ].join("\n");
    await c.engine.send(chat.id, { text: prompt }, currentActor());
    res.status(201).json({ chatId: chat.id });
  });

  r.post("/remotes/remove", mutate((g, req) => g.removeRemote(GitRef.parse(req.body).name)));
  r.post("/remotes/rename", mutate((g, req) => {
    const b = z.object({ name: z.string().min(1).max(100), newName: z.string().min(1).max(100) }).parse(req.body);
    return g.renameRemote(b.name, b.newName);
  }));
  /** Creates the repository on GitHub, adds it as a remote, and pushes the current branch to it. */
  r.post("/remotes/github", async (req, res) => {
    const b = z.object({ name: z.string().trim().min(1).max(100), owner: z.string().trim().max(39).nullable().default(null), private: z.boolean().default(true), description: z.string().max(300).default(""), remote: z.string().min(1).max(100).default("origin") }).parse(req.body);
    const g = client(req);
    if ((await g.remotes()).some((r) => r.name === b.remote)) throw new ValidationError(`There is already a remote named ${b.remote}`);
    const repo = await (await c.prs.api()).createRepository({ name: b.name, owner: b.owner || null, private: b.private, description: b.description });
    await g.addRemote(b.remote, repo.cloneUrl);
    let pushed = true;
    try {
      await g.push(false);
    } catch {
      pushed = false;
    }
    res.status(201).json({ ...repo, pushed });
  });
  r.post("/fetch", mutate((g) => g.fetch()));
  r.post("/pull", mutate((g, req) => g.pull(GitPull.parse(req.body ?? {}).rebase)));
  r.post("/push", mutate((g, req) => g.push(GitPush.parse(req.body ?? {}).force)));
  r.post("/abort", mutate((g) => g.abortOperation()));
  r.post("/stash", mutate((g, req) => {
    const b = GitStash.parse(req.body ?? {});
    return g.stash(b.message, b.includeUntracked);
  }));
  r.post("/stash/pop", mutate((g, req) => g.stashPop(GitStashIndex.parse(req.body).index)));
  r.post("/stash/drop", mutate((g, req) => g.stashDrop(GitStashIndex.parse(req.body).index)));
  r.post("/tags", mutate((g, req) => {
    const b = GitTagInput.parse(req.body);
    return g.createTag(b.name, b.message);
  }));
  r.post("/tags/delete", mutate((g, req) => g.deleteTag(GitRef.parse(req.body).name)));

  /** Drafts a commit message from the staged diff (or all changes when nothing is staged). */
  r.post("/commit-message", async (req, res) => {
    const g = client(req);
    const diff = await g.diffForMessage();
    if (!diff.trim()) throw new ValidationError("There are no changes to describe");
    const message = await c.defaultRuntime().complete(`Write a commit message for this diff:\n\n${diff}`, { cwd: g.dir, model: c.q.settings().defaultModel, system: COMMIT_SYSTEM });
    res.json({ message });
  });

  r.get("/pr", async (req, res) => {
    res.json({ pullRequest: await c.prs.forWorkspace(String((req.params as Record<string, string>).id)) });
  });

  r.post("/pr", async (req, res) => {
    res.status(201).json(await c.prs.open(String((req.params as Record<string, string>).id), PrOpen.parse(req.body), currentActor()));
  });

  return r;
}
