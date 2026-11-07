import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { ciFixRunKey, spawnCIFixAction } from "./spawn-ci-fix.ts";
import type { CIRunResult, SpawnCIFixDeps } from "./spawn-ci-fix.ts";
import type { TicketState } from "../state/types.ts";
import { makeTicket } from "../test-support.ts";

const BASE = {
  id: "github/jackjennings/lazyboy/178",
  url: "https://github.com/jackjennings/lazyboy/issues/178",
  phase: "implementation" as const,
  status: "waiting" as const,
  worktrees: {
    "jackjennings/lazyboy": {
      path: "/wt/lazyboy",
      branch: "github/jackjennings/lazyboy/178",
    },
  },
  prs: [
    {
      url: "https://github.com/jackjennings/lazyboy/pull/99",
      title: "feat",
      dependsOn: [],
      merged: false,
      worktreeKey: "jackjennings/lazyboy",
    },
  ],
  created: "2026-08-12T00:00:00Z",
  updated: "2026-08-12T00:00:00Z",
};

const HEAD_SHA = "5f2c1ab9d7e34c0b8a6f1d2e3c4b5a6978091234";

const FAILURE_RESULT: CIRunResult = {
  runId: "1001",
  attempt: 1,
  conclusion: "failure",
  failingJobs: ["lint", "test"],
  headSha: HEAD_SHA,
  baseBranch: "main",
  failingCheckContexts: ["lint", "test"],
};

function makeDeps(overrides: Partial<SpawnCIFixDeps> = {}): SpawnCIFixDeps {
  return {
    getPRChecks: () => Promise.resolve(null),
    getRequiredCheckContexts: () => Promise.resolve(null),
    getIgnoredCheckContexts: () => [],
    isProcessAlive: () => false,
    writeTicket: () => Promise.resolve(),
    appendLog: () => Promise.resolve(),
    spawn: () => Promise.resolve(),
    writeContextFile: () => Promise.resolve("context.md"),
    resolveModelConfig: () => ({
      model: "claude-sonnet-4-6",
      thinking: "high",
    }),
    canonicalSlugFor: (slug) => slug,
    ...overrides,
  };
}

Deno.test("ciFixRunKey: joins run ID and attempt", () => {
  assertEquals(ciFixRunKey("1001", 2), "1001-2");
});

Deno.test("spawnCIFixAction: applies when ticket has an unmerged PR", () => {
  assert(spawnCIFixAction(makeDeps()).applies(makeTicket(BASE)));
});

Deno.test("spawnCIFixAction: does not apply when all PRs are merged", () => {
  assertFalse(
    spawnCIFixAction(makeDeps()).applies(
      makeTicket({
        ...BASE,
        prs: [{ url: "u", title: "T", dependsOn: [], merged: true }],
      }),
    ),
  );
});

Deno.test("spawnCIFixAction: does not apply when prs is undefined", () => {
  assertFalse(
    spawnCIFixAction(makeDeps()).applies(
      makeTicket({ ...BASE, prs: undefined }),
    ),
  );
});

Deno.test("spawnCIFixAction: does not apply when status is needs-attention", () => {
  assertFalse(
    spawnCIFixAction(makeDeps()).applies(
      makeTicket({ ...BASE, status: "needs-attention" }),
    ),
  );
});

Deno.test("spawnCIFixAction: does not apply when a phase process is alive", () => {
  assertFalse(
    spawnCIFixAction(makeDeps({ isProcessAlive: () => true })).applies(
      makeTicket(BASE),
    ),
  );
});

Deno.test("spawnCIFixAction: does not apply to a running ticket whose process died", () => {
  assertFalse(
    spawnCIFixAction(makeDeps({ isProcessAlive: () => false })).applies(
      makeTicket({ ...BASE, status: "running" }),
    ),
  );
});

Deno.test("spawnCIFixAction: does not apply when status is revising", () => {
  assertFalse(
    spawnCIFixAction(makeDeps()).applies(
      makeTicket({ ...BASE, status: "revising" }),
    ),
  );
});

Deno.test("spawnCIFixAction: no CI result returns null", async () => {
  assertEquals(
    await spawnCIFixAction(makeDeps()).run(makeTicket(BASE), "/state"),
    null,
  );
});

