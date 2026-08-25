import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import {
  checkNewCommentsAction,
  type CheckNewCommentsDeps,
} from "./check-new-comments.ts";
import { makeTicket } from "../test-support.ts";
import type { TicketState } from "../state/types.ts";

const BASE_GITHUB = {
  id: "github/jackjennings/lazyboy/42",
  provider: "github" as const,
  url: "https://github.com/jackjennings/lazyboy/issues/42",
  phase: "spec" as const,
  status: "waiting" as const,
  created: "2026-01-01T00:00:00Z",
};

const BASE_JIRA = {
  id: "jira/PROJ-123",
  provider: "jira" as const,
  url: "https://example.atlassian.net/browse/PROJ-123",
  phase: "plan" as const,
  status: "waiting" as const,
  created: "2026-01-01T00:00:00Z",
};

function makeConfig(overrides: { checkNewComments?: boolean } = {}) {
  return {
    tick: {
      concurrency: 1,
      resolveCIFailures: true,
      principles: true,
      agentsMdMaxTokens: 0,
      maxTurns: 100,
      checkNewComments: overrides.checkNewComments,
    },
    github: { repos: [] },
    state: { dir: "/state" },
    extensions: { dir: "" },
    codebase: { roots: [] },
    pi: { provider: "anthropic", packages: [] },
    agent: { type: "pi" as const },
  };
}

function makeDeps(
  overrides: Partial<CheckNewCommentsDeps> = {},
): CheckNewCommentsDeps {
  return {
    isProcessAlive: () => false,
    writeTicket: () => Promise.resolve(),
    appendLog: () => Promise.resolve(),
    fetchGitHubComments: () => Promise.resolve([]),
    fetchJiraComments: () => Promise.resolve([]),
    fetchPrComments: () => Promise.resolve([]),
    isBot: () => false,
    judgeComment: () => Promise.resolve(true),
    writeContextFile: () => Promise.resolve(),
    config: makeConfig(),
    ...overrides,
  };
}

const ACTIVE_PR = {
  url: "https://github.com/jackjennings/lazyboy/pull/1",
  title: "PR 1",
  dependsOn: [],
  merged: false,
};

Deno.test("checkNewCommentsAction: applies for github/spec/waiting", () => {
  assert(checkNewCommentsAction(makeDeps()).applies(makeTicket(BASE_GITHUB)));
});

Deno.test("checkNewCommentsAction: applies for jira/plan/waiting", () => {
  assert(checkNewCommentsAction(makeDeps()).applies(makeTicket(BASE_JIRA)));
});

Deno.test("checkNewCommentsAction: does not apply for todo-txt provider", () => {
  assertFalse(
    checkNewCommentsAction(makeDeps()).applies(
      makeTicket({ ...BASE_GITHUB, provider: "todo-txt" }),
    ),
  );
});

Deno.test("checkNewCommentsAction: does not apply when status is not waiting", () => {
  assertFalse(
    checkNewCommentsAction(makeDeps()).applies(
      makeTicket({ ...BASE_GITHUB, status: "running" }),
    ),
  );
});

Deno.test("checkNewCommentsAction: does not apply when a process is alive", () => {
  assertFalse(
    checkNewCommentsAction(makeDeps({ isProcessAlive: () => true })).applies(
      makeTicket(BASE_GITHUB),
    ),
  );
});

Deno.test("checkNewCommentsAction: does not apply for intake or enrichment phase", () => {
  assertFalse(
    checkNewCommentsAction(makeDeps()).applies(
      makeTicket({ ...BASE_GITHUB, phase: "intake" }),
    ),
  );
  assertFalse(
    checkNewCommentsAction(makeDeps()).applies(
      makeTicket({ ...BASE_GITHUB, phase: "enrichment" }),
    ),
  );
});

Deno.test("checkNewCommentsAction: does not apply when checkNewComments is false", () => {
  assertFalse(
    checkNewCommentsAction(
      makeDeps({ config: makeConfig({ checkNewComments: false }) }),
    ).applies(makeTicket(BASE_GITHUB)),
  );
});

