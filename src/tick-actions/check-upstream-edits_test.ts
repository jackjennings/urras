import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import {
  checkUpstreamEditsAction,
  type CheckUpstreamEditsDeps,
} from "./check-upstream-edits.ts";
import { makeTicket } from "../test-support.ts";
import type { TicketState } from "../state/types.ts";

const BASE = {
  id: "github/jackjennings/lazyboy/42",
  provider: "github" as const,
  url: "https://github.com/jackjennings/lazyboy/issues/42",
  phase: "spec" as const,
  status: "waiting" as const,
  title: "Original title",
  body: "Original body",
  created: "2026-01-01T00:00:00Z",
};

function makeConfig(overrides: { checkUpstreamEdits?: boolean } = {}) {
  return {
    tick: {
      concurrency: 1,
      resolveCIFailures: true,
      principles: true,
      agentsMdMaxTokens: 0,
      maxTurns: 100,
      checkUpstreamEdits: overrides.checkUpstreamEdits,
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
  overrides: Partial<CheckUpstreamEditsDeps> = {},
): CheckUpstreamEditsDeps {
  return {
    isProcessAlive: () => false,
    writeTicket: () => Promise.resolve(),
    appendLog: () => Promise.resolve(),
    fetchGitHubIssue: () =>
      Promise.resolve({ title: BASE.title, body: BASE.body }),
    writeUpstreamEditContextFile: () => Promise.resolve(),
    judgeUpstreamEdit: () => Promise.resolve(false),
    generateShortTitle: () => Promise.resolve(null),
    config: makeConfig(),
    ...overrides,
  };
}

function hoursAgoTimestamp(hours: number): string {
  const ms = Temporal.Now.instant().epochMilliseconds - hours * 60 * 60 * 1000;
  return Temporal.Instant.fromEpochMilliseconds(ms).toString();
}

Deno.test(
  "checkUpstreamEditsAction: applies for github/spec/waiting with no sync timestamp",
  () => {
    assert(checkUpstreamEditsAction(makeDeps()).applies(makeTicket(BASE)));
  },
);

Deno.test(
  "checkUpstreamEditsAction: applies when lastUpstreamSyncTimestamp is over 1 hour ago",
  () => {
    assert(
      checkUpstreamEditsAction(makeDeps()).applies(
        makeTicket({
          ...BASE,
          lastUpstreamSyncTimestamp: hoursAgoTimestamp(2),
        }),
      ),
    );
  },
);

Deno.test(
  "checkUpstreamEditsAction: does not apply when lastUpstreamSyncTimestamp is under 1 hour ago",
  () => {
    assertFalse(
      checkUpstreamEditsAction(makeDeps()).applies(
        makeTicket({
          ...BASE,
          lastUpstreamSyncTimestamp: hoursAgoTimestamp(0.5),
        }),
      ),
    );
  },
);

Deno.test("checkUpstreamEditsAction: does not apply for jira provider", () => {
  assertFalse(
    checkUpstreamEditsAction(makeDeps()).applies(
      makeTicket({ ...BASE, provider: "jira" }),
    ),
  );
});

Deno.test(
  "checkUpstreamEditsAction: does not apply for intake phase",
  () => {
    assertFalse(
      checkUpstreamEditsAction(makeDeps()).applies(
        makeTicket({ ...BASE, phase: "intake" }),
      ),
    );
  },
);

Deno.test(
  "checkUpstreamEditsAction: does not apply for enrichment phase",
  () => {
    assertFalse(
      checkUpstreamEditsAction(makeDeps()).applies(
        makeTicket({ ...BASE, phase: "enrichment" }),
      ),
    );
  },
);

Deno.test(
  "checkUpstreamEditsAction: applies for implementation phase",
  () => {
    assert(
      checkUpstreamEditsAction(makeDeps()).applies(
        makeTicket({ ...BASE, phase: "implementation" }),
      ),
    );
  },
);

Deno.test("checkUpstreamEditsAction: applies for merge phase", () => {
  assert(
    checkUpstreamEditsAction(makeDeps()).applies(
      makeTicket({ ...BASE, phase: "merge", status: "waiting" }),
    ),
  );
});

Deno.test(
  "checkUpstreamEditsAction: does not apply when status is not waiting",
  () => {
    assertFalse(
      checkUpstreamEditsAction(makeDeps()).applies(
        makeTicket({ ...BASE, status: "running" }),
      ),
    );
  },
);

Deno.test(
  "checkUpstreamEditsAction: does not apply when a process is alive",
  () => {
    assertFalse(
      checkUpstreamEditsAction(
        makeDeps({ isProcessAlive: () => true }),
      ).applies(makeTicket(BASE)),
    );
  },
);

Deno.test(
  "checkUpstreamEditsAction: does not apply when checkUpstreamEdits is false",
  () => {
    assertFalse(
      checkUpstreamEditsAction(
        makeDeps({ config: makeConfig({ checkUpstreamEdits: false }) }),
      ).applies(makeTicket(BASE)),
    );
  },
);

Deno.test(
  "checkUpstreamEditsAction: fetch failure returns null without writing ticket",
  async () => {
    const writeTicketSpy = spy(() => Promise.resolve());
    const result = await checkUpstreamEditsAction(
      makeDeps({
        fetchGitHubIssue: () => Promise.resolve(null),
        writeTicket: writeTicketSpy,
      }),
    ).run(makeTicket(BASE), "/state");
    assertEquals(result, null);
    assertSpyCalls(writeTicketSpy, 0);
  },
);

Deno.test(
  "checkUpstreamEditsAction: no diff updates only lastUpstreamSyncTimestamp with no log entry",
  async () => {
    const logged: object[] = [];
    const written: TicketState[] = [];
    const result = await checkUpstreamEditsAction(
      makeDeps({
        fetchGitHubIssue: () =>
          Promise.resolve({ title: BASE.title, body: BASE.body }),
        appendLog: (_sd, _id, entry) => {
          logged.push(entry);
          return Promise.resolve();
        },
        writeTicket: (_sd, t) => {
          written.push(t);
          return Promise.resolve();
        },
      }),
    ).run(makeTicket(BASE), "/state");
    assertEquals(logged.length, 0);
    assert(
      (result as TicketState | null)?.lastUpstreamSyncTimestamp !== undefined,
    );
    assertEquals(written[0].title, BASE.title);
    assertEquals(written[0].body, BASE.body);
    assertEquals(written[0].status, "waiting");
  },
);

Deno.test(
  "checkUpstreamEditsAction: no diff does not call judgeUpstreamEdit",
  async () => {
    const judgeSpy = spy(() => Promise.resolve(false));
    await checkUpstreamEditsAction(
      makeDeps({
        fetchGitHubIssue: () =>
          Promise.resolve({ title: BASE.title, body: BASE.body }),
        judgeUpstreamEdit: judgeSpy,
      }),
    ).run(makeTicket(BASE), "/state");
    assertSpyCalls(judgeSpy, 0);
  },
);

Deno.test(
  "checkUpstreamEditsAction: substantive edit sets status to revising and writes context file",
  async () => {
    const writeContextSpy = spy(() => Promise.resolve());
    const result = await checkUpstreamEditsAction(
      makeDeps({
        fetchGitHubIssue: () =>
          Promise.resolve({ title: BASE.title, body: "Changed body" }),
        judgeUpstreamEdit: () => Promise.resolve(true),
        writeUpstreamEditContextFile: writeContextSpy,
      }),
    ).run(makeTicket(BASE), "/state");
    assertEquals((result as TicketState | null)?.status, "revising");
    assertSpyCalls(writeContextSpy, 1);
  },
);

Deno.test(
  "checkUpstreamEditsAction: non-substantive edit does not set revising and no context file",
  async () => {
    const writeContextSpy = spy(() => Promise.resolve());
    const result = await checkUpstreamEditsAction(
      makeDeps({
        fetchGitHubIssue: () =>
          Promise.resolve({ title: BASE.title, body: "Changed body" }),
        judgeUpstreamEdit: () => Promise.resolve(false),
        writeUpstreamEditContextFile: writeContextSpy,
      }),
    ).run(makeTicket(BASE), "/state");
    assertEquals((result as TicketState | null)?.status, "waiting");
    assertSpyCalls(writeContextSpy, 0);
  },
);

Deno.test(
  "checkUpstreamEditsAction: null judge result is treated as substantive",
  async () => {
    const writeContextSpy = spy(() => Promise.resolve());
    const result = await checkUpstreamEditsAction(
      makeDeps({
        fetchGitHubIssue: () =>
          Promise.resolve({ title: BASE.title, body: "Changed body" }),
        judgeUpstreamEdit: () => Promise.resolve(null),
        writeUpstreamEditContextFile: writeContextSpy,
      }),
    ).run(makeTicket(BASE), "/state");
    assertEquals((result as TicketState | null)?.status, "revising");
    assertSpyCalls(writeContextSpy, 1);
  },
);

Deno.test(
  "checkUpstreamEditsAction: log entry includes action, titleChanged, bodyChanged, substantive",
  async () => {
    const logged: Record<string, unknown>[] = [];
    await checkUpstreamEditsAction(
      makeDeps({
        fetchGitHubIssue: () =>
          Promise.resolve({ title: "New title", body: "New body" }),
        judgeUpstreamEdit: () => Promise.resolve(false),
        appendLog: (_sd, _id, entry) => {
          logged.push(entry as Record<string, unknown>);
          return Promise.resolve();
        },
      }),
    ).run(makeTicket(BASE), "/state");
    assertEquals(logged.length, 1);
    assertEquals(logged[0].action, "check-upstream-edits");
    assertEquals(logged[0].titleChanged, true);
    assertEquals(logged[0].bodyChanged, true);
    assertEquals(logged[0].substantive, false);
  },
);

Deno.test(
  "checkUpstreamEditsAction: log entry substantive is null when judge returns null",
  async () => {
    const logged: Record<string, unknown>[] = [];
    await checkUpstreamEditsAction(
      makeDeps({
        fetchGitHubIssue: () =>
          Promise.resolve({ title: BASE.title, body: "Changed body" }),
        judgeUpstreamEdit: () => Promise.resolve(null),
        appendLog: (_sd, _id, entry) => {
          logged.push(entry as Record<string, unknown>);
          return Promise.resolve();
        },
      }),
    ).run(makeTicket(BASE), "/state");
    assertEquals(logged[0].substantive, null);
  },
);

Deno.test(
  "checkUpstreamEditsAction: title change calls generateShortTitle and updates shortTitle",
  async () => {
    const generateSpy = spy((_title: string, _body: string) =>
      Promise.resolve("Short new title")
    );
    const result = await checkUpstreamEditsAction(
      makeDeps({
        fetchGitHubIssue: () =>
          Promise.resolve({ title: "New title", body: BASE.body }),
        judgeUpstreamEdit: () => Promise.resolve(false),
        generateShortTitle: generateSpy,
      }),
    ).run(makeTicket(BASE), "/state");
    assertSpyCalls(generateSpy, 1);
    assertEquals(generateSpy.calls[0].args[0], "New title");
    assertEquals((result as TicketState | null)?.shortTitle, "Short new title");
  },
);

Deno.test(
  "checkUpstreamEditsAction: body-only change does not call generateShortTitle",
  async () => {
    const generateSpy = spy(() => Promise.resolve(null));
    await checkUpstreamEditsAction(
      makeDeps({
        fetchGitHubIssue: () =>
          Promise.resolve({ title: BASE.title, body: "Changed body" }),
        judgeUpstreamEdit: () => Promise.resolve(false),
        generateShortTitle: generateSpy,
      }),
    ).run(makeTicket(BASE), "/state");
    assertSpyCalls(generateSpy, 0);
  },
);

Deno.test(
  "checkUpstreamEditsAction: null from generateShortTitle leaves shortTitle unchanged",
  async () => {
    const result = await checkUpstreamEditsAction(
      makeDeps({
        fetchGitHubIssue: () =>
          Promise.resolve({ title: "New title", body: BASE.body }),
        judgeUpstreamEdit: () => Promise.resolve(false),
        generateShortTitle: () => Promise.resolve(null),
      }),
    ).run(makeTicket({ ...BASE, shortTitle: "Existing short" }), "/state");
    assertEquals((result as TicketState | null)?.shortTitle, "Existing short");
  },
);

Deno.test(
  "checkUpstreamEditsAction: updated ticket stores fetched title and body",
  async () => {
    const result = await checkUpstreamEditsAction(
      makeDeps({
        fetchGitHubIssue: () =>
          Promise.resolve({ title: "New title", body: "New body" }),
        judgeUpstreamEdit: () => Promise.resolve(false),
      }),
    ).run(makeTicket(BASE), "/state");
    assertEquals((result as TicketState | null)?.title, "New title");
    assertEquals((result as TicketState | null)?.body, "New body");
  },
);

Deno.test(
  "checkUpstreamEditsAction: null issue body is normalized to empty string for diff",
  async () => {
    const logged: Record<string, unknown>[] = [];
    await checkUpstreamEditsAction(
      makeDeps({
        fetchGitHubIssue: () =>
          Promise.resolve({ title: BASE.title, body: null }),
        judgeUpstreamEdit: () => Promise.resolve(false),
        appendLog: (_sd, _id, entry) => {
          logged.push(entry as Record<string, unknown>);
          return Promise.resolve();
        },
      }),
    ).run(makeTicket({ ...BASE, body: "" }), "/state");
    assertEquals(logged.length, 0);
  },
);

Deno.test(
  "checkUpstreamEditsAction: context file content includes ticket URL, old and new values",
  async () => {
    const written: { ticketDir: string; content: string }[] = [];
    await checkUpstreamEditsAction(
      makeDeps({
        fetchGitHubIssue: () =>
          Promise.resolve({ title: "New title", body: "New body" }),
        judgeUpstreamEdit: () => Promise.resolve(true),
        writeUpstreamEditContextFile: (ticketDir, content) => {
          written.push({ ticketDir, content });
          return Promise.resolve();
        },
      }),
    ).run(makeTicket(BASE), "/state");
    assertStringIncludes(
      written[0].content,
      "## Upstream edit detected on https://github.com/jackjennings/lazyboy/issues/42",
    );
    assertStringIncludes(written[0].content, "Original title");
    assertStringIncludes(written[0].content, "New title");
    assertStringIncludes(written[0].content, "Original body");
    assertStringIncludes(written[0].content, "New body");
  },
);

Deno.test(
  "checkUpstreamEditsAction: context file is written to the correct ticket directory",
  async () => {
    const written: { ticketDir: string; content: string }[] = [];
    await checkUpstreamEditsAction(
      makeDeps({
        fetchGitHubIssue: () =>
          Promise.resolve({ title: "New title", body: BASE.body }),
        judgeUpstreamEdit: () => Promise.resolve(true),
        writeUpstreamEditContextFile: (ticketDir, content) => {
          written.push({ ticketDir, content });
          return Promise.resolve();
        },
      }),
    ).run(makeTicket(BASE), "/state");
    assertEquals(
      written[0].ticketDir,
      "/state/github/jackjennings/lazyboy/42",
    );
  },
);

Deno.test(
  "checkUpstreamEditsAction: lastUpstreamSyncTimestamp is set on the updated ticket",
  async () => {
    const result = await checkUpstreamEditsAction(
      makeDeps({
        fetchGitHubIssue: () =>
          Promise.resolve({ title: "New title", body: BASE.body }),
        judgeUpstreamEdit: () => Promise.resolve(false),
      }),
    ).run(makeTicket(BASE), "/state");
    assert(
      (result as TicketState | null)?.lastUpstreamSyncTimestamp !== undefined,
    );
  },
);
