import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import matter from "gray-matter";
import {
  appendTicketLog,
  commitPrinciples,
  commitTicket,
  listLearnings,
  listTickets,
  readTicket,
  readTicketWithPatch,
  removeLearning,
  StaleTicketWriteError,
  writeLearning,
  writeTicket,
} from "./store.ts";
import { makeTicket, withLazyboyDir } from "../test-support.ts";
import type { ArtifactType, LearningState, TicketState } from "./types.ts";

const BASE = { id: "gh-1" };

async function initGitRepo(dir: string): Promise<void> {
  const run = (cmd: string[]) =>
    new Deno.Command(cmd[0], { args: cmd.slice(1), cwd: dir }).output();
  await run(["git", "init"]);
  await run(["git", "config", "user.email", "test@example.com"]);
  await run(["git", "config", "user.name", "Test User"]);
}

Deno.test("readTicket: parses worktrees from frontmatter", async () => {
  const dir = await Deno.makeTempDir();
  const ticketDir = join(dir, "gh-42");
  await Deno.mkdir(ticketDir);
  await Deno.writeTextFile(
    join(ticketDir, "meta.md"),
    `---
id: gh-42
provider: github
title: Test
url: https://github.com/jackjennings/lazyboy/issues/42
phase: waiting-intake
approved: false
scope: []
created: "2026-06-22T00:00:00Z"
updated: "2026-06-22T00:00:00Z"
worktrees:
  jackjennings/lazyboy:
    path: /home/user/.lazyboy/worktrees/gh-42/jackjennings/lazyboy
    branch: gh-42
---

body
`,
  );
  const ticket = await readTicket(dir, "gh-42");
  assertEquals(ticket.worktrees, {
    "jackjennings/lazyboy": {
      path: "/home/user/.lazyboy/worktrees/gh-42/jackjennings/lazyboy",
      branch: "gh-42",
    },
  });
  await Deno.remove(dir, { recursive: true });
});

Deno.test("readTicket: defaults worktrees to {} when field absent", async () => {
  const dir = await Deno.makeTempDir();
  const ticketDir = join(dir, "gh-1");
  await Deno.mkdir(ticketDir);
  await Deno.writeTextFile(
    join(ticketDir, "meta.md"),
    `---
id: gh-1
provider: github
title: Test
url: https://github.com/jackjennings/lazyboy/issues/1
phase: new
approved: false
scope: []
created: "2026-06-22T00:00:00Z"
updated: "2026-06-22T00:00:00Z"
---

body
`,
  );
  const ticket = await readTicket(dir, "gh-1");
  assertEquals(ticket.worktrees, {});
  await Deno.remove(dir, { recursive: true });
});