Deno.test("checkNewCommentsAction: returns null when no new comments", async () => {
  const writeTicketSpy = spy(() => Promise.resolve());
  const result = await checkNewCommentsAction(
    makeDeps({ writeTicket: writeTicketSpy }),
  ).run(makeTicket(BASE_GITHUB), "/state");
  assertEquals(result, null);
  assertSpyCalls(writeTicketSpy, 0);
});

Deno.test("checkNewCommentsAction: SKIP comments advance cursor without setting revising", async () => {
  const written: object[] = [];
  const result = await checkNewCommentsAction(
    makeDeps({
      fetchGitHubComments: () =>
        Promise.resolve([
          {
            author: "alice",
            body: "Any update?",
            timestamp: "2026-02-01T10:00:00Z",
          },
        ]),
      judgeComment: () => Promise.resolve(false),
      writeTicket: (_sd, t) => {
        written.push(t);
        return Promise.resolve();
      },
    }),
  ).run(makeTicket(BASE_GITHUB), "/state");
  assertEquals((result as { status: string } | null)?.status, "waiting");
  assertEquals(
    (result as { lastSeenCommentTimestamp?: string } | null)
      ?.lastSeenCommentTimestamp,
    "2026-02-01T10:00:00Z",
  );
});

Deno.test(
  "checkNewCommentsAction: KEEP comment sets status to revising and writes context file",
  async () => {
    const writeContextSpy = spy(() => Promise.resolve());
    const result = await checkNewCommentsAction(
      makeDeps({
        fetchGitHubComments: () =>
          Promise.resolve([
            {
              author: "alice",
              body: "Please add retry logic",
              timestamp: "2026-02-01T10:00:00Z",
            },
          ]),
        judgeComment: () => Promise.resolve(true),
        writeContextFile: writeContextSpy,
      }),
    ).run(makeTicket(BASE_GITHUB), "/state");
    assertEquals((result as { status: string } | null)?.status, "revising");
    assertEquals(
      (result as { lastSeenCommentTimestamp?: string } | null)
        ?.lastSeenCommentTimestamp,
      "2026-02-01T10:00:00Z",
    );
    assertSpyCalls(writeContextSpy, 1);
  },
);

Deno.test(
  "checkNewCommentsAction: context file content includes ticket URL and comment",
  async () => {
    const written: string[] = [];
    await checkNewCommentsAction(
      makeDeps({
        fetchGitHubComments: () =>
          Promise.resolve([
            {
              author: "bob",
              body: "Add timeout handling",
              timestamp: "2026-03-15T08:00:00Z",
            },
          ]),
        judgeComment: () => Promise.resolve(true),
        writeContextFile: (_dir, content) => {
          written.push(content);
          return Promise.resolve();
        },
      }),
    ).run(makeTicket(BASE_GITHUB), "/state");
    assertStringIncludes(written[0], "## New comments on");
    assertStringIncludes(
      written[0],
      "https://github.com/jackjennings/lazyboy/issues/42",
    );
    assertStringIncludes(written[0], "**bob** (2026-03-15)");
    assertStringIncludes(written[0], "Add timeout handling");
  },
);

Deno.test(
  "checkNewCommentsAction: bot-authored comment is not judged and not kept",
  async () => {
    const judgeCommentSpy = spy(() => Promise.resolve(true));
    const writeContextSpy = spy(() => Promise.resolve());
    const result = await checkNewCommentsAction(
      makeDeps({
        fetchGitHubComments: () =>
          Promise.resolve([
            {
              author: "lazyboy-bot",
              body: "Working on it",
              timestamp: "2026-02-01T10:00:00Z",
            },
          ]),
        isBot: (author) => author === "lazyboy-bot",
        judgeComment: judgeCommentSpy,
        writeContextFile: writeContextSpy,
      }),
    ).run(makeTicket(BASE_GITHUB), "/state");
    assertSpyCalls(judgeCommentSpy, 0);
    assertSpyCalls(writeContextSpy, 0);
    assertEquals((result as { status: string } | null)?.status, "waiting");
  },
);

