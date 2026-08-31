import { assert, assertEquals, assertFalse } from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { checkMergedPRAction } from "./check-merged-pr.ts";
import type { TicketState } from "../state/types.ts";
import { makeTicket } from "../test-support.ts";

const BASE = {
  id: "gh-42",
  url: "https://github.com/myorg/myrepo/issues/42",
  phase: "merge" as const,
  status: "waiting" as const,
  worktrees: {
    "myorg/myrepo": { path: "/wt/myorg/myrepo", branch: "gh-42" },
  },
  prs: [{
    url: "https://github.com/myorg/myrepo/pull/99",
    title: "feat: my change",
    dependsOn: [],
    merged: false,
    worktreeKey: "myorg/myrepo",
  }],
  created: "2026-06-23T00:00:00Z",
  updated: "2026-06-23T00:00:00Z",
};

function makeAction(
  overrides: Partial<Parameters<typeof checkMergedPRAction>[0]> = {},
) {
  return checkMergedPRAction({
    isPRMerged: () => Promise.resolve(false),
    cleanupWorktree: () => Promise.resolve(),
    writeTicket: () => Promise.resolve(),
    appendLog: () => Promise.resolve(),
    closeWorkItem: () => Promise.resolve(),
    ...overrides,
  });
}

// ── applies ──────────────────────────────────────────────────────────────────

Deno.test("checkMergedPRAction: applies when merge/waiting with prs array", () => {
  assert(makeAction().applies(makeTicket(BASE)));
});

Deno.test("checkMergedPRAction: does not apply when prs is undefined", () => {
  assertFalse(makeAction().applies(makeTicket({ ...BASE, prs: undefined })));
});

Deno.test("checkMergedPRAction: does not apply when prs is empty", () => {
  assertFalse(makeAction().applies(makeTicket({ ...BASE, prs: [] })));
});

Deno.test("checkMergedPRAction: does not apply when not merge/waiting", () => {
  assertFalse(
    makeAction().applies(
      makeTicket({ ...BASE, phase: "implementation", status: "running" }),
    ),
  );
});

Deno.test(
  "checkMergedPRAction: applies when implementation/waiting with prs array",
  () => {
    assert(
      makeAction().applies(
        makeTicket({ ...BASE, phase: "implementation", status: "waiting" }),
      ),
    );
  },
);

// ── single PR — no merge ──────────────────────────────────────────────────────