Deno.test("spawnCIFixAction: successful conclusion does not spawn", async () => {
  const spawnSpy = spy(() => Promise.resolve());
  const result = await spawnCIFixAction(
    makeDeps({
      getPRChecks: () =>
        Promise.resolve({
          runId: "1001",
          attempt: 1,
          conclusion: "success",
          failingJobs: [],
          headSha: HEAD_SHA,
          baseBranch: "main",
          failingCheckContexts: [],
        }),
      spawn: spawnSpy,
    }),
  ).run(makeTicket(BASE), "/state");
  assertEquals(result, null);
  assertSpyCalls(spawnSpy, 0);
});

Deno.test("spawnCIFixAction: failure spawns and records the run key", async () => {
  const spawnSpy = spy(() => Promise.resolve());
  const result = await spawnCIFixAction(
    makeDeps({
      getPRChecks: () => Promise.resolve(FAILURE_RESULT),
      spawn: spawnSpy,
    }),
  ).run(makeTicket(BASE), "/state");
  assertSpyCalls(spawnSpy, 1);
  assertArrayIncludes(result?.ciHandledRunIds ?? [], ["1001-1"]);
});

Deno.test("spawnCIFixAction: action_required conclusion spawns", async () => {
  const spawnSpy = spy(() => Promise.resolve());
  await spawnCIFixAction(
    makeDeps({
      getPRChecks: () =>
        Promise.resolve({
          runId: "1002",
          attempt: 1,
          conclusion: "action_required",
          failingJobs: [],
          headSha: HEAD_SHA,
          baseBranch: "main",
          failingCheckContexts: [],
        }),
      spawn: spawnSpy,
    }),
  ).run(makeTicket(BASE), "/state");
  assertSpyCalls(spawnSpy, 1);
});

Deno.test("spawnCIFixAction: identical run key is skipped", async () => {
  const spawnSpy = spy(() => Promise.resolve());
  const result = await spawnCIFixAction(
    makeDeps({
      getPRChecks: () => Promise.resolve(FAILURE_RESULT),
      spawn: spawnSpy,
    }),
  ).run(makeTicket({ ...BASE, ciHandledRunIds: ["1001-1"] }), "/state");
  assertEquals(result, null);
  assertSpyCalls(spawnSpy, 0);
});

Deno.test("spawnCIFixAction: same run ID with a new attempt spawns again", async () => {
  const spawnSpy = spy(() => Promise.resolve());
  const result = await spawnCIFixAction(
    makeDeps({
      getPRChecks: () => Promise.resolve({ ...FAILURE_RESULT, attempt: 2 }),
      spawn: spawnSpy,
    }),
  ).run(makeTicket({ ...BASE, ciHandledRunIds: ["1001-1"] }), "/state");
  assertSpyCalls(spawnSpy, 1);
  assertArrayIncludes(result?.ciHandledRunIds ?? [], ["1001-1", "1001-2"]);
});

Deno.test("spawnCIFixAction: missing worktree parks the ticket without spawning", async () => {
  const spawnSpy = spy(() => Promise.resolve());
  const logged: Record<string, unknown>[] = [];
  const result = await spawnCIFixAction(
    makeDeps({
      getPRChecks: () => Promise.resolve(FAILURE_RESULT),
      spawn: spawnSpy,
      appendLog: (_sd, _id, entry) => {
        logged.push(entry as Record<string, unknown>);
        return Promise.resolve();
      },
    }),
  ).run(makeTicket({ ...BASE, worktrees: {} }), "/state");
  assertSpyCalls(spawnSpy, 0);
  assertEquals(result?.status, "needs-attention");
  const parkEntry = logged.find((e) => e.event === "needs-attention");
  assertEquals(parkEntry?.reason, "no-worktrees");
});

Deno.test("spawnCIFixAction: spawn failure rolls the run key back and writes no ticket", async () => {
  const writeSpy = spy(() => Promise.resolve());
  const result = await spawnCIFixAction(
    makeDeps({
      getPRChecks: () => Promise.resolve(FAILURE_RESULT),
      spawn: () => Promise.reject(new Error("spawn failed")),
      writeTicket: writeSpy,
    }),
  ).run(makeTicket(BASE), "/state");
  assertEquals(result, null);
  assertSpyCalls(writeSpy, 0);
});