Deno.test(
  "checkNewCommentsAction: fetch failure returns null without advancing cursor",
  async () => {
    const writeTicketSpy = spy(() => Promise.resolve());
    const result = await checkNewCommentsAction(
      makeDeps({
        fetchGitHubComments: () => Promise.reject(new Error("rate limited")),
        writeTicket: writeTicketSpy,
      }),
    ).run(makeTicket(BASE_GITHUB), "/state");
    assertEquals(result, null);
    assertSpyCalls(writeTicketSpy, 0);
  },
);

Deno.test("checkNewCommentsAction: uses jira fetcher for jira tickets", async () => {
  const jiraFetchSpy = spy((_issueKey: string, _since?: string) =>
    Promise.resolve([])
  );
  await checkNewCommentsAction(
    makeDeps({ fetchJiraComments: jiraFetchSpy }),
  ).run(makeTicket(BASE_JIRA), "/state");
  assertSpyCalls(jiraFetchSpy, 1);
  assertEquals(jiraFetchSpy.calls[0].args[0], "PROJ-123");
});

Deno.test("checkNewCommentsAction: passes lastSeenCommentTimestamp as since", async () => {
  const fetchSpy = spy((_id: string, since?: string) => {
    assertEquals(since, "2026-01-15T09:00:00Z");
    return Promise.resolve([]);
  });
  await checkNewCommentsAction(
    makeDeps({ fetchGitHubComments: fetchSpy }),
  ).run(
    makeTicket({
      ...BASE_GITHUB,
      lastSeenCommentTimestamp: "2026-01-15T09:00:00Z",
    }),
    "/state",
  );
  assertSpyCalls(fetchSpy, 1);
});

Deno.test(
  "checkNewCommentsAction: uses ticket.created as since when cursor is unset",
  async () => {
    const fetchSpy = spy((_id: string, since?: string) => {
      assertEquals(since, "2026-01-01T00:00:00Z");
      return Promise.resolve([]);
    });
    await checkNewCommentsAction(
      makeDeps({ fetchGitHubComments: fetchSpy }),
    ).run(makeTicket(BASE_GITHUB), "/state");
    assertSpyCalls(fetchSpy, 1);
  },
);

Deno.test(
  "checkNewCommentsAction: logs the since cursor and comment counts",
  async () => {
    const logged: Record<string, unknown>[] = [];
    await checkNewCommentsAction(
      makeDeps({
        fetchGitHubComments: () =>
          Promise.resolve([
            {
              author: "alice",
              body: "Please add retry logic",
              timestamp: "2026-02-01T10:00:00Z",
            },
            {
              author: "lazyboy-bot",
              body: "Working on it",
              timestamp: "2026-02-02T10:00:00Z",
            },
          ]),
        isBot: (author) => author === "lazyboy-bot",
        appendLog: (_sd, _id, entry) => {
          logged.push(entry as Record<string, unknown>);
          return Promise.resolve();
        },
      }),
    ).run(makeTicket(BASE_GITHUB), "/state");
    assertEquals(logged.length, 1);
    assertEquals(logged[0].action, "check-new-comments");
    assertEquals(logged[0].since, "2026-01-01T00:00:00Z");
    assertEquals(logged[0].fetched, 2);
    assertEquals(logged[0].kept, 1);
    assertEquals(logged[0].latestTimestamp, "2026-02-02T10:00:00Z");
  },
);

Deno.test(
  "checkNewCommentsAction: comment at exactly the cursor is not re-applied",
  async () => {
    const writeTicketSpy = spy(() => Promise.resolve());
    const writeContextSpy = spy(() => Promise.resolve());
    const result = await checkNewCommentsAction(
      makeDeps({
        fetchGitHubComments: () =>
          Promise.resolve([
            {
              author: "alice",
              body: "Please add retry logic",
              timestamp: "2026-02-01T10:00:00Z",
            },
          ]),
        writeTicket: writeTicketSpy,
        writeContextFile: writeContextSpy,
      }),
    ).run(
      makeTicket({
        ...BASE_GITHUB,
        lastSeenCommentTimestamp: "2026-02-01T10:00:00Z",
      }),
      "/state",
    );
    assertEquals(result, null);
    assertSpyCalls(writeContextSpy, 0);
    assertSpyCalls(writeTicketSpy, 0);
  },
);

