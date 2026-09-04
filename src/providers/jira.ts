import { adf2markdown } from "adf2markdown";
import type { Provider, WorkItem } from "./types.ts";
import { jiraTransition } from "../tick-actions/jira-transition.ts";
import { HttpClient } from "../http-client.ts";
import { captureCommandRunner, type CommandRunner } from "../apfel.ts";
import { judgeComment } from "../judge-comment.ts";

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description: unknown;
    parent?: { key: string; fields: { summary: string } };
  };
}

interface JiraComment {
  author: { displayName: string };
  body: unknown;
  created: string;
}

export class JiraProvider implements Provider {
  private baseUrl: string;
  private email: string;
  private apiToken: string;
  private project: string;
  private doneStatusName: string;
  private http: HttpClient;
  private run: CommandRunner;

  constructor(opts: {
    baseUrl: string;
    email: string;
    apiToken: string;
    project: string;
    doneStatusName: string;
    http: HttpClient;
    run?: CommandRunner;
  }) {
    this.baseUrl = opts.baseUrl;
    this.email = opts.email;
    this.apiToken = opts.apiToken;
    this.project = opts.project;
    this.doneStatusName = opts.doneStatusName;
    this.http = opts.http;
    this.run = opts.run ?? captureCommandRunner();
  }

  async close(url: string): Promise<void> {
    const match = url.match(/\/browse\/([^/]+)$/);
    if (!match) {
      throw new Error(`Cannot parse Jira issue URL: ${url}`);
    }
    await jiraTransition({
      baseUrl: this.baseUrl,
      email: this.email,
      apiToken: this.apiToken,
      issueKey: match[1],
      targetStatusName: this.doneStatusName,
      http: this.http,
    });
  }

  private async fetchAncestors(key: string, auth: string): Promise<string> {
    const url =
      `${this.baseUrl}/rest/api/3/issue/${key}?fields=summary,description,parent`;
    const res = await this.http.get(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) return "";
    const issue = (await res.json()) as {
      fields: {
        summary: string;
        description: unknown;
        parent?: { key: string };
      };
    };
    const desc = issue.fields.description == null ||
        typeof issue.fields.description !== "object"
      ? ""
      // deno-lint-ignore no-explicit-any
      : adf2markdown(issue.fields.description as any).trim();
    const block =
      `## Parent context: ${key} — ${issue.fields.summary}\n\n${desc}`;
    if (issue.fields.parent) {
      const further = await this.fetchAncestors(issue.fields.parent.key, auth);
      if (further) return `${block}\n\n${further}`;
    }
    return block;
  }

  private async fetchComments(
    key: string,
    auth: string,
  ): Promise<JiraComment[]> {
    const url = `${this.baseUrl}/rest/api/3/issue/${key}/comment?maxResults=50`;
    const res = await this.http.get(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { comments: JiraComment[] };
    return data.comments ?? [];
  }

  private async buildBody(issue: JiraIssue, auth: string): Promise<string> {
    let description = issue.fields.description == null ||
        typeof issue.fields.description !== "object"
      ? ""
      // deno-lint-ignore no-explicit-any
      : adf2markdown(issue.fields.description as any).trim();
    if (issue.fields.parent) {
      const ancestors = await this.fetchAncestors(
        issue.fields.parent.key,
        auth,
      );
      if (ancestors) description = `${description}\n\n---\n\n${ancestors}`;
    }
    const comments = await this.fetchComments(issue.key, auth);
    const keptComments: Array<{
      displayName: string;
      date: string;
      body: string;
    }> = [];
    for (const comment of comments) {
      const commentBody = comment.body == null ||
          typeof comment.body !== "object"
        ? ""
        // deno-lint-ignore no-explicit-any
        : adf2markdown(comment.body as any).trim();
      if (!commentBody) continue;
      const keep = await judgeComment(commentBody, this.run);
      if (keep) {
        keptComments.push({
          displayName: comment.author.displayName,
          date: comment.created.slice(0, 10),
          body: commentBody,
        });
      }
    }
    if (keptComments.length > 0) {
      const commentSection = "## Comments\n\n" +
        keptComments
          .map((c) => `**${c.displayName}** (${c.date})\n\n${c.body}`)
          .join("\n\n");
      description = `${description}\n\n---\n\n${commentSection}`;
    }
    return description;
  }

  async fetchCurrent(
    ticketId: string,
  ): Promise<{ title: string; body: string } | null> {
    const key = ticketId.slice(5);
    const auth = btoa(`${this.email}:${this.apiToken}`);
    const url =
      `${this.baseUrl}/rest/api/3/issue/${key}?fields=summary,description,parent`;
    const res = await this.http.get(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;
    const issue = (await res.json()) as JiraIssue;
    const body = await this.buildBody(issue, auth);
    return { title: issue.fields.summary, body };
  }

  async fetchNew(knownIds: Set<string>): Promise<WorkItem[]> {
    const jql =
      `assignee = currentUser() AND project = ${this.project} AND statusCategory != Done`;
    const url = `${this.baseUrl}/rest/api/3/search/jql`;
    const auth = btoa(`${this.email}:${this.apiToken}`);
    const res = await this.http.post(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jql,
        maxResults: 50,
        fields: ["key", "summary", "description", "parent"],
      }),
    });
    if (!res.ok) throw new Error(`Jira API error: ${res.status} ${url}`);
    const data = (await res.json()) as { issues: JiraIssue[] };
    const items: WorkItem[] = [];
    for (const issue of data.issues) {
      if (!issue.fields) continue;
      const id = `jira/${issue.key}`;
      const legacyId = `jira-${issue.key}`;
      if (knownIds.has(legacyId)) {
        console.log(
          `JiraProvider.fetchNew: ${id} already tracked as legacy id ` +
            `${legacyId} (pending namespace-ticket-ids migration), skipping`,
        );
        continue;
      }
      if (!knownIds.has(id)) {
        const description = await this.buildBody(issue, auth);
        items.push({
          id,
          provider: "jira",
          title: issue.fields.summary,
          description,
          url: `${this.baseUrl}/browse/${issue.key}`,
        });
      }
    }
    return items;
  }

  static toSortable(id: string): Array<string | number> {
    const m = id.match(/^jira\/([A-Za-z][A-Za-z0-9]*)-(\d+)$/);
    if (!m) return [id];
    return [m[1], parseInt(m[2], 10)];
  }
}
