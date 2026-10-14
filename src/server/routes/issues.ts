import { Router } from "express";
import { z } from "zod";
import type { Container } from "../container";
import { CommentInput, IssueInput, IssuePatch, LinkInput, MoveInput, ToggleAssignee, ToggleLabel } from "../schemas";
import { REACTIONS, type IssueDetail } from "../../core/types";
import { identityOf } from "../auth-middleware";
import { diffAgainst } from "../../git/git";

export function issueRoutes(c: Container): Router {
  const r = Router();

  r.post("/", (req, res) => {
    res.status(201).json(c.issues.createIssue(IssueInput.parse(req.body)));
  });

  /** What happened across the board lately, newest first. */
  r.get("/activity", (_req, res) => {
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const events = c.store.ofTypesSince(["IssueCreated", "IssueMoved", "CommentAdded", "AssigneeAdded", "LabelAdded", "LinkAdded"], since).reverse().slice(0, 150);
    res.json(
      events.flatMap((e) => {
        const issue = c.q.issue(e.aggregateId);
        return issue ? [{ seq: e.seq, type: e.type, payload: e.payload, actor: e.actor, ts: e.ts, issue: { id: issue.id, key: issue.key, title: issue.title } }] : [];
      }),
    );
  });

  r.get("/:id", (req, res) => {
    const issue = c.issues.issueOrThrow(req.params.id);
    const detail: IssueDetail = {
      issue,
      comments: c.q.comments(issue.id),
      timeline: c.store.forAggregate("issue", issue.id),
      runs: c.q.runsForIssue(issue.id),
      docs: c.q.docsForIssue(issue.id),
      workspaces: c.q.workspacesForIssue(issue.id),
    };
    res.json(detail);
  });

  r.patch("/:id", (req, res) => {
    res.json(c.issues.updateIssue(req.params.id, IssuePatch.parse(req.body)));
  });

  r.delete("/:id", (req, res) => {
    c.issues.deleteIssue(req.params.id);
    res.json({ ok: true });
  });

  r.post("/:id/reorder", (req, res) => {
    const input = z.object({ above: z.string().max(100).nullish(), below: z.string().max(100).nullish(), stageId: z.string().max(100).nullish() }).parse(req.body);
    res.json(c.issues.reorderIssue(req.params.id, { above: input.above, below: input.below, stage: input.stageId }));
  });

  r.post("/:id/move", (req, res) => {
    res.json(c.issues.moveIssue(req.params.id, MoveInput.parse(req.body).stageId));
  });

  r.post("/:id/read", (req, res) => {
    c.issues.markRead(req.params.id, identityOf(res).memberId);
    res.json({ ok: true });
  });

  r.post("/:id/duplicate", (req, res) => {
    res.status(201).json(c.issues.duplicateIssue(req.params.id));
  });

  r.post("/:id/undo-auto-move", (req, res) => {
    res.json(c.issues.undoAutoMove(req.params.id));
  });

  r.post("/:id/labels", (req, res) => {
    const input = ToggleLabel.parse(req.body);
    c.issues.setLabel(req.params.id, input.labelId, input.on);
    res.json(c.issues.issueOrThrow(req.params.id));
  });

  r.post("/:id/assignees", (req, res) => {
    const input = ToggleAssignee.parse(req.body);
    c.issues.setAssignee(req.params.id, input.assignee, input.on);
    res.json(c.issues.issueOrThrow(req.params.id));
  });

  r.post("/:id/comments", (req, res) => {
    c.issues.comment(req.params.id, CommentInput.parse(req.body).body);
    res.status(201).json({ ok: true });
  });

  r.patch("/:id/comments/:seq", (req, res) => {
    c.issues.editComment(req.params.id, Number(req.params.seq), CommentInput.parse(req.body).body);
    res.json({ ok: true });
  });

  r.delete("/:id/comments/:seq", (req, res) => {
    c.issues.deleteComment(req.params.id, Number(req.params.seq), identityOf(res).role !== "member");
    res.json({ ok: true });
  });

  r.put("/:id/comments/:seq/reactions/:reaction", (req, res) => {
    const reaction = z.enum(REACTIONS).parse(req.params.reaction);
    c.issues.react(req.params.id, Number(req.params.seq), reaction, z.object({ on: z.boolean() }).parse(req.body).on);
    res.json({ ok: true });
  });

  r.post("/:id/links", (req, res) => {
    res.status(201).json(c.issues.addLink(req.params.id, LinkInput.parse(req.body)));
  });

  r.delete("/:id/links/:linkId", (req, res) => {
    c.issues.removeLink(req.params.id, req.params.linkId);
    res.json({ ok: true });
  });

  r.get("/:id/diff", async (req, res) => {
    const issue = c.issues.issueOrThrow(req.params.id);
    const project = issue.projectId ? c.q.project(issue.projectId) : null;
    if (!project || !issue.worktreePath) {
      res.json({ diff: "" });
      return;
    }
    res.json({ diff: await diffAgainst(issue.worktreePath, project.baseBranch) });
  });

  return r;
}