Deno.test(
  "checkNewCommentsAction: a comment older than the cursor never rewinds it",
  async () => {
    const written: { lastSeenCommentTimestamp?: string }[] = [];
    const result = await checkNewCommentsAction(
      makeDeps({
        fetchGitHubComments: () =>
          Promise.resolve([
            {
              author: "alice",
              body: "Edited an old comment",
              timestamp: "2026-01-05T10:00:00Z",
            },
            {
              author: "bob",
              body: "Please add retry logic",
              timestamp: "2026-02-10T10:00:00Z",
            },
          ]),
        writeTicket: (_sd, t) => {
          written.push(t);
          return Promise.resolve();
        },
      }),
    ).run(
      makeTicket({
        ...BASE_GITHUB,
        lastSeenCommentTimestamp: "2026-02-01T10:00:00Z",
      }),
      "/state",
    );
    assertEquals(
      (result as { lastSeenCommentTimestamp?: string } | null)
        ?.lastSeenCommentTimestamp,
      "2026-02-10T10:00:00Z",
    );
    assertEquals(written[0].lastSeenCommentTimestamp, "2026-02-10T10:00:00Z");
  },
);

Deno.test(
  "checkNewCommentsAction: sub-second cursor precision does not resurface a comment",
  async () => {
    const writeContextSpy = spy(() => Promise.resolve());
    const result = await checkNewCommentsAction(
      makeDeps({
        fetchGitHubComments: () =>
          Promise.resolve([
            {
              author: "alice",
              body: "Please add retry logic",
              timestamp: "2026-02-01T10:00:00Z",
            },
          ]),
        writeContextFile: writeContextSpy,
      }),
    ).run(
      makeTicket({
        ...BASE_GITHUB,
        lastSeenCommentTimestamp: "2026-02-01T10:00:00.500Z",
      }),
      "/state",
    );
    assertEquals(result, null);
    assertSpyCalls(writeContextSpy, 0);
  },
);

Deno.test(
  "checkNewCommentsAction: multiple KEEP comments separated by --- in context file",
  async () => {
    const written: string[] = [];
    await checkNewCommentsAction(
      makeDeps({
        fetchGitHubComments: () =>
          Promise.resolve([
            {
              author: "alice",
              body: "First comment",
              timestamp: "2026-02-01T00:00:00Z",
            },
            {
              author: "bob",
              body: "Second comment",
              timestamp: "2026-02-02T00:00:00Z",
            },
          ]),
        judgeComment: () => Promise.resolve(true),
        writeContextFile: (_dir, content) => {
          written.push(content);
          return Promise.resolve();
        },
      }),
    ).run(makeTicket(BASE_GITHUB), "/state");
    assertStringIncludes(written[0], "---");
    assertStringIncludes(written[0], "First comment");
    assertStringIncludes(written[0], "Second comment");
  },
);

Deno.test(
  "checkNewCommentsAction: PR comment is kept and flips status to revising",
  async () => {
    const writeContextSpy = spy(() => Promise.resolve());
    const judgeCommentSpy = spy(() => Promise.resolve(true));
    const result = await checkNewCommentsAction(
      makeDeps({
        fetchPrComments: () =>
          Promise.resolve([
            {
              author: "alice",
              body: "Please fix the edge case",
              timestamp: "2026-02-01T10:00:00Z",
            },
          ]),
        judgeComment: judgeCommentSpy,
        writeContextFile: writeContextSpy,
      }),
    ).run(
      makeTicket({ ...BASE_GITHUB, prs: [ACTIVE_PR] }),
      "/state",
    );
    assertEquals((result as { status: string } | null)?.status, "revising");
    assertSpyCalls(writeContextSpy, 1);
    assertSpyCalls(judgeCommentSpy, 0);
  },
);

