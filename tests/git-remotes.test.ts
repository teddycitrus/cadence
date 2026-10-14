import { webUrl } from "../src/git/web-url";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubApi } from "../src/git/github";
import { createGitFixture, gitOut, type GitFixture } from "./helpers/git-fixture";
import { bootTeam } from "./helpers/team";

describe("git remotes", () => {
  let fx: GitFixture | null = null;
  let close = () => {};
  afterEach(() => {
    close();
    close = () => {};
    fx?.cleanup();
    fx = null;
  });

  it("renames remotes", async () => {
    fx = createGitFixture();
    const team = await bootTeam();
    close = team.close;
    const project = team.c.agents.addProject({ name: "x", path: fx.repo, baseBranch: "main", githubRepo: null });
    const ws = await team.c.workspaces.createInProject(project.id, "Remotes", "user");
    await team.local("POST", `/workspaces/${ws.id}/git/remotes`, { name: "upstream", url: "https://github.com/acme/web.git" });
    expect((await team.local("POST", `/workspaces/${ws.id}/git/remotes/rename`, { name: "upstream", newName: "acme" })).status).toBe(200);
    expect(gitOut(ws.path, "remote")).toBe("acme");
    expect((await team.local("POST", `/workspaces/${ws.id}/git/remotes/rename`, { name: "acme", newName: "--evil" })).status).toBeGreaterThanOrEqual(400);
  });

  it("creates repositories for the user or an organization", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { name: string };
      calls.push({ url: String(url).replace("https://api.github.com", ""), body });
      const owner = String(url).includes("/orgs/acme/") ? "acme" : "dev";
      return new Response(JSON.stringify({ full_name: `${owner}/${body.name}`, clone_url: `https://github.com/${owner}/${body.name}.git`, html_url: `https://github.com/${owner}/${body.name}` }), { status: 201 });
    }) as typeof fetch;
    const api = new GitHubApi("t", fake);
    expect(await api.createRepository({ name: "shop", owner: null, private: true, description: "" })).toEqual({ fullName: "dev/shop", cloneUrl: "https://github.com/dev/shop.git", htmlUrl: "https://github.com/dev/shop" });
    await api.createRepository({ name: "site", owner: "acme", private: false, description: "Our site" });
    expect(calls.map((c) => [c.url, c.body.private])).toEqual([
      ["/user/repos", true],
      ["/orgs/acme/repos", false],
    ]);
    await expect(api.createRepository({ name: "bad name!", owner: null, private: true, description: "" })).rejects.toThrow(/Repository names/);
  });
});

describe("remote web links", () => {
  it("turns ssh and https remotes into the repository's web page, dropping credentials", () => {
    expect(webUrl("git@github.com:acme/web.git")).toBe("https://github.com/acme/web");
    expect(webUrl("ssh://git@gitlab.com/group/sub/app.git")).toBe("https://gitlab.com/group/sub/app");
    expect(webUrl("https://user:token@github.com/acme/web.git")).toBe("https://github.com/acme/web");
    expect(webUrl("https://bitbucket.org/team/repo/")).toBe("https://bitbucket.org/team/repo");
    expect(webUrl("C:/code/repo")).toBeNull();
    expect(webUrl("../other.git")).toBeNull();
  });
});