Deno.test("checkMergedPRAction: PR not merged → null, no cleanup", async () => {
  const cleanups: string[] = [];
  const result = await makeAction({
    isPRMerged: () => Promise.resolve(false),
    cleanupWorktree: (wt) => {
      cleanups.push(wt.path);
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assertEquals(result, null);
  assertEquals(cleanups, []);
});

Deno.test(
  "checkMergedPRAction: isPRMerged throws → null, no cleanup, logs error",
  async () => {
    const cleanups: string[] = [];
    const logged: object[] = [];
    const result = await makeAction({
      isPRMerged: () => {
        throw new Error("network error");
      },
      cleanupWorktree: (wt) => {
        cleanups.push(wt.path);
        return Promise.resolve();
      },
      appendLog: (_dir, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");
    assertEquals(result, null);
    assertEquals(cleanups, []);
    assertEquals(logged.length, 1);
    assertEquals((logged[0] as Record<string, string>).event, "error");
    assertEquals(
      (logged[0] as Record<string, string>).context,
      "checkMergedPR",
    );
    assertEquals(
      (logged[0] as Record<string, string>).message,
      "Error: network error",
    );
  },
);

// ── single PR — merged ────────────────────────────────────────────────────────

Deno.test(
  "checkMergedPRAction: PR merged → done, cleanup for pr.worktreeKey",
  async () => {
    const cleanups: string[] = [];
    const written: TicketState[] = [];
    const result = await makeAction({
      isPRMerged: () => Promise.resolve(true),
      cleanupWorktree: (wt) => {
        cleanups.push(wt.path);
        return Promise.resolve();
      },
      writeTicket: (_dir, t) => {
        written.push(t);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");
    assertEquals(result?.status, "done");
    assertEquals(cleanups, ["/wt/myorg/myrepo"]);
    assertEquals(written.length, 1);
    assertEquals(written[0].status, "done");
  },
);

Deno.test(
  "checkMergedPRAction: cleanupWorktree throws → still done, logs error",
  async () => {
    const logged: object[] = [];
    const result = await makeAction({
      isPRMerged: () => Promise.resolve(true),
      cleanupWorktree: () => {
        throw new Error("git failed");
      },
      appendLog: (_dir, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");
    assertEquals(result?.status, "done");
    const errors = (logged as Record<string, string>[]).filter((e) =>
      e.event === "error"
    );
    assertEquals(errors.length, 1);
    assertEquals(errors[0].context, "checkMergedPR");
    assertEquals(errors[0].message, "Error: git failed");
  },
);

Deno.test(
  "checkMergedPRAction: PR merged logs phase-transition entry",
  async () => {
    const logged: object[] = [];
    await makeAction({
      isPRMerged: () => Promise.resolve(true),
      appendLog: (_dir, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");
    const transitions = (logged as Record<string, string>[]).filter((e) =>
      e.event === "phase-transition"
    );
    assertEquals(transitions.length, 1);
    assertEquals(transitions[0].from, "waiting-merge");
    assertEquals(transitions[0].to, "done");
  },
);

Deno.test(
  "checkMergedPRAction: PR merged → closeWorkItem called with ticket url",
  async () => {
    const closedUrls: string[] = [];
    const result = await makeAction({
      isPRMerged: () => Promise.resolve(true),
      closeWorkItem: (url) => {
        closedUrls.push(url);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");
    assertEquals(result?.status, "done");
    assertEquals(closedUrls, ["https://github.com/myorg/myrepo/issues/42"]);
  },
);

Deno.test(
  "checkMergedPRAction: closeWorkItem throws → still done, logs error",
  async () => {
    const logged: object[] = [];
    const result = await makeAction({
      isPRMerged: () => Promise.resolve(true),
      closeWorkItem: () => {
        throw new Error("close failed");
      },
      appendLog: (_dir, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");
    assertEquals(result?.status, "done");
    const errors = (logged as Record<string, string>[]).filter((e) =>
      e.event === "error"
    );
    assertEquals(errors.length, 1);
    assertEquals(errors[0].message, "Error: close failed");
  },
);

// ── PR with no worktreeKey ────────────────────────────────────────────────────

Deno.test(
  "checkMergedPRAction: merged PR with no worktreeKey — no cleanup, still done",
  async () => {
    const cleanups: string[] = [];
    const result = await makeAction({
      isPRMerged: () => Promise.resolve(true),
      cleanupWorktree: (wt) => {
        cleanups.push(wt.path);
        return Promise.resolve();
      },
    }).run(
      makeTicket({
        ...BASE,
        prs: [{
          url: "https://github.com/myorg/myrepo/pull/99",
          title: "",
          dependsOn: [],
          merged: false,
        }],
      }),
      "/state",
    );
    assertEquals(result?.status, "done");
    assertEquals(cleanups, []);
  },
);

// ── dependency ordering ───────────────────────────────────────────────────────

Deno.test(
  "checkMergedPRAction: PR B skipped when its dependsOn PR A is not yet merged",
  async () => {
    const checked: string[] = [];
    const result = await makeAction({
      isPRMerged: (url) => {
        checked.push(url);
        return Promise.resolve(false);
      },
    }).run(
      makeTicket({
        ...BASE,
        prs: [
          {
            url: "https://github.com/myorg/myrepo/pull/1",
            title: "A",
            dependsOn: [],
            merged: false,
            worktreeKey: "myorg/myrepo",
          },
          {
            url: "https://github.com/myorg/myrepo/pull/2",
            title: "B",
            dependsOn: ["https://github.com/myorg/myrepo/pull/1"],
            merged: false,
          },
        ],
      }),
      "/state",
    );
    assertEquals(result, null);
    assertEquals(checked, ["https://github.com/myorg/myrepo/pull/1"]);
  },
);

Deno.test(
  "checkMergedPRAction: PR A newly merged writes waiting with A.merged=true, worktree removed",
  async () => {
    const cleanups: string[] = [];
    const written: TicketState[] = [];
    const result = await makeAction({
      isPRMerged: (url) =>
        Promise.resolve(url === "https://github.com/myorg/myrepo/pull/1"),
      cleanupWorktree: (wt) => {
        cleanups.push(wt.path);
        return Promise.resolve();
      },
      writeTicket: (_dir, t) => {
        written.push(t);
        return Promise.resolve();
      },
    }).run(
      makeTicket({
        ...BASE,
        worktrees: {
          "myorg/myrepo": { path: "/wt/myorg/myrepo", branch: "gh-42-a" },
          "myorg/myrepo-b": {
            path: "/wt/myorg/myrepo-b",
            branch: "gh-42-b",
          },
        },
        prs: [
          {
            url: "https://github.com/myorg/myrepo/pull/1",
            title: "A",
            dependsOn: [],
            merged: false,
            worktreeKey: "myorg/myrepo",
          },
          {
            url: "https://github.com/myorg/myrepo/pull/2",
            title: "B",
            dependsOn: ["https://github.com/myorg/myrepo/pull/1"],
            merged: false,
            worktreeKey: "myorg/myrepo-b",
          },
        ],
      }),
      "/state",
    );
    assertEquals(result?.status, "waiting");
    assertEquals(result?.prs?.[0].merged, true);
    assertEquals(result?.prs?.[1].merged, false);
    assertEquals(cleanups, ["/wt/myorg/myrepo"]);
    assertEquals(result?.worktrees["myorg/myrepo"], undefined);
    assertEquals(written.length, 1);
    assertEquals(written[0].status, "waiting");
  },
);

Deno.test(
  "checkMergedPRAction: tick 2 with A pre-merged — B becomes eligible, done",
  async () => {
    const cleanups: string[] = [];
    const result = await makeAction({
      isPRMerged: (url) =>
        Promise.resolve(url === "https://github.com/myorg/myrepo/pull/2"),
      cleanupWorktree: (wt) => {
        cleanups.push(wt.path);
        return Promise.resolve();
      },
    }).run(
      makeTicket({
        ...BASE,
        worktrees: {
          "myorg/myrepo-b": {
            path: "/wt/myorg/myrepo-b",
            branch: "gh-42-b",
          },
        },
        prs: [
          {
            url: "https://github.com/myorg/myrepo/pull/1",
            title: "A",
            dependsOn: [],
            merged: true,
          },
          {
            url: "https://github.com/myorg/myrepo/pull/2",
            title: "B",
            dependsOn: ["https://github.com/myorg/myrepo/pull/1"],
            merged: false,
            worktreeKey: "myorg/myrepo-b",
          },
        ],
      }),
      "/state",
    );
    assertEquals(result?.status, "done");
    assertEquals(cleanups, ["/wt/myorg/myrepo-b"]);
  },
);

Deno.test(
  "checkMergedPRAction: full stack in one tick — A and B both merged → done",
  async () => {
    const cleanups: string[] = [];
    const result = await makeAction({
      isPRMerged: () => Promise.resolve(true),
      cleanupWorktree: (wt) => {
        cleanups.push(wt.path);
        return Promise.resolve();
      },
    }).run(
      makeTicket({
        ...BASE,
        worktrees: {
          "myorg/myrepo": { path: "/wt/myorg/myrepo", branch: "gh-42-a" },
          "myorg/myrepo-b": {
            path: "/wt/myorg/myrepo-b",
            branch: "gh-42-b",
          },
        },
        prs: [
          {
            url: "https://github.com/myorg/myrepo/pull/1",
            title: "A",
            dependsOn: [],
            merged: false,
            worktreeKey: "myorg/myrepo",
          },
          {
            url: "https://github.com/myorg/myrepo/pull/2",
            title: "B",
            dependsOn: ["https://github.com/myorg/myrepo/pull/1"],
            merged: false,
            worktreeKey: "myorg/myrepo-b",
          },
        ],
      }),
      "/state",
    );
    assertEquals(result?.status, "done");
    assertEquals(cleanups.sort(), ["/wt/myorg/myrepo", "/wt/myorg/myrepo-b"]);
  },
);

Deno.test(
  "checkMergedPRAction: isPRMerged throws mid-stack — returns null without writing",
  async () => {
    const written: TicketState[] = [];
    const result = await makeAction({
      isPRMerged: (url) => {
        if (url === "https://github.com/myorg/myrepo/pull/1") {
          return Promise.resolve(true);
        }
        throw new Error("network error");
      },
      writeTicket: (_dir, t) => {
        written.push(t);
        return Promise.resolve();
      },
    }).run(
      makeTicket({
        ...BASE,
        prs: [
          {
            url: "https://github.com/myorg/myrepo/pull/1",
            title: "A",
            dependsOn: [],
            merged: false,
          },
          {
            url: "https://github.com/myorg/myrepo/pull/2",
            title: "B",
            dependsOn: [],
            merged: false,
          },
        ],
      }),
      "/state",
    );
    assertEquals(result, null);
    assertEquals(written.length, 0);
  },
);

// ── assertSpyCalls usage verification ────────────────────────────────────────

Deno.test(
  "checkMergedPRAction: writeTicket called exactly once on done",
  async () => {
    const writeTicketSpy = spy(() => Promise.resolve());
    await makeAction({
      isPRMerged: () => Promise.resolve(true),
      writeTicket: writeTicketSpy,
    }).run(makeTicket(BASE), "/state");
    assertSpyCalls(writeTicketSpy, 1);
  },
);