Deno.test(
  "checkNewCommentsAction: bot-authored PR comment is skipped",
  async () => {
    const writeContextSpy = spy(() => Promise.resolve());
    const result = await checkNewCommentsAction(
      makeDeps({
        fetchPrComments: () =>
          Promise.resolve([
            {
              author: "lazyboy-bot",
              body: "Working on it",
              timestamp: "2026-02-01T10:00:00Z",
            },
          ]),
        isBot: (author) => author === "lazyboy-bot",
        writeContextFile: writeContextSpy,
      }),
    ).run(
      makeTicket({ ...BASE_GITHUB, prs: [ACTIVE_PR] }),
      "/state",
    );
    assertEquals((result as { status: string } | null)?.status, "waiting");
    assertSpyCalls(writeContextSpy, 0);
  },
);

Deno.test(
  "checkNewCommentsAction: judgeComment is never called for PR comments",
  async () => {
    const judgeCommentSpy = spy(() => Promise.resolve(true));
    await checkNewCommentsAction(
      makeDeps({
        fetchPrComments: () =>
          Promise.resolve([
            {
              author: "alice",
              body: "Looks good",
              timestamp: "2026-02-01T10:00:00Z",
            },
          ]),
        judgeComment: judgeCommentSpy,
      }),
    ).run(
      makeTicket({ ...BASE_GITHUB, prs: [ACTIVE_PR] }),
      "/state",
    );
    assertSpyCalls(judgeCommentSpy, 0);
  },
);

Deno.test(
  "checkNewCommentsAction: lastSeenPrCommentTimestamp advances independently of lastSeenCommentTimestamp",
  async () => {
    const written: TicketState[] = [];
    const result = await checkNewCommentsAction(
      makeDeps({
        fetchPrComments: () =>
          Promise.resolve([
            {
              author: "alice",
              body: "Great work",
              timestamp: "2026-02-01T10:00:00Z",
            },
          ]),
        writeTicket: (_sd, t) => {
          written.push(t);
          return Promise.resolve();
        },
      }),
    ).run(
      makeTicket({
        ...BASE_GITHUB,
        lastSeenCommentTimestamp: "2026-01-15T00:00:00Z",
        prs: [ACTIVE_PR],
      }),
      "/state",
    );
    assertEquals(
      (result as TicketState | null)?.lastSeenPrCommentTimestamp,
      "2026-02-01T10:00:00Z",
    );
    assertEquals(
      (result as TicketState | null)?.lastSeenCommentTimestamp,
      "2026-01-15T00:00:00Z",
    );
    assertEquals(written[0].lastSeenPrCommentTimestamp, "2026-02-01T10:00:00Z");
    assertEquals(written[0].lastSeenCommentTimestamp, "2026-01-15T00:00:00Z");
  },
);

Deno.test(
  "checkNewCommentsAction: merged PR is skipped; fetchPrComments not called",
  async () => {
    const fetchPrSpy = spy(() => Promise.resolve([]));
    const result = await checkNewCommentsAction(
      makeDeps({ fetchPrComments: fetchPrSpy }),
    ).run(
      makeTicket({
        ...BASE_GITHUB,
        prs: [{ ...ACTIVE_PR, merged: true }],
      }),
      "/state",
    );
    assertEquals(result, null);
    assertSpyCalls(fetchPrSpy, 0);
  },
);

Deno.test(
  "checkNewCommentsAction: closed PR is skipped; fetchPrComments not called",
  async () => {
    const fetchPrSpy = spy(() => Promise.resolve([]));
    const result = await checkNewCommentsAction(
      makeDeps({ fetchPrComments: fetchPrSpy }),
    ).run(
      makeTicket({
        ...BASE_GITHUB,
        prs: [{ ...ACTIVE_PR, closed: true }],
      }),
      "/state",
    );
    assertEquals(result, null);
    assertSpyCalls(fetchPrSpy, 0);
  },
);

