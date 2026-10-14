import { afterEach, describe, expect, it } from "vitest";
import { estimateTriggers, scheduleStatus } from "../src/runner/estimates";
import type { FakeRuntime } from "./helpers/fake-runtime";
import { until } from "./helpers/fake-runtime";
import { bootTeam } from "./helpers/team";

describe("run tools", () => {
  let close = () => {};
  afterEach(() => {
    close();
    close = () => {};
  });

  it("retries failed runs with their context and cancels queued ones", async () => {
    const team = await bootTeam();
    close = team.close;
    const { c } = team;
    const runtime = c.runtime as FakeRuntime;
    const agent = c.agents.createAgent({ name: "Fixer", prompt: "Fix", enabled: true, triggers: [{ kind: "assigned" }] });
    runtime.forAgent("Fixer", async () => {
      throw new Error("the build broke");
    });
    const first = c.agents.queueRun({ agentId: agent.id, issueId: null, trigger: "manual", context: "Fix the login" })!;
    c.queue.tick();
    await until(() => c.q.run(first)?.status === "failed");

    expect((await team.local("POST", `/runs/${first}/retry`)).status).toBe(201);
    const retried = c.q.runs().find((r) => r.id !== first)!;
    expect(retried).toMatchObject({ agentId: agent.id, trigger: "manual" });
    expect(retried.context).toContain("failed with: the build broke");
    expect(retried.context).toContain("Fix the login");
    await until(() => c.q.run(retried.id)?.status === "failed");

    // Queued runs, all at once; nothing running is touched.
    c.agents.setEnabled(agent.id, false);
    for (const n of [1, 2, 3]) c.agents.queueRun({ agentId: agent.id, issueId: null, trigger: "manual", context: `job ${n}`, threadKey: `t${n}` });
    expect(c.q.runs().filter((r) => r.status === "queued")).toHaveLength(3);
    expect((await team.local("POST", "/runs/cancel-queued", { agentId: agent.id })).json).toEqual({ cancelled: 3 });
    expect(c.q.runs().filter((r) => r.status === "queued")).toHaveLength(0);
    expect((await team.local("POST", `/runs/${retried.id}/retry`)).status).toBe(201);
    const running = c.q.runs().find((r) => r.status === "queued")!;
    expect((await team.local("POST", `/runs/${running.id}/retry`)).status).toBe(409);
  });

  it("shows when schedules fire and estimates how often triggers run", async () => {
    const team = await bootTeam();
    close = team.close;
    const { c } = team;
    const stage = c.q.stages()[0]!;
    const label = c.issues.createLabel({ name: "bug", color: "#f00" });
    const agent = c.agents.createAgent({
      name: "Watcher",
      prompt: "Watch",
      enabled: false,
      triggers: [
        { kind: "schedule", cron: "0 9 * * 1-5", description: "Weekdays", timezone: "UTC" },
        { kind: "issue_created", stageIds: [stage.id], types: ["bug"] },
        { kind: "label_added", labelIds: [label] },
        { kind: "webhook", secret: "s".repeat(32) },
      ],
    });
    for (const n of [1, 2, 3, 4]) {
      const issue = c.issues.createIssue({ title: `Bug ${n}`, body: "", type: n < 4 ? "bug" : "feature", priority: "low", stageId: stage.id }, "user");
      if (n === 1) c.issues.setLabel(issue.id, label, true, "user");
    }
    const [sched] = scheduleStatus(c.q.agent(agent.id)!, c.q);
    expect(sched).toMatchObject({ cron: "0 9 * * 1-5", timezone: "UTC", lastRunAt: null });
    expect(new Date(sched!.next!).getUTCHours()).toBe(9);
    const est = estimateTriggers(c.q.agent(agent.id)!, c.store, c.q);
    expect(est.map((e) => [e.kind, e.perDay])).toEqual([
      ["schedule", Math.round((5 / 7) * 10) / 10],
      ["issue_created", Math.round((3 / 14) * 10) / 10],
      ["label_added", Math.round((1 / 14) * 10) / 10],
      ["webhook", null],
    ]);
    expect((await team.local("GET", `/agents/${agent.id}/triggers/status`)).json.estimates).toHaveLength(4);
  });
});
