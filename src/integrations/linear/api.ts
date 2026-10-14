export class LinearError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type LinearStateType = "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled";

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  priority: number;
  updatedAt: string;
  state: { id: string; name: string; type: LinearStateType };
  team: { id: string; key: string };
}

export interface LinearState {
  id: string;
  name: string;
  type: LinearStateType;
  position: number;
}

const ISSUE_FIELDS = "id identifier title description url priority updatedAt state { id name type } team { id key }";
const IDENTIFIER = /^[A-Z][A-Z0-9]*-\d+$/;

export function assertIdentifier(id: string): string {
  if (!IDENTIFIER.test(id) && !/^[0-9a-f-]{36}$/i.test(id)) throw new LinearError(`"${id}" is not a Linear issue identifier like ENG-123`, 400);
  return id;
}

/** The slice of Linear's GraphQL API Cadence uses, with a personal API key. */
export class LinearApi {
  constructor(
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetchImpl("https://api.linear.app/graphql", {
      method: "POST",
      headers: { Authorization: this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
    if (!res.ok || body.errors?.length) throw new LinearError(`Linear: ${body.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`}`, res.status === 200 ? 400 : res.status);
    return body.data as T;
  }

  async viewer(): Promise<{ name: string; organization: string }> {
    const d = await this.gql<{ viewer: { name: string; organization: { name: string } } }>("query { viewer { name organization { name } } }");
    return { name: d.viewer.name, organization: d.viewer.organization.name };
  }

  async teams(): Promise<{ id: string; key: string; name: string }[]> {
    return (await this.gql<{ teams: { nodes: { id: string; key: string; name: string }[] } }>("query { teams(first: 100) { nodes { id key name } } }")).teams.nodes;
  }

  /** Issues in these teams changed after `since` (or, without it, every open issue), oldest change first. */
  async changedIssues(teamIds: string[], since: string | null): Promise<LinearIssue[]> {
    const filter: Record<string, unknown> = { team: { id: { in: teamIds } } };
    if (since) filter.updatedAt = { gt: since };
    else filter.state = { type: { nin: ["completed", "canceled"] } };
    const out: LinearIssue[] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const d: { issues: { nodes: LinearIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await this.gql(
        `query($filter: IssueFilter, $after: String) { issues(first: 100, after: $after, filter: $filter, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
        { filter, after },
      );
      out.push(...d.issues.nodes);
      if (!d.issues.pageInfo.hasNextPage) break;
      after = d.issues.pageInfo.endCursor;
    }
    return out.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  async issue(idOrIdentifier: string): Promise<LinearIssue & { comments: { body: string; user: string | null; createdAt: string }[] }> {
    const d = await this.gql<{ issue: LinearIssue & { comments: { nodes: { body: string; createdAt: string; user: { name: string } | null }[] } } }>(
      `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} comments(first: 50) { nodes { body createdAt user { name } } } } }`,
      { id: assertIdentifier(idOrIdentifier) },
    );
    return { ...d.issue, comments: d.issue.comments.nodes.map((c) => ({ body: c.body, user: c.user?.name ?? null, createdAt: c.createdAt })) };
  }

  async search(term: string): Promise<LinearIssue[]> {
    const d = await this.gql<{ searchIssues: { nodes: LinearIssue[] } }>(`query($term: String!) { searchIssues(term: $term, first: 20) { nodes { ${ISSUE_FIELDS} } } }`, { term });
    return d.searchIssues.nodes;
  }

  async states(teamId: string): Promise<LinearState[]> {
    const d = await this.gql<{ workflowStates: { nodes: LinearState[] } }>(
      "query($teamId: ID!) { workflowStates(first: 100, filter: { team: { id: { eq: $teamId } } }) { nodes { id name type position } } }",
      { teamId },
    );
    return d.workflowStates.nodes.sort((a, b) => a.position - b.position);
  }

  async comment(issueId: string, body: string): Promise<void> {
    await this.gql("mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }", { input: { issueId, body } });
  }

  async setState(issueId: string, stateId: string): Promise<void> {
    await this.gql("mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }", { id: issueId, input: { stateId } });
  }
}