Deno.test(
  "checkNewCommentsAction: fetchPrComments not called when ticket.prs is empty",
  async () => {
    const fetchPrSpy = spy(() => Promise.resolve([]));
    const result = await checkNewCommentsAction(
      makeDeps({ fetchPrComments: fetchPrSpy }),
    ).run(makeTicket({ ...BASE_GITHUB, prs: [] }), "/state");
    assertEquals(result, null);
    assertSpyCalls(fetchPrSpy, 0);
  },
);

Deno.test(
  "checkNewCommentsAction: fetchPrComments not called when ticket.prs is undefined",
  async () => {
    const fetchPrSpy = spy(() => Promise.resolve([]));
    const result = await checkNewCommentsAction(
      makeDeps({ fetchPrComments: fetchPrSpy }),
    ).run(makeTicket(BASE_GITHUB), "/state");
    assertEquals(result, null);
    assertSpyCalls(fetchPrSpy, 0);
  },
);

Deno.test(
  "checkNewCommentsAction: both tracking and PR comments empty returns null",
  async () => {
    const writeTicketSpy = spy(() => Promise.resolve());
    const result = await checkNewCommentsAction(
      makeDeps({
        fetchPrComments: () => Promise.resolve([]),
        writeTicket: writeTicketSpy,
      }),
    ).run(
      makeTicket({ ...BASE_GITHUB, prs: [ACTIVE_PR] }),
      "/state",
    );
    assertEquals(result, null);
    assertSpyCalls(writeTicketSpy, 0);
  },
);

Deno.test(
  "checkNewCommentsAction: no tracking comments but PR comments exist flips to revising",
  async () => {
    const writeContextSpy = spy(() => Promise.resolve());
    const result = await checkNewCommentsAction(
      makeDeps({
        fetchGitHubComments: () => Promise.resolve([]),
        fetchPrComments: () =>
          Promise.resolve([
            {
              author: "alice",
              body: "Add error handling",
              timestamp: "2026-02-01T10:00:00Z",
            },
          ]),
        writeContextFile: writeContextSpy,
      }),
    ).run(
      makeTicket({ ...BASE_GITHUB, prs: [ACTIVE_PR] }),
      "/state",
    );
    assertEquals((result as { status: string } | null)?.status, "revising");
    assertSpyCalls(writeContextSpy, 1);
  },
);

Deno.test(
  "checkNewCommentsAction: log entry includes prFetched and prKept fields",
  async () => {
    const logged: Record<string, unknown>[] = [];
    await checkNewCommentsAction(
      makeDeps({
        fetchPrComments: () =>
          Promise.resolve([
            {
              author: "alice",
              body: "Nice work",
              timestamp: "2026-02-01T10:00:00Z",
            },
          ]),
        appendLog: (_sd, _id, entry) => {
          logged.push(entry as Record<string, unknown>);
          return Promise.resolve();
        },
      }),
    ).run(
      makeTicket({ ...BASE_GITHUB, prs: [ACTIVE_PR] }),
      "/state",
    );
    assertEquals(logged[0].prFetched, 1);
    assertEquals(logged[0].prKept, 1);
  },
);

Deno.test(
  "checkNewCommentsAction: lastSeenPrCommentTimestamp advances even when PR comment is bot-filtered",
  async () => {
    const result = await checkNewCommentsAction(
      makeDeps({
        fetchPrComments: () =>
          Promise.resolve([
            {
              author: "lazyboy-bot",
              body: "Automated message",
              timestamp: "2026-02-01T10:00:00Z",
            },
          ]),
        isBot: (author) => author === "lazyboy-bot",
      }),
    ).run(
      makeTicket({ ...BASE_GITHUB, prs: [ACTIVE_PR] }),
      "/state",
    );
    assertEquals(
      (result as TicketState | null)?.lastSeenPrCommentTimestamp,
      "2026-02-01T10:00:00Z",
    );
  },
);