Deno.test("readTicket: migrates old phase format to two fields", async () => {
  const dir = await Deno.makeTempDir();
  const ticketDir = join(dir, "gh-1");
  await Deno.mkdir(ticketDir);
  const metaPath = join(ticketDir, "meta.md");
  await Deno.writeTextFile(
    metaPath,
    `---
id: gh-1
provider: github
title: Test
url: https://github.com/x/y/issues/1
phase: waiting-intake
approved: false
scope: []
created: "2026-06-22T00:00:00Z"
updated: "2026-06-22T00:00:00Z"
---

body
`,
  );
  const ticket = await readTicket(dir, "gh-1");
  assertEquals(ticket.phase, "intake");
  assertEquals(ticket.status, "waiting");
  const { data } = matter(await Deno.readTextFile(metaPath));
  assertEquals(data.phase, "intake");
  assertEquals(data.status, "waiting");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("readTicket: migrates all legacy phase values", async () => {
  const cases: Array<[string, string, string]> = [
    ["new", "intake", "new"],
    ["running-intake", "intake", "running"],
    ["waiting-enrichment", "enrichment", "waiting"],
    ["running-spec", "spec", "running"],
    ["waiting-plan", "plan", "waiting"],
    ["running-implementation", "implementation", "running"],
    ["waiting-diff", "implementation", "waiting"],
    ["waiting-merge", "merge", "waiting"],
    ["needs-attention", "intake", "needs-attention"],
    ["done", "merge", "done"],
  ];
  for (const [oldPhase, expectedPhase, expectedStatus] of cases) {
    const dir = await Deno.makeTempDir();
    const ticketDir = join(dir, "gh-1");
    await Deno.mkdir(ticketDir);
    await Deno.writeTextFile(
      join(ticketDir, "meta.md"),
      `---
id: gh-1
provider: github
title: Test
url: https://github.com/x/y/issues/1
phase: ${oldPhase}
approved: false
scope: []
created: "2026-06-22T00:00:00Z"
updated: "2026-06-22T00:00:00Z"
---
`,
    );
    const ticket = await readTicket(dir, "gh-1");
    assertEquals(ticket.phase, expectedPhase, `phase for old="${oldPhase}"`);
    assertEquals(
      ticket.status,
      expectedStatus,
      `status for old="${oldPhase}"`,
    );
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readTicket: reads new-format file without rewriting", async () => {
  const dir = await Deno.makeTempDir();
  const ticketDir = join(dir, "gh-1");
  await Deno.mkdir(ticketDir);
  const metaPath = join(ticketDir, "meta.md");
  const original = `---
id: gh-1
provider: github
title: Test
url: https://github.com/x/y/issues/1
phase: enrichment
status: waiting
approved: false
scope: []
created: "2026-06-22T00:00:00Z"
updated: "2026-06-22T00:00:00Z"
---

body
`;
  await Deno.writeTextFile(metaPath, original);
  const mtime1 = (await Deno.stat(metaPath)).mtime;
  const ticket = await readTicket(dir, "gh-1");
  assertEquals(ticket.phase, "enrichment");
  assertEquals(ticket.status, "waiting");
  const mtime2 = (await Deno.stat(metaPath)).mtime;
  assertEquals(mtime1?.getTime(), mtime2?.getTime());
  await Deno.remove(dir, { recursive: true });
});

Deno.test("readTicket: names the ticket when the phase is unrecognized", async () => {
  const dir = await Deno.makeTempDir();
  const ticketDir = join(dir, "jira", "NW-1");
  await Deno.mkdir(ticketDir, { recursive: true });
  await Deno.writeTextFile(
    join(ticketDir, "meta.md"),
    `---
id: jira/NW-1
provider: jira
title: Test
url: https://example.atlassian.net/browse/NW-1
phase: implement
status: running
scope: []
created: "2026-08-14T00:00:00Z"
updated: "2026-08-14T00:00:00Z"
---

body
`,
  );
  const error = await assertRejects(
    () => readTicket(dir, "jira/NW-1"),
    Error,
  );
  assertStringIncludes(error.message, "jira/NW-1");
  assertStringIncludes(error.message, "implement");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("writeTicket: persists phase and status as separate YAML fields", async () => {
  const dir = await Deno.makeTempDir();
  const ticket: TicketState = makeTicket({
    id: "gh-5",
    phase: "enrichment",
    status: "running",
  });
  await writeTicket(dir, ticket);
  const { data } = matter(
    await Deno.readTextFile(join(dir, "gh-5", "meta.md")),
  );
  assertEquals(data.phase, "enrichment");
  assertEquals(data.status, "running");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("writeTicket: round-trips worktrees through meta.md", async () => {
  const dir = await Deno.makeTempDir();
  const ticket: TicketState = makeTicket({
    id: "gh-42",
    url: "https://github.com/jackjennings/lazyboy/issues/42",
    worktrees: {
      "jackjennings/lazyboy": {
        path: "/tmp/.lazyboy/worktrees/gh-42/jackjennings/lazyboy",
        branch: "gh-42",
      },
    },
  });
  await writeTicket(dir, ticket);
  const read = await readTicket(dir, "gh-42");
  assertEquals(read.worktrees["jackjennings/lazyboy"].branch, "gh-42");
  assertEquals(
    read.worktrees["jackjennings/lazyboy"].path,
    "/tmp/.lazyboy/worktrees/gh-42/jackjennings/lazyboy",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("writeTicket: round-trips lastSeenCommentTimestamp through meta.md", async () => {
  const dir = await Deno.makeTempDir();
  const ticket: TicketState = makeTicket({
    id: "gh-7",
    lastSeenCommentTimestamp: "2026-08-12T18:30:00.000Z",
  });
  await writeTicket(dir, ticket);
  const read = await readTicket(dir, "gh-7");
  assertEquals(read.lastSeenCommentTimestamp, "2026-08-12T18:30:00.000Z");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("writeTicket: round-trips providerDone through meta.md", async () => {
  const dir = await Deno.makeTempDir();
  const ticket: TicketState = makeTicket({
    id: "jira/NW-1",
    provider: "jira",
    phase: "merge",
    status: "done",
    providerDone: true,
  });
  await writeTicket(dir, ticket);
  const read = await readTicket(dir, "jira/NW-1");
  assert(read.providerDone);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("writeTicket: omits providerDone from frontmatter when not set", async () => {
  const dir = await Deno.makeTempDir();
  await writeTicket(dir, makeTicket({ id: "gh-1" }));
  const raw = await Deno.readTextFile(join(dir, "gh-1", "meta.md"));
  assertFalse(raw.includes("providerDone"));
  await Deno.remove(dir, { recursive: true });
});

Deno.test("writeTicket: round-trips ciHandledRunIds through meta.md", async () => {
  const dir = await Deno.makeTempDir();
  const ticket: TicketState = makeTicket({
    id: "gh-2",
    ciHandledRunIds: ["123-1", "123-2"],
  });
  await writeTicket(dir, ticket);
  const read = await readTicket(dir, "gh-2");
  assertEquals(read.ciHandledRunIds, ["123-1", "123-2"]);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("writeTicket: round-trips phaseSessionIds through meta.md", async () => {
  const dir = await Deno.makeTempDir();
  const ticket: TicketState = makeTicket({
    id: "gh-3",
    phaseSessionIds: { implementation: "d5a1440e-14f5-498d-a29c-cf777bc969d5" },
  });
  await writeTicket(dir, ticket);
  const read = await readTicket(dir, "gh-3");
  assertEquals(
    read.phaseSessionIds?.implementation,
    "d5a1440e-14f5-498d-a29c-cf777bc969d5",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("writeTicket: drops phaseSessionIds entries cleared to undefined", async () => {
  const dir = await Deno.makeTempDir();
  const ticket: TicketState = makeTicket({
    id: "gh-5",
    phaseSessionIds: { spec: "abc", implementation: undefined },
  });
  await writeTicket(dir, ticket);
  const read = await readTicket(dir, "gh-5");
  assertEquals(read.phaseSessionIds?.spec, "abc");
  assertFalse("implementation" in (read.phaseSessionIds ?? {}));
  await Deno.remove(dir, { recursive: true });
});

Deno.test("writeTicket: omits phaseSessionIds when every entry is undefined", async () => {
  const dir = await Deno.makeTempDir();
  const ticket: TicketState = makeTicket({
    id: "gh-6",
    phaseSessionIds: { implementation: undefined },
  });
  await writeTicket(dir, ticket);
  const raw = await Deno.readTextFile(join(dir, "gh-6", "meta.md"));
  assertFalse(raw.includes("phaseSessionIds"));
  await Deno.remove(dir, { recursive: true });
});

Deno.test("writeTicket: round-trips notifiedNeedsAttention through meta.md", async () => {
  const dir = await Deno.makeTempDir();
  const ticket: TicketState = makeTicket({
    id: "gh-4",
    phase: "spec",
    status: "needs-attention",
    notifiedNeedsAttention: true,
  });
  await writeTicket(dir, ticket);
  const read = await readTicket(dir, "gh-4");
  assert(read.notifiedNeedsAttention);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("readTicket: normalizes an unquoted lastSeenCommentTimestamp to an ISO string", async () => {
  const dir = await Deno.makeTempDir();
  const ticketDir = join(dir, "gh-8");
  await Deno.mkdir(ticketDir);
  await Deno.writeTextFile(
    join(ticketDir, "meta.md"),
    `---
id: gh-8
provider: github
title: Test
url: https://github.com/x/y/issues/8
phase: implementation
status: waiting
scope: []
created: "2026-06-22T00:00:00Z"
updated: "2026-06-22T00:00:00Z"
lastSeenCommentTimestamp: 2026-08-12T18:30:00.000Z
---

body
`,
  );
  const ticket = await readTicket(dir, "gh-8");
  assertEquals(ticket.lastSeenCommentTimestamp, "2026-08-12T18:30:00.000Z");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("listTickets: returns all ticket IDs", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(
    join(dir, "github", "jackjennings", "lazyboy", "1"),
    { recursive: true },
  );
  await Deno.mkdir(
    join(dir, "github", "jackjennings", "lazyboy", "2"),
    { recursive: true },
  );
  await Deno.writeTextFile(
    join(dir, "github", "jackjennings", "lazyboy", "1", "meta.md"),
    "---\nid: github/jackjennings/lazyboy/1\n---\n",
  );
  await Deno.writeTextFile(
    join(dir, "github", "jackjennings", "lazyboy", "2", "meta.md"),
    "---\nid: github/jackjennings/lazyboy/2\n---\n",
  );
  const ids = await listTickets(dir);
  assertEquals(ids.sort(), [
    "github/jackjennings/lazyboy/1",
    "github/jackjennings/lazyboy/2",
  ]);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("listTickets: returns empty array when stateDir does not exist", async () => {
  const ids = await listTickets("/nonexistent/state/dir");
  assertEquals(ids, []);
});

Deno.test("listTickets: skips dot-prefixed directories at every depth", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, ".migrations"), { recursive: true });
  await Deno.mkdir(
    join(dir, "github", "jackjennings", "lazyboy", "1"),
    { recursive: true },
  );
  await Deno.writeTextFile(
    join(dir, ".migrations", "meta.md"),
    "---\nid: .migrations\n---\n",
  );
  await Deno.writeTextFile(
    join(dir, "github", "jackjennings", "lazyboy", "1", "meta.md"),
    "---\nid: github/jackjennings/lazyboy/1\n---\n",
  );
  const ids = await listTickets(dir);
  assertEquals(ids, ["github/jackjennings/lazyboy/1"]);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("commitTicket: stages only files in the ticket's directory", async () => {
  const dir = await Deno.makeTempDir();
  await initGitRepo(dir);
  const run = (cmd: string[]) =>
    new Deno.Command(cmd[0], { args: cmd.slice(1), cwd: dir }).output();

  await Deno.mkdir(join(dir, "gh-30"));
  await Deno.mkdir(join(dir, "gh-99"));
  await Deno.writeTextFile(
    join(dir, "gh-30", "meta.md"),
    "---\nid: gh-30\n---\n",
  );
  await Deno.writeTextFile(
    join(dir, "gh-99", "meta.md"),
    "---\nid: gh-99\n---\n",
  );
  await run(["git", "add", "-A"]);
  await run(["git", "commit", "-m", "initial"]);

  await Deno.writeTextFile(
    join(dir, "gh-30", "meta.md"),
    "---\nid: gh-30\napproved: true\n---\n",
  );
  await Deno.writeTextFile(
    join(dir, "gh-99", "meta.md"),
    "---\nid: gh-99\nstale: true\n---\n",
  );

  await commitTicket(dir, "gh-30", "approve: gh-30");

  const diffOutput = await run([
    "git",
    "diff",
    "HEAD~1",
    "HEAD",
    "--name-only",
  ]);
  const changedFiles = new TextDecoder().decode(diffOutput.stdout).trim().split(
    "\n",
  ).filter((f) => f);
  assertEquals(changedFiles, ["gh-30/meta.md"]);

  await Deno.remove(dir, { recursive: true });
});

Deno.test("commitTicket: silently succeeds when nothing to commit", async () => {
  const dir = await Deno.makeTempDir();
  await initGitRepo(dir);
  const run = (cmd: string[]) =>
    new Deno.Command(cmd[0], { args: cmd.slice(1), cwd: dir }).output();

  await Deno.mkdir(join(dir, "gh-30"));
  await Deno.writeTextFile(
    join(dir, "gh-30", "meta.md"),
    "---\nid: gh-30\n---\n",
  );
  await run(["git", "add", "-A"]);
  await run(["git", "commit", "-m", "initial"]);

  const headBefore = await run(["git", "rev-parse", "HEAD"]);
  const hashBefore = new TextDecoder().decode(headBefore.stdout).trim();

  await commitTicket(dir, "gh-30", "approve: gh-30");

  const headAfter = await run(["git", "rev-parse", "HEAD"]);
  const hashAfter = new TextDecoder().decode(headAfter.stdout).trim();
  assertEquals(hashBefore, hashAfter);

  await Deno.remove(dir, { recursive: true });
});

Deno.test("appendTicketLog: creates log.ndjson with a single JSON entry", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "gh-1"));
  await appendTicketLog(dir, "gh-1", {
    event: "phase-transition",
    from: "new",
    to: "running-intake",
  });
  const content = await Deno.readTextFile(join(dir, "gh-1", "log.ndjson"));
  const parsed = JSON.parse(content.trim());
  assertEquals(parsed.event, "phase-transition");
  assertEquals(parsed.from, "new");
  assertEquals(parsed.to, "running-intake");
  assertEquals(typeof parsed.ts, "string");
  assertFalse(isNaN(Date.parse(parsed.ts)));
  await Deno.remove(dir, { recursive: true });
});

Deno.test("appendTicketLog: appends successive entries on separate lines", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "gh-1"));
  await appendTicketLog(dir, "gh-1", { event: "a" });
  await appendTicketLog(dir, "gh-1", { event: "b" });
  const content = await Deno.readTextFile(join(dir, "gh-1", "log.ndjson"));
  const lines = content.trim().split("\n");
  assertEquals(lines.length, 2);
  assertEquals(JSON.parse(lines[0]).event, "a");
  assertEquals(JSON.parse(lines[1]).event, "b");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("appendTicketLog: writes combined log entry with id field", async () => {
  using lazy = withLazyboyDir();
  const stateDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(stateDir, "github/test/repo/1"), { recursive: true });
    await appendTicketLog(stateDir, "github/test/repo/1", {
      event: "phase-start",
    });
    const combined = await Deno.readTextFile(
      join(lazy.path, "log.ndjson"),
    );
    const parsed = JSON.parse(combined.trim());
    assertEquals(parsed.id, "github/test/repo/1");
    assertEquals(parsed.event, "phase-start");
    assertEquals(typeof parsed.ts, "string");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("appendTicketLog: per-ticket log entry has no id field", async () => {
  using _lazy = withLazyboyDir();
  const stateDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(stateDir, "gh-1"));
    await appendTicketLog(stateDir, "gh-1", { event: "status-transition" });
    const ticket = await Deno.readTextFile(
      join(stateDir, "gh-1", "log.ndjson"),
    );
    const parsed = JSON.parse(ticket.trim());
    assertEquals(parsed.id, undefined);
    assertEquals(parsed.event, "status-transition");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("appendTicketLog: primary write succeeds when combined log write fails", async () => {
  using lazy = withLazyboyDir();
  const stateDir = await Deno.makeTempDir();
  try {
    // make log.ndjson a directory so writeTextFile to it fails
    await Deno.mkdir(join(lazy.path, "log.ndjson"), { recursive: true });
    await Deno.mkdir(join(stateDir, "gh-1"));
    await appendTicketLog(stateDir, "gh-1", { event: "error" });
    const ticket = await Deno.readTextFile(
      join(stateDir, "gh-1", "log.ndjson"),
    );
    assertEquals(JSON.parse(ticket.trim()).event, "error");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("readTicket: reads phases field from frontmatter", async () => {
  const dir = await Deno.makeTempDir();
  const ticketDir = join(dir, "gh-1");
  await Deno.mkdir(ticketDir);
  await Deno.writeTextFile(
    join(ticketDir, "meta.md"),
    `---
id: gh-1
provider: github
title: T
url: https://github.com/x/y/issues/1
phase: plan
status: waiting
approved: false
scope: []
worktrees: {}
created: "2026-07-01T00:00:00Z"
updated: "2026-07-01T00:00:00Z"
phases:
  implementation:
    model: claude-opus-4-5
    thinking: xhigh
---
`,
  );
  const ticket = await readTicket(dir, "gh-1");
  assertEquals(ticket.phases?.implementation?.model, "claude-opus-4-5");
  assertEquals(ticket.phases?.implementation?.thinking, "xhigh");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("writeTicket: round-trips phases through meta.md", async () => {
  const dir = await Deno.makeTempDir();
  const ticket: TicketState = makeTicket({
    id: "gh-7",
    phase: "plan",
    status: "waiting",
    phases: { implementation: { model: "claude-opus-4-6", thinking: "high" } },
  });
  await writeTicket(dir, ticket);
  const read = await readTicket(dir, "gh-7");
  assertEquals(read.phases?.implementation?.model, "claude-opus-4-6");
  assertEquals(read.phases?.implementation?.thinking, "high");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("writeTicket: omits phases key when undefined", async () => {
  const dir = await Deno.makeTempDir();
  const ticket: TicketState = makeTicket({ id: "gh-8" });
  await writeTicket(dir, ticket);
  const raw = await Deno.readTextFile(join(dir, "gh-8", "meta.md"));
  assertFalse(raw.includes("phases:"));
  await Deno.remove(dir, { recursive: true });
});

Deno.test("writeTicket: preserves all phases entries on round-trip", async () => {
  const dir = await Deno.makeTempDir();
  const ticket: TicketState = makeTicket({
    id: "gh-phases-test",
    phase: "plan",
    status: "waiting",
    phases: {
      implementation: { model: "claude-sonnet-4-6", thinking: "high" },
      enrichment: { model: "claude-haiku-4-5", thinking: "off" },
    },
  });
  await writeTicket(dir, ticket);
  const read = await readTicket(dir, "gh-phases-test");
  assertEquals(read.phases?.enrichment?.model, "claude-haiku-4-5");
  assertEquals(read.phases?.implementation?.model, "claude-sonnet-4-6");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("readTicket: reads prs array from frontmatter", async () => {
  const dir = await Deno.makeTempDir();
  const ticketDir = join(dir, "gh-1");
  await Deno.mkdir(ticketDir);
  await Deno.writeTextFile(
    join(ticketDir, "meta.md"),
    `---
id: gh-1
provider: github
title: T
url: https://github.com/x/y/issues/1
phase: merge
status: waiting
approved: false
scope: []
worktrees: {}
created: "2026-07-01T00:00:00Z"
updated: "2026-07-01T00:00:00Z"
prs:
  - url: https://github.com/x/y/pull/1
    title: my PR
    dependsOn: []
    merged: false
    worktreeKey: x/y
---
`,
  );
  const ticket = await readTicket(dir, "gh-1");
  assertEquals(ticket.prs?.length, 1);
  assertEquals(ticket.prs?.[0].url, "https://github.com/x/y/pull/1");
  assertEquals(ticket.prs?.[0].title, "my PR");
  assertEquals(ticket.prs?.[0].merged, false);
  assertEquals(ticket.prs?.[0].dependsOn, []);
  assertEquals(ticket.prs?.[0].worktreeKey, "x/y");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("readTicket: prs is undefined when neither prs nor prUrl present", async () => {
  const dir = await Deno.makeTempDir();
  const ticketDir = join(dir, "gh-3");
  await Deno.mkdir(ticketDir);
  await Deno.writeTextFile(
    join(ticketDir, "meta.md"),
    `---
id: gh-3
provider: github
title: T
url: https://github.com/x/y/issues/3
phase: intake
status: new
approved: false
scope: []
worktrees: {}
created: "2026-07-01T00:00:00Z"
updated: "2026-07-01T00:00:00Z"
---
`,
  );
  const ticket = await readTicket(dir, "gh-3");
  assertEquals(ticket.prs, undefined);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("writeTicket: round-trips prs array through meta.md", async () => {
  const dir = await Deno.makeTempDir();
  const ticket: TicketState = makeTicket({
    id: "gh-4",
    phase: "merge",
    status: "waiting",
    prs: [{
      url: "https://github.com/x/y/pull/10",
      title: "feat: my PR",
      dependsOn: [],
      merged: false,
      worktreeKey: "x/y",
    }],
  });
  await writeTicket(dir, ticket);
  const read = await readTicket(dir, "gh-4");
  assertEquals(read.prs?.length, 1);
  assertEquals(read.prs?.[0].url, "https://github.com/x/y/pull/10");
  assertEquals(read.prs?.[0].merged, false);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("writeTicket: does not write approved key to frontmatter", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeTicket(dir, makeTicket({ ...BASE, approvals: [] }));
    const raw = await Deno.readTextFile(join(dir, "gh-1", "meta.md"));
    assertFalse(raw.includes("approved:"));
    assertStringIncludes(raw, "approvals:");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readTicket: reads approvals array from frontmatter", async () => {
  const dir = await Deno.makeTempDir();
  const ticketDir = join(dir, "gh-1");
  await Deno.mkdir(ticketDir, { recursive: true });
  await Deno.writeTextFile(
    join(ticketDir, "meta.md"),
    `---
id: gh-1
provider: github
title: T
url: u
phase: spec
status: waiting
approvals:
  - timestamp: "2026-07-01T00:00:00Z"
    actor: human
    phase: spec
scope: []
worktrees: {}
created: "2026-07-01T00:00:00Z"
updated: "2026-07-01T00:00:00Z"
---

body
`,
  );
  try {
    const ticket = await readTicket(dir, "gh-1");
    assertEquals(ticket.approvals.length, 1);
    assertEquals(ticket.approvals[0].actor, "human");
    assertEquals(ticket.approvals[0].phase, "spec");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readTicket: defaults approvals to [] when field absent", async () => {
  const dir = await Deno.makeTempDir();
  const ticketDir = join(dir, "gh-1");
  await Deno.mkdir(ticketDir, { recursive: true });
  await Deno.writeTextFile(
    join(ticketDir, "meta.md"),
    `---
id: gh-1
provider: github
title: T
url: u
phase: new
scope: []
worktrees: {}
created: "2026-07-01T00:00:00Z"
updated: "2026-07-01T00:00:00Z"
---

body
`,
  );
  try {
    const ticket = await readTicket(dir, "gh-1");
    assertEquals(ticket.approvals, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeTicket: includes shortTitle in frontmatter when set", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const ticket = makeTicket({ shortTitle: "Short form" });
    await writeTicket(dir, ticket);
    const raw = await Deno.readTextFile(join(dir, ticket.id, "meta.md"));
    const { data } = matter(raw);
    assertEquals(data.shortTitle, "Short form");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeTicket: omits shortTitle from frontmatter when not set", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const ticket = makeTicket();
    await writeTicket(dir, ticket);
    const raw = await Deno.readTextFile(join(dir, ticket.id, "meta.md"));
    assertFalse(raw.includes("shortTitle"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readTicket: reads shortTitle from frontmatter", async () => {
  const dir = await Deno.makeTempDir();
  const ticketDir = join(dir, "gh-1");
  await Deno.mkdir(ticketDir, { recursive: true });
  await Deno.writeTextFile(
    join(ticketDir, "meta.md"),
    `---
id: gh-1
provider: github
title: A long title for this issue
shortTitle: Short form
url: https://github.com/x/y/issues/1
phase: intake
status: new
approvals: []
scope: []
worktrees: {}
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
---
`,
  );
  const ticket = await readTicket(dir, "gh-1");
  assertEquals(ticket.shortTitle, "Short form");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("readTicket: shortTitle is undefined when absent from frontmatter", async () => {
  const dir = await Deno.makeTempDir();
  const ticketDir = join(dir, "gh-1");
  await Deno.mkdir(ticketDir, { recursive: true });
  await Deno.writeTextFile(
    join(ticketDir, "meta.md"),
    `---
id: gh-1
provider: github
title: A long title
url: https://github.com/x/y/issues/1
phase: intake
status: new
approvals: []
scope: []
worktrees: {}
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
---
`,
  );
  const ticket = await readTicket(dir, "gh-1");
  assertEquals(ticket.shortTitle, undefined);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("writeTicket/readTicket: outputRetries round-trips through YAML frontmatter", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const ticket = makeTicket({ ...BASE, outputRetries: 1 });
    await writeTicket(dir, ticket);
    const read = await readTicket(dir, "gh-1");
    assertEquals(read.outputRetries, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeTicket/readTicket: outputRetries absent when undefined", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeTicket(dir, makeTicket(BASE));
    const raw = await Deno.readTextFile(join(dir, "gh-1", "meta.md"));
    assertFalse(raw.includes("outputRetries"));
    const read = await readTicket(dir, "gh-1");
    assertEquals(read.outputRetries, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("commitPrinciples: commits principles.md to git", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await initGitRepo(dir);
    await Deno.writeTextFile(join(dir, "principles.md"), "- learn A");
    const run = (cmd: string[]) =>
      new Deno.Command(cmd[0], { args: cmd.slice(1), cwd: dir }).output();
    await run(["git", "add", "-A"]);
    await run(["git", "commit", "-m", "init"]);
    await Deno.writeTextFile(
      join(dir, "principles.md"),
      "- learn A\n- learn B",
    );
    await commitPrinciples(dir, "principles: test");
    const log = await run(["git", "log", "--oneline"]);
    const logText = new TextDecoder().decode(log.stdout);
    assertStringIncludes(logText, "principles: test");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("commitPrinciples: succeeds silently when nothing to commit", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await initGitRepo(dir);
    await Deno.writeTextFile(join(dir, "principles.md"), "- learn A");
    const run = (cmd: string[]) =>
      new Deno.Command(cmd[0], { args: cmd.slice(1), cwd: dir }).output();
    await run(["git", "add", "-A"]);
    await run(["git", "commit", "-m", "init"]);
    await commitPrinciples(dir, "principles: noop");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("commitPrinciples: stages custom relPath file when provided", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await initGitRepo(dir);
    const run = (cmd: string[]) =>
      new Deno.Command(cmd[0], { args: cmd.slice(1), cwd: dir }).output();
    await run(["git", "commit", "--allow-empty", "-m", "init"]);
    await Deno.mkdir(join(dir, "principles", "github", "acme"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(dir, "principles", "github", "acme", "repo.md"),
      "- local principle",
    );
    await commitPrinciples(
      dir,
      "principles: local",
      "principles/github/acme/repo.md",
    );
    const log = await run(["git", "log", "--oneline"]);
    assertStringIncludes(
      new TextDecoder().decode(log.stdout),
      "principles: local",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("commitTicket: commits with urras bot identity", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await initGitRepo(dir);
    const run = (cmd: string[]) =>
      new Deno.Command(cmd[0], { args: cmd.slice(1), cwd: dir }).output();
    await Deno.mkdir(join(dir, "gh-50"));
    await Deno.writeTextFile(
      join(dir, "gh-50", "meta.md"),
      "---\nid: gh-50\n---\n",
    );
    await run(["git", "add", "-A"]);
    await run(["git", "commit", "-m", "initial"]);
    await Deno.writeTextFile(
      join(dir, "gh-50", "meta.md"),
      "---\nid: gh-50\napproved: true\n---\n",
    );
    await commitTicket(dir, "gh-50", "approve: gh-50");
    const author = await run(["git", "log", "--format=%an <%ae>", "-1"]);
    assertEquals(
      new TextDecoder().decode(author.stdout).trim(),
      "urras <urras@localhost>",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("commitPrinciples: commits with urras bot identity", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await initGitRepo(dir);
    const run = (cmd: string[]) =>
      new Deno.Command(cmd[0], { args: cmd.slice(1), cwd: dir }).output();
    await Deno.writeTextFile(join(dir, "principles.md"), "- learn A");
    await run(["git", "add", "-A"]);
    await run(["git", "commit", "-m", "init"]);
    await Deno.writeTextFile(
      join(dir, "principles.md"),
      "- learn A\n- learn B",
    );
    await commitPrinciples(dir, "principles: identity test");
    const author = await run(["git", "log", "--format=%an <%ae>", "-1"]);
    assertEquals(
      new TextDecoder().decode(author.stdout).trim(),
      "urras <urras@localhost>",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

function makeLearning(overrides: Partial<LearningState> = {}): LearningState {
  return {
    id: "20260729T050000",
    ticketId: "github/jackjennings/lazyboy/226",
    repo: "jackjennings/lazyboy",
    targetFile: "src/phases/prompts/implementation.md",
    prTitle:
      "Improve prompt to prevent edit fragmentation observed in github/jackjennings/lazyboy/226",
    prBody: "Body text",
    status: "pending",
    prs: [],
    ...overrides,
  };
}

const INTENT = "Enumerate all call sites before renaming a function.";

Deno.test("writeLearning: writes gray-matter .md with intent as body", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeLearning(dir, makeLearning(), INTENT);
    const raw = await Deno.readTextFile(
      join(dir, "learnings", "20260729T050000.md"),
    );
    const { data, content } = matter(raw);
    assertEquals(data.id, "20260729T050000");
    assertEquals(data.ticketId, "github/jackjennings/lazyboy/226");
    assertEquals(data.repo, "jackjennings/lazyboy");
    assertEquals(data.targetFile, "src/phases/prompts/implementation.md");
    assertEquals(data.status, "pending");
    assertEquals(data.prs, []);
    assertEquals(data.prBody, "Body text");
    assertEquals(content.trim(), INTENT);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test(
  "writeLearning: creates learnings directory when absent",
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      await writeLearning(dir, makeLearning(), INTENT);
      const stat = await Deno.stat(join(dir, "learnings"));
      assert(stat.isDirectory);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "listLearnings: returns each learning paired with its intent",
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      await writeLearning(dir, makeLearning({ id: "20260729T050000" }), INTENT);
      await writeLearning(
        dir,
        makeLearning({
          id: "20260729T050001",
          ticketId: "github/jackjennings/lazyboy/227",
        }),
        "Read the file once and hold it in memory.",
      );
      const entries = await listLearnings(dir);
      assertEquals(entries.length, 2);
      const byId = new Map(entries.map((e) => [e.learning.id, e]));
      assertEquals(byId.get("20260729T050000")!.intent, INTENT);
      assertEquals(
        byId.get("20260729T050001")!.intent,
        "Read the file once and hold it in memory.",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "listLearnings: defaults status to pending and prs to [] when omitted",
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(join(dir, "learnings"));
      await Deno.writeTextFile(
        join(dir, "learnings", "20260729T050000.md"),
        `---
id: "20260729T050000"
ticketId: github/jackjennings/lazyboy/226
repo: jackjennings/lazyboy
targetFile: src/phases/prompts/implementation.md
prTitle: Improve prompt
prBody: Body text
---

Enumerate all call sites.
`,
      );
      const entries = await listLearnings(dir);
      assertEquals(entries.length, 1);
      assertEquals(entries[0].learning.status, "pending");
      assertEquals(entries[0].learning.prs, []);
      assertEquals(entries[0].intent, "Enumerate all call sites.");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "listLearnings: returns empty array when learnings directory absent",
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      const entries = await listLearnings(dir);
      assertEquals(entries, []);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "listLearnings: skips files without an id and continues",
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(join(dir, "learnings"));
      await Deno.writeTextFile(
        join(dir, "learnings", "bad.md"),
        "no frontmatter here",
      );
      await writeLearning(dir, makeLearning({ id: "20260729T050000" }), INTENT);
      const entries = await listLearnings(dir);
      assertEquals(entries.length, 1);
      assertEquals(entries[0].learning.id, "20260729T050000");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test("removeLearning: deletes the entry file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeLearning(dir, makeLearning({ id: "20260729T050000" }), INTENT);
    await removeLearning(dir, "20260729T050000");
    let threw = false;
    try {
      await Deno.stat(join(dir, "learnings", "20260729T050000.md"));
    } catch {
      threw = true;
    }
    assert(threw);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("removeLearning: is a no-op when file not found", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await removeLearning(dir, "nonexistent");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeTicket/readTicket: artifacts round-trips through YAML frontmatter", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const ticket = makeTicket({ artifacts: ["document"] });
    await writeTicket(dir, ticket);
    const raw = await Deno.readTextFile(join(dir, ticket.id, "meta.md"));
    assertStringIncludes(raw, "artifacts:");
    const read = await readTicket(dir, ticket.id);
    assertEquals(read.artifacts, ["document"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeTicket always writes artifacts even for default ['code']", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeTicket(dir, makeTicket(BASE));
    const raw = await Deno.readTextFile(join(dir, "gh-1", "meta.md"));
    assertStringIncludes(raw, "artifacts:");
    const read = await readTicket(dir, "gh-1");
    assertEquals(read.artifacts, ["code"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeTicket/readTicket: documents round-trips through YAML frontmatter", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const pages = [{ url: "https://notion.so/abc", title: "Doc" }];
    const ticket = makeTicket({ artifacts: ["document"], documents: pages });
    await writeTicket(dir, ticket);
    const read = await readTicket(dir, ticket.id);
    assertEquals(read.documents, pages);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test(
  "writeTicket/readTicket: round-trips phases.plan.skip: true",
  async () => {
    const dir = await Deno.makeTempDir();
    const ticket = makeTicket({
      id: "gh-5",
      phases: { plan: { skip: true } },
    });
    await writeTicket(dir, ticket);
    const { data } = matter(
      await Deno.readTextFile(join(dir, "gh-5", "meta.md")),
    );
    assertEquals(data.phases?.plan?.skip, true);
    const read = await readTicket(dir, "gh-5");
    assertEquals(read.phases?.plan?.skip, true);
    await Deno.remove(dir, { recursive: true });
  },
);

Deno.test("writeTicket: omits phases.plan.skip when absent", async () => {
  const dir = await Deno.makeTempDir();
  const ticket = makeTicket({ id: "gh-5" });
  await writeTicket(dir, ticket);
  const { data } = matter(
    await Deno.readTextFile(join(dir, "gh-5", "meta.md")),
  );
  assertFalse(data.phases?.plan?.skip === true);
  await Deno.remove(dir, { recursive: true });
});

Deno.test(
  "readTicket: normalizes prs entry missing dependsOn to empty array",
  async () => {
    const dir = await Deno.makeTempDir();
    const ticketDir = join(dir, "gh-1");
    await Deno.mkdir(ticketDir);
    await Deno.writeTextFile(
      join(ticketDir, "meta.md"),
      `---
id: gh-1
provider: github
title: T
url: https://github.com/x/y/issues/1
phase: merge
status: waiting
scope: []
worktrees: {}
created: "2026-07-01T00:00:00Z"
updated: "2026-07-01T00:00:00Z"
prs:
  - url: https://github.com/x/y/pull/1
    title: my PR
    merged: false
---
`,
    );
    try {
      const ticket = await readTicket(dir, "gh-1");
      assertEquals(ticket.prs?.length, 1);
      assertEquals(ticket.prs?.[0].dependsOn, []);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test("readTicket: drops prs entry with missing url", async () => {
  const dir = await Deno.makeTempDir();
  const ticketDir = join(dir, "gh-1");
  await Deno.mkdir(ticketDir);
  await Deno.writeTextFile(
    join(ticketDir, "meta.md"),
    `---
id: gh-1
provider: github
title: T
url: https://github.com/x/y/issues/1
phase: merge
status: waiting
scope: []
worktrees: {}
created: "2026-07-01T00:00:00Z"
updated: "2026-07-01T00:00:00Z"
prs:
  - title: no url here
    dependsOn: []
    merged: false
---
`,
  );
  try {
    const ticket = await readTicket(dir, "gh-1");
    assertEquals(ticket.prs, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test(
  "readTicket: normalizes prs entry missing merged to false",
  async () => {
    const dir = await Deno.makeTempDir();
    const ticketDir = join(dir, "gh-1");
    await Deno.mkdir(ticketDir);
    await Deno.writeTextFile(
      join(ticketDir, "meta.md"),
      `---
id: gh-1
provider: github
title: T
url: https://github.com/x/y/issues/1
phase: merge
status: waiting
scope: []
worktrees: {}
created: "2026-07-01T00:00:00Z"
updated: "2026-07-01T00:00:00Z"
prs:
  - url: https://github.com/x/y/pull/1
    title: my PR
    dependsOn: []
---
`,
    );
    try {
      const ticket = await readTicket(dir, "gh-1");
      assertEquals(ticket.prs?.[0].merged, false);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "readTicket: normalizes prs entry missing title to empty string",
  async () => {
    const dir = await Deno.makeTempDir();
    const ticketDir = join(dir, "gh-1");
    await Deno.mkdir(ticketDir);
    await Deno.writeTextFile(
      join(ticketDir, "meta.md"),
      `---
id: gh-1
provider: github
title: T
url: https://github.com/x/y/issues/1
phase: merge
status: waiting
scope: []
worktrees: {}
created: "2026-07-01T00:00:00Z"
updated: "2026-07-01T00:00:00Z"
prs:
  - url: https://github.com/x/y/pull/1
    dependsOn: []
    merged: false
---
`,
    );
    try {
      const ticket = await readTicket(dir, "gh-1");
      assertEquals(ticket.prs?.[0].title, "");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "listLearnings: normalizes prs entry missing dependsOn to empty array",
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(join(dir, "learnings"));
      await Deno.writeTextFile(
        join(dir, "learnings", "20260729T050000.md"),
        `---
id: "20260729T050000"
ticketId: github/jackjennings/lazyboy/226
repo: jackjennings/lazyboy
targetFile: src/foo.md
prTitle: Improve prompt
prBody: Body text
status: pending
prs:
  - url: https://github.com/x/y/pull/1
    title: my PR
    merged: false
---

Intent text.
`,
      );
      const entries = await listLearnings(dir);
      assertEquals(entries.length, 1);
      assertEquals(entries[0].learning.prs[0].dependsOn, []);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test("listLearnings: drops prs entry with missing url", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "learnings"));
    await Deno.writeTextFile(
      join(dir, "learnings", "20260729T050000.md"),
      `---
id: "20260729T050000"
ticketId: github/jackjennings/lazyboy/226
repo: jackjennings/lazyboy
targetFile: src/foo.md
prTitle: Improve prompt
prBody: Body text
status: pending
prs:
  - title: no url here
    dependsOn: []
    merged: false
---

Intent text.
`,
    );
    const entries = await listLearnings(dir);
    assertEquals(entries.length, 1);
    assertEquals(entries[0].learning.prs, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test(
  "writeTicket/readTicket: workItems round-trips through YAML frontmatter",
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      const items = [
        { url: "https://github.com/x/y/issues/10", title: "New issue" },
      ];
      const ticket = makeTicket({ artifacts: ["work"], workItems: items });
      await writeTicket(dir, ticket);
      const read = await readTicket(dir, ticket.id);
      assertEquals(read.workItems, items);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "writeTicket/readTicket: absent workItems reads as undefined",
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      await writeTicket(dir, makeTicket(BASE));
      const raw = await Deno.readTextFile(join(dir, "gh-1", "meta.md"));
      assertFalse(raw.includes("workItems:"));
      const read = await readTicket(dir, "gh-1");
      assertEquals(read.workItems, undefined);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test("writeTicket/readTicket: artifacts:[code,document] round-trips", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const ticket = makeTicket({ artifacts: ["code", "document"] });
    await writeTicket(dir, ticket);
    const raw = await Deno.readTextFile(join(dir, ticket.id, "meta.md"));
    assertStringIncludes(raw, "artifacts:");
    const read = await readTicket(dir, ticket.id);
    assertEquals(read.artifacts, ["code", "document"] as ArtifactType[]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readTicket: sets revision to a non-empty string", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const ticketDir = join(dir, "gh-1");
    await Deno.mkdir(ticketDir);
    await Deno.writeTextFile(
      join(ticketDir, "meta.md"),
      `---
id: gh-1
provider: github
title: T
url: https://github.com/x/y/issues/1
phase: intake
status: new
scope: []
worktrees: {}
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
---
`,
    );
    const ticket = await readTicket(dir, "gh-1");
    assert(typeof ticket.revision === "string" && ticket.revision.length > 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readTicket: successive reads of unchanged file return same revision", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const ticketDir = join(dir, "gh-1");
    await Deno.mkdir(ticketDir);
    await Deno.writeTextFile(
      join(ticketDir, "meta.md"),
      `---
id: gh-1
provider: github
title: T
url: https://github.com/x/y/issues/1
phase: intake
status: new
scope: []
worktrees: {}
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
---
`,
    );
    const t1 = await readTicket(dir, "gh-1");
    const t2 = await readTicket(dir, "gh-1");
    assertEquals(t1.revision, t2.revision);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeTicket: throws StaleTicketWriteError when revision does not match on-disk hash", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const ticket = makeTicket({ id: "gh-1" });
    await writeTicket(dir, ticket);
    const read = await readTicket(dir, "gh-1");
    await Deno.writeTextFile(
      join(dir, "gh-1", "meta.md"),
      "---\nmangled: true\n---\n",
    );
    await assertRejects(
      () => writeTicket(dir, { ...read, status: "waiting" }),
      StaleTicketWriteError,
    );
    const raw = await Deno.readTextFile(join(dir, "gh-1", "meta.md"));
    assertStringIncludes(raw, "mangled: true");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeTicket: throws StaleTicketWriteError when revision absent on existing file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeTicket(dir, makeTicket({ id: "gh-1" }));
    const noRevision = makeTicket({ id: "gh-1" });
    await assertRejects(
      () => writeTicket(dir, noRevision),
      StaleTicketWriteError,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeTicket: succeeds without revision when meta.md does not exist", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeTicket(dir, makeTicket({ id: "gh-1" }));
    const raw = await Deno.readTextFile(join(dir, "gh-1", "meta.md"));
    assertStringIncludes(raw, "gh-1");
    assertFalse(raw.includes("revision:"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeTicket: on-disk hash after write matches readTicket revision", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const ticket = makeTicket({ id: "gh-1" });
    await writeTicket(dir, ticket);
    const read = await readTicket(dir, "gh-1");
    await writeTicket(dir, { ...read, status: "waiting" });
    const read2 = await readTicket(dir, "gh-1");
    assertEquals(read2.status, "waiting");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readTicketWithPatch: patchTicket writes attrs on top of current state", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeTicket(dir, makeTicket({ id: "gh-1" }));
    const { patchTicket } = await readTicketWithPatch(dir, "gh-1");
    await patchTicket({ status: "waiting" });
    const result = await readTicket(dir, "gh-1");
    assertEquals(result.status, "waiting");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readTicketWithPatch: patchTicket reads fresh state before writing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeTicket(dir, makeTicket({ id: "gh-1" }));
    const { patchTicket } = await readTicketWithPatch(dir, "gh-1");
    const fresh = await readTicket(dir, "gh-1");
    await writeTicket(dir, { ...fresh, shortTitle: "External change" });
    await patchTicket({ status: "waiting" });
    const result = await readTicket(dir, "gh-1");
    assertEquals(result.status, "waiting");
    assertEquals(result.shortTitle, "External change");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test(
  "writeTicket/readTicket: all fields round-trip (exhaustive)",
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      const fixture: Required<TicketState> = {
        id: "gh-round-trip",
        provider: "github",
        title: "Round-trip test",
        shortTitle: "Round-trip",
        url: "https://github.com/x/y/issues/99",
        phase: "implementation",
        status: "waiting",
        approvals: [{
          timestamp: "2026-01-01T00:00:00Z",
          actor: "human",
          phase: "spec",
        }],
        scope: ["x/y"],
        worktrees: {
          "x/y": { path: "/tmp/worktree", branch: "gh-round-trip" },
        },
        prs: [{
          url: "https://github.com/x/y/pull/10",
          title: "PR title",
          dependsOn: [],
          merged: false,
          worktreeKey: "x/y",
        }],
        newRepos: ["x/z"],
        ciHandledRunIds: ["run-1"],
        lastSeenCommentTimestamp: "2026-08-01T00:00:00.000Z",
        lastSeenPrCommentTimestamp: "2026-08-02T00:00:00.000Z",
        providerDone: true,
        providerPickedUp: true,
        outputRetries: 1,
        resumeRetries: 2,
        phaseSessionIds: { spec: "abc-123", implementation: undefined },
        notifiedNeedsAttention: true,
        created: "2026-01-01T00:00:00Z",
        updated: "2026-08-01T00:00:00Z",
        body: "## Problem\n\nTest body.",
        phases: {
          implementation: { model: "claude-sonnet-4-6", thinking: "high" },
        },
        artifacts: ["code"],
        documents: [{ url: "https://notion.so/doc", title: "Design Doc" }],
        workItems: [{
          url: "https://github.com/x/y/issues/2",
          title: "Work item",
        }],
        revision: "placeholder",
      };

      await writeTicket(dir, fixture);
      const read = await readTicket(dir, fixture.id);

      assertFalse("implementation" in (read.phaseSessionIds ?? {}));

      const expected: TicketState = {
        ...fixture,
        phaseSessionIds: { spec: "abc-123" },
        revision: read.revision,
      };
      assertEquals(read, expected);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);