Deno.test("spawnCIFixAction: writeContextFile failure rolls back and does not spawn", async () => {
  const spawnSpy = spy(() => Promise.resolve());
  const result = await spawnCIFixAction(
    makeDeps({
      getPRChecks: () => Promise.resolve(FAILURE_RESULT),
      writeContextFile: () => Promise.reject(new Error("disk full")),
      spawn: spawnSpy,
    }),
  ).run(makeTicket(BASE), "/state");
  assertEquals(result, null);
  assertSpyCalls(spawnSpy, 0);
});

Deno.test("spawnCIFixAction: getPRChecks throwing logs an error and returns null", async () => {
  const logged: Record<string, unknown>[] = [];
  const result = await spawnCIFixAction(
    makeDeps({
      getPRChecks: () => Promise.reject(new Error("rate limit")),
      appendLog: (_sd, _id, entry) => {
        logged.push(entry as Record<string, unknown>);
        return Promise.resolve();
      },
    }),
  ).run(makeTicket(BASE), "/state");
  assertEquals(result, null);
  assertEquals(logged[0].event, "error");
});

Deno.test("spawnCIFixAction: context file carries headers and failing job names", async () => {
  const written: { runKey: string; content: string }[] = [];
  await spawnCIFixAction(
    makeDeps({
      getPRChecks: () => Promise.resolve(FAILURE_RESULT),
      writeContextFile: (_dir, runKey, content) => {
        written.push({ runKey, content });
        return Promise.resolve("ctx.md");
      },
    }),
  ).run(makeTicket(BASE), "/state");
  assertEquals(written[0].runKey, "1001-1");
  assertStringIncludes(
    written[0].content,
    "PR-URL: https://github.com/jackjennings/lazyboy/pull/99",
  );
  assertStringIncludes(written[0].content, "Repo: jackjennings/lazyboy");
  assertStringIncludes(written[0].content, "Run-ID: 1001");
  assertStringIncludes(written[0].content, "Attempt: 1");
  assertStringIncludes(
    written[0].content,
    "Branch: github/jackjennings/lazyboy/178",
  );
  assertStringIncludes(written[0].content, `Head-SHA: ${HEAD_SHA}`);
  assertStringIncludes(written[0].content, "Worktree-Path: /wt/lazyboy");
  assertStringIncludes(written[0].content, "- lint");
  assertStringIncludes(written[0].content, "- test");
});

Deno.test("spawnCIFixAction: spawn receives model, thinking, run ID and attempt", async () => {
  const spawnOpts: Record<string, unknown>[] = [];
  await spawnCIFixAction(
    makeDeps({
      getPRChecks: () => Promise.resolve(FAILURE_RESULT),
      resolveModelConfig: () => ({
        model: "claude-haiku-4-5",
        thinking: "off",
      }),
      spawn: (opts) => {
        spawnOpts.push(opts as unknown as Record<string, unknown>);
        return Promise.resolve();
      },
    }),
  ).run(makeTicket(BASE), "/state");
  assertEquals(spawnOpts[0].model, "claude-haiku-4-5");
  assertEquals(spawnOpts[0].thinking, "off");
  assertEquals(spawnOpts[0].runId, "1001");
  assertEquals(spawnOpts[0].attempt, 1);
  assertEquals(spawnOpts[0].worktreePath, "/wt/lazyboy");
});

Deno.test(
  "spawnCIFixAction: mismatched worktreeKey and repo parks without spawning",
  async () => {
    const spawnSpy = spy(() => Promise.resolve());
    const logged: Record<string, unknown>[] = [];
    const result = await spawnCIFixAction(
      makeDeps({
        getPRChecks: () => Promise.resolve(FAILURE_RESULT),
        spawn: spawnSpy,
        appendLog: (_sd, _id, entry) => {
          logged.push(entry as Record<string, unknown>);
          return Promise.resolve();
        },
      }),
    ).run(
      makeTicket({
        ...BASE,
        worktrees: {
          "org/wrong-repo": { path: "/wt/wrong", branch: "ticket-1" },
        },
        prs: [{
          url: "https://github.com/org/correct-repo/pull/1",
          title: "feat",
          dependsOn: [],
          merged: false,
          worktreeKey: "org/wrong-repo",
        }],
      }),
      "/state",
    );
    assertSpyCalls(spawnSpy, 0);
    assertEquals(result?.status, "needs-attention");
    const parkEntry = logged.find((e) => e.event === "needs-attention");
    assertEquals(parkEntry?.reason, "worktree-pr-repo-mismatch");
    assertEquals(parkEntry?.worktreeKey, "org/wrong-repo");
    assertEquals(parkEntry?.repo, "org/correct-repo");
  },
);

Deno.test(
  "spawnCIFixAction: aliased worktreeKey and repo slug do not park",
  async () => {
    const spawnSpy = spy(() => Promise.resolve());
    const result = await spawnCIFixAction(
      makeDeps({
        getPRChecks: () => Promise.resolve(FAILURE_RESULT),
        spawn: spawnSpy,
        canonicalSlugFor: () => "jackjennings/lazyboy",
      }),
    ).run(
      makeTicket({
        ...BASE,
        worktrees: {
          "jackjennings/lazyboy": {
            path: "/wt/lazyboy",
            branch: "github/jackjennings/lazyboy/671",
          },
        },
        prs: [{
          url: "https://github.com/jackjennings/urras/pull/665",
          title: "feat",
          dependsOn: [],
          merged: false,
          worktreeKey: "jackjennings/lazyboy",
        }],
      }),
      "/state",
    );
    assertSpyCalls(spawnSpy, 1);
    assertFalse(result?.status === "needs-attention");
  },
);

Deno.test("spawnCIFixAction: existing run keys are preserved", async () => {
  const written: TicketState[] = [];
  await spawnCIFixAction(
    makeDeps({
      getPRChecks: () => Promise.resolve({ ...FAILURE_RESULT, runId: "2002" }),
      writeTicket: (_sd, t) => {
        written.push(t);
        return Promise.resolve();
      },
    }),
  ).run(makeTicket({ ...BASE, ciHandledRunIds: ["1001-1"] }), "/state");
  assertArrayIncludes(written[0].ciHandledRunIds ?? [], ["1001-1", "2002-1"]);
});

Deno.test(
  "spawnCIFixAction: empty failingCheckContexts falls back and logs unavailable",
  async () => {
    const logged: Record<string, unknown>[] = [];
    const spawnSpy = spy(() => Promise.resolve());
    await spawnCIFixAction(
      makeDeps({
        getPRChecks: () =>
          Promise.resolve({ ...FAILURE_RESULT, failingCheckContexts: [] }),
        appendLog: (_sd, _id, entry) => {
          logged.push(entry as Record<string, unknown>);
          return Promise.resolve();
        },
        spawn: spawnSpy,
      }),
    ).run(makeTicket(BASE), "/state");
    assertSpyCalls(spawnSpy, 1);
    assert(logged.some((e) => e.event === "ci-fix-check-contexts-unavailable"));
  },
);

Deno.test(
  "spawnCIFixAction: null required checks falls back and logs fallback",
  async () => {
    const logged: Record<string, unknown>[] = [];
    const spawnSpy = spy(() => Promise.resolve());
    await spawnCIFixAction(
      makeDeps({
        getPRChecks: () => Promise.resolve(FAILURE_RESULT),
        getRequiredCheckContexts: () => Promise.resolve(null),
        appendLog: (_sd, _id, entry) => {
          logged.push(entry as Record<string, unknown>);
          return Promise.resolve();
        },
        spawn: spawnSpy,
      }),
    ).run(makeTicket(BASE), "/state");
    assertSpyCalls(spawnSpy, 1);
    assert(logged.some((e) => e.event === "ci-fix-required-check-fallback"));
  },
);

Deno.test(
  "spawnCIFixAction: empty required check list falls back and logs fallback",
  async () => {
    const logged: Record<string, unknown>[] = [];
    const spawnSpy = spy(() => Promise.resolve());
    await spawnCIFixAction(
      makeDeps({
        getPRChecks: () => Promise.resolve(FAILURE_RESULT),
        getRequiredCheckContexts: () => Promise.resolve([]),
        appendLog: (_sd, _id, entry) => {
          logged.push(entry as Record<string, unknown>);
          return Promise.resolve();
        },
        spawn: spawnSpy,
      }),
    ).run(makeTicket(BASE), "/state");
    assertSpyCalls(spawnSpy, 1);
    assert(logged.some((e) => e.event === "ci-fix-required-check-fallback"));
  },
);

Deno.test(
  "spawnCIFixAction: non-required failing check skips spawn without recording run key",
  async () => {
    const logged: Record<string, unknown>[] = [];
    const written: TicketState[] = [];
    const spawnSpy = spy(() => Promise.resolve());
    const result = await spawnCIFixAction(
      makeDeps({
        getPRChecks: () => Promise.resolve(FAILURE_RESULT),
        getRequiredCheckContexts: () =>
          Promise.resolve(["other-required-check"]),
        appendLog: (_sd, _id, entry) => {
          logged.push(entry as Record<string, unknown>);
          return Promise.resolve();
        },
        writeTicket: (_sd, t) => {
          written.push(t);
          return Promise.resolve();
        },
        spawn: spawnSpy,
      }),
    ).run(makeTicket(BASE), "/state");
    assertSpyCalls(spawnSpy, 0);
    assertEquals(result, null);
    assertEquals(written.length, 0);
    assert(
      logged.some((e) => e.event === "ci-fix-skipped-no-required-failures"),
    );
  },
);

Deno.test(
  "spawnCIFixAction: required failing check spawns",
  async () => {
    const spawnSpy = spy(() => Promise.resolve());
    await spawnCIFixAction(
      makeDeps({
        getPRChecks: () => Promise.resolve(FAILURE_RESULT),
        getRequiredCheckContexts: () => Promise.resolve(["lint"]),
        spawn: spawnSpy,
      }),
    ).run(makeTicket(BASE), "/state");
    assertSpyCalls(spawnSpy, 1);
  },
);

Deno.test(
  "spawnCIFixAction: ignored required check skips spawn without recording run key",
  async () => {
    const logged: Record<string, unknown>[] = [];
    const written: TicketState[] = [];
    const spawnSpy = spy(() => Promise.resolve());
    const result = await spawnCIFixAction(
      makeDeps({
        getPRChecks: () => Promise.resolve(FAILURE_RESULT),
        getRequiredCheckContexts: () => Promise.resolve(["lint", "test"]),
        getIgnoredCheckContexts: () => ["lint", "test"],
        appendLog: (_sd, _id, entry) => {
          logged.push(entry as Record<string, unknown>);
          return Promise.resolve();
        },
        writeTicket: (_sd, t) => {
          written.push(t);
          return Promise.resolve();
        },
        spawn: spawnSpy,
      }),
    ).run(makeTicket(BASE), "/state");
    assertSpyCalls(spawnSpy, 0);
    assertEquals(result, null);
    assertEquals(written.length, 0);
    assert(logged.some((e) => e.event === "ci-fix-skipped-process-gate"));
  },
);

Deno.test(
  "spawnCIFixAction: partially ignored required failing checks spawns",
  async () => {
    const spawnSpy = spy(() => Promise.resolve());
    await spawnCIFixAction(
      makeDeps({
        getPRChecks: () => Promise.resolve(FAILURE_RESULT),
        getRequiredCheckContexts: () => Promise.resolve(["lint", "test"]),
        getIgnoredCheckContexts: () => ["lint"],
        spawn: spawnSpy,
      }),
    ).run(makeTicket(BASE), "/state");
    assertSpyCalls(spawnSpy, 1);
  },
);

Deno.test(
  "spawnCIFixAction: getRequiredCheckContexts called with repo and base branch",
  async () => {
    const calls: { repoSlug: string; baseBranch: string }[] = [];
    await spawnCIFixAction(
      makeDeps({
        getPRChecks: () => Promise.resolve(FAILURE_RESULT),
        getRequiredCheckContexts: (repoSlug, baseBranch) => {
          calls.push({ repoSlug, baseBranch });
          return Promise.resolve(null);
        },
      }),
    ).run(makeTicket(BASE), "/state");
    assertEquals(calls[0].repoSlug, "jackjennings/lazyboy");
    assertEquals(calls[0].baseBranch, "main");
  },
);
