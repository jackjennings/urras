import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import {
  checkConflictsAction,
  sanitizeBranchForFilename,
} from "./check-conflicts.ts";
import type { TicketState } from "../state/types.ts";
import { makeTicket } from "../test-support.ts";

// ── sanitizeBranchForFilename ─────────────────────────────────────────────────

Deno.test("sanitizeBranchForFilename: branches differing only by '/' vs '-' do not collide", () => {
  assertNotEquals(
    sanitizeBranchForFilename("gh-76"),
    sanitizeBranchForFilename("gh/76"),
  );
});

Deno.test("sanitizeBranchForFilename: leaves simple branch names unchanged", () => {
  assertEquals(sanitizeBranchForFilename("gh-7"), "gh-7");
});

const BASE = {
  id: "gh-7",
  url: "https://github.com/myorg/myrepo/issues/7",
  phase: "implementation" as const,
  status: "waiting" as const,
  worktrees: {
    "myorg/myrepo": { path: "/wt/myorg/myrepo", branch: "gh-7" },
  },
  created: "2026-06-30T00:00:00Z",
  updated: "2026-06-30T00:00:00Z",
};

function makeAction(
  overrides: Partial<Parameters<typeof checkConflictsAction>[0]> = {},
) {
  return checkConflictsAction({
    runGit: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    isProcessAlive: () => false,
    worktreeExists: () => true,
    writeTicket: () => Promise.resolve(),
    appendLog: () => Promise.resolve(),
    spawn: () => Promise.resolve(),
    writeContextFile: () => Promise.resolve(""),
    resolveModelConfig: () => ({ model: "claude-opus-4-7", thinking: "high" }),
    ...overrides,
  });
}

// ── applies ──────────────────────────────────────────────────────────────────

Deno.test("checkConflictsAction: applies to ticket with worktrees and no live pid", () => {
  assert(makeAction().applies(makeTicket(BASE)));
});

Deno.test("checkConflictsAction: applies to non-implementation phase with worktrees", () => {
  assert(
    makeAction().applies(
      makeTicket({ ...BASE, phase: "plan", status: "waiting" }),
    ),
  );
});

Deno.test("checkConflictsAction: does not apply to needs-attention", () => {
  assertFalse(
    makeAction().applies(makeTicket({ ...BASE, status: "needs-attention" })),
  );
});

Deno.test("checkConflictsAction: applies to merge/waiting ticket with existing worktree", () => {
  assert(
    makeAction().applies(
      makeTicket({ ...BASE, phase: "merge", status: "waiting" }),
    ),
  );
});

Deno.test("checkConflictsAction: does not apply to merge/waiting when process is alive", () => {
  assertFalse(
    makeAction({ isProcessAlive: () => true }).applies(
      makeTicket({ ...BASE, phase: "merge", status: "waiting" }),
    ),
  );
});

Deno.test("checkConflictsAction: does not apply to merge/waiting when no worktrees exist on disk", () => {
  assertFalse(
    makeAction({ worktreeExists: () => false }).applies(
      makeTicket({ ...BASE, phase: "merge", status: "waiting" }),
    ),
  );
});

Deno.test("checkConflictsAction: does not apply when pid is alive", () => {
  assertFalse(
    makeAction({
      isProcessAlive: () => true,
    }).applies(makeTicket(BASE)),
  );
});

Deno.test("checkConflictsAction: applies when no live process", () => {
  assert(
    makeAction({ isProcessAlive: () => false }).applies(makeTicket(BASE)),
  );
});

Deno.test("checkConflictsAction: does not apply to a running ticket whose process died", () => {
  assertFalse(
    makeAction({ isProcessAlive: () => false }).applies(
      makeTicket({ ...BASE, status: "running" }),
    ),
  );
});

Deno.test("checkConflictsAction: does not apply with no worktrees", () => {
  assertFalse(
    makeAction().applies(makeTicket({ ...BASE, worktrees: {} })),
  );
});

Deno.test("checkConflictsAction: does not apply when worktree path does not exist on disk", () => {
  assertFalse(
    makeAction({ worktreeExists: () => false }).applies(makeTicket(BASE)),
  );
});

// ── fetch failure ─────────────────────────────────────────────────────────────

Deno.test("checkConflictsAction: fetch failure logs error and returns null", async () => {
  const logged: object[] = [];
  const calls: string[][] = [];
  const result = await makeAction({
    runGit: (args) => {
      calls.push(args);
      if (args[0] === "fetch") {
        return Promise.resolve({
          code: 1,
          stdout: "",
          stderr: "network error",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    appendLog: (_dir, _id, entry) => {
      logged.push(entry);
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assertEquals(result, null);
  assertEquals(logged.length, 1);
  assertEquals((logged[0] as Record<string, unknown>).event, "error");
  assertEquals(
    (logged[0] as Record<string, unknown>).context,
    "checkConflicts",
  );
  assertEquals(
    (logged[0] as Record<string, unknown>).worktreePath,
    "/wt/myorg/myrepo",
  );
  assertEquals((logged[0] as Record<string, unknown>).stderr, "network error");
});

// ── clean rebase ──────────────────────────────────────────────────────────────

Deno.test("checkConflictsAction: clean rebase and push → null, logs branch-pushed", async () => {
  const logged: object[] = [];
  const calls: string[][] = [];
  const result = await makeAction({
    runGit: (args) => {
      calls.push(args);
      return Promise.resolve({ code: 0, stdout: "up to date", stderr: "" });
    },
    appendLog: (_dir, _id, entry) => {
      logged.push(entry);
      return Promise.resolve();
    },
  }).run(
    makeTicket({
      ...BASE,
      prs: [{
        url: "https://github.com/myorg/myrepo/pull/7",
        title: "",
        dependsOn: [],
        merged: false,
      }],
    }),
    "/state",
  );
  assertEquals(result, null);
  const rebaseClean = (logged as Record<string, unknown>[]).find(
    (e) => e.event === "branch-pushed",
  );
  assertNotEquals(rebaseClean, undefined);
  assertEquals(rebaseClean!.worktreePath, "/wt/myorg/myrepo");
  assertEquals(rebaseClean!.branch, "gh-7");
  assert(calls.some((a) => a[0] === "push"));
});

Deno.test("checkConflictsAction: clean rebase with no prs → null, no push, no log", async () => {
  const logged: object[] = [];
  const calls: string[][] = [];
  const result = await makeAction({
    runGit: (args) => {
      calls.push(args);
      return Promise.resolve({ code: 0, stdout: "up to date", stderr: "" });
    },
    appendLog: (_dir, _id, entry) => {
      logged.push(entry);
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assertEquals(result, null);
  assertFalse(calls.some((a) => a[0] === "push"));
  assertEquals(logged.length, 0);
});

Deno.test("checkConflictsAction: clean rebase, no-op push (already up to date) → no branch-pushed log", async () => {
  const logged: object[] = [];
  const calls: string[][] = [];
  const result = await makeAction({
    runGit: (args) => {
      calls.push(args);
      if (args[0] === "push") {
        return Promise.resolve({
          code: 0,
          stdout: "",
          stderr: "Everything up-to-date",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    appendLog: (_dir, _id, entry) => {
      logged.push(entry);
      return Promise.resolve();
    },
  }).run(
    makeTicket({
      ...BASE,
      prs: [{
        url: "https://github.com/myorg/myrepo/pull/7",
        title: "",
        dependsOn: [],
        merged: false,
      }],
    }),
    "/state",
  );
  assertEquals(result, null);
  assert(calls.some((a) => a[0] === "push"));
  assertEquals(logged.length, 0);
});

// ── push failure after clean rebase ──────────────────────────────────────────

Deno.test("checkConflictsAction: push failure logs error but returns null (transient)", async () => {
  const logged: object[] = [];
  const result = await makeAction({
    runGit: (args) => {
      if (args[0] === "push") {
        return Promise.resolve({ code: 1, stdout: "", stderr: "auth failure" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    appendLog: (_dir, _id, entry) => {
      logged.push(entry);
      return Promise.resolve();
    },
  }).run(
    makeTicket({
      ...BASE,
      prs: [{
        url: "https://github.com/myorg/myrepo/pull/7",
        title: "",
        dependsOn: [],
        merged: false,
      }],
    }),
    "/state",
  );
  assertEquals(result, null);
  const errorEntries = (logged as Record<string, unknown>[]).filter(
    (e) => e.event === "error",
  );
  assertEquals(errorEntries.length, 1);
  assertEquals(errorEntries[0].context, "checkConflicts");
  assertEquals(errorEntries[0].pushStderr, "auth failure");
});

// ── conflict detected ─────────────────────────────────────────────────────────

Deno.test(
  "checkConflictsAction: rebase conflict → spawns agent, status running, logs conflict-resolution-started",
  async () => {
    const logged: object[] = [];
    const written: TicketState[] = [];
    const calls: string[][] = [];
    const spawnCalls: object[] = [];
    const contextFiles: { branch: string; content: string }[] = [];

    const result = await makeAction({
      runGit: (args) => {
        calls.push(args);
        if (args[0] === "rebase" && args[1] === "origin/main") {
          return Promise.resolve({
            code: 1,
            stdout: "",
            stderr: "CONFLICT (content): Merge conflict in foo.ts",
          });
        }
        if (args[0] === "diff") {
          return Promise.resolve({
            code: 0,
            stdout: "foo.ts\nbar.ts",
            stderr: "",
          });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      spawn: (opts) => {
        spawnCalls.push(opts);
        return Promise.resolve();
      },
      writeContextFile: (_ticketDir, branch, content) => {
        contextFiles.push({ branch, content });
        return Promise.resolve(`20260727T202535-conflict-context-${branch}.md`);
      },
      writeTicket: (_dir, t) => {
        written.push(t);
        return Promise.resolve();
      },
      appendLog: (_dir, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");

    assertFalse(
      calls.some((a) => a[0] === "rebase" && a[1] === "--abort"),
    );
    assertEquals(spawnCalls.length, 1);
    assertEquals(contextFiles.length, 1);
    assertEquals(contextFiles[0].branch, "gh-7");
    assertEquals(result?.status, "running");

    const startEntry = (logged as Record<string, unknown>[]).find(
      (e) => e.event === "conflict-resolution-started",
    );
    assertNotEquals(startEntry, undefined);
    assertEquals(startEntry!.worktreePath, "/wt/myorg/myrepo");
    assertEquals(startEntry!.branch, "gh-7");
    assertEquals(startEntry!.conflictedFiles, ["foo.ts", "bar.ts"]);
    assertStringIncludes(startEntry!.rebaseStderr as string, "CONFLICT");
  },
);

Deno.test(
  "checkConflictsAction: spawn receives model and thinking from resolveModelConfig(ticket)",
  async () => {
    const spawnCalls: Record<string, unknown>[] = [];

    await makeAction({
      runGit: (args) => {
        if (args[0] === "rebase" && args[1] === "origin/main") {
          return Promise.resolve({
            code: 1,
            stdout: "",
            stderr: "CONFLICT",
          });
        }
        if (args[0] === "diff") {
          return Promise.resolve({ code: 0, stdout: "foo.ts", stderr: "" });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      spawn: (opts) => {
        spawnCalls.push(opts);
        return Promise.resolve();
      },
      resolveModelConfig: (ticket) => {
        assertEquals(ticket.id, "gh-7");
        return { model: "claude-sonnet-4-6", thinking: "off" };
      },
    }).run(makeTicket(BASE), "/state");

    assertEquals(spawnCalls.length, 1);
    assertEquals(spawnCalls[0].model, "claude-sonnet-4-6");
    assertEquals(spawnCalls[0].thinking, "off");
  },
);

Deno.test(
  "checkConflictsAction: spawn receives contextFile returned by writeContextFile",
  async () => {
    const filename = "20260727T202535-conflict-context-gh-7.md";
    const spawnCalls: Record<string, unknown>[] = [];

    await makeAction({
      runGit: (args) => {
        if (args[0] === "rebase" && args[1] === "origin/main") {
          return Promise.resolve({ code: 1, stdout: "", stderr: "CONFLICT" });
        }
        if (args[0] === "diff") {
          return Promise.resolve({ code: 0, stdout: "foo.ts", stderr: "" });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      writeContextFile: () => Promise.resolve(filename),
      spawn: (opts) => {
        spawnCalls.push(opts as Record<string, unknown>);
        return Promise.resolve();
      },
      writeTicket: () => Promise.resolve(),
      appendLog: () => Promise.resolve(),
    }).run(makeTicket(BASE), "/state");

    assertEquals(spawnCalls.length, 1);
    assertEquals(spawnCalls[0].contextFile, filename);
  },
);

// ── multiple worktrees — all evaluated ───────────────────────────────────────

Deno.test(
  "checkConflictsAction: multiple worktrees — fetch error in first does not skip second",
  async () => {
    const logged: object[] = [];
    const result = await makeAction({
      runGit: (args, cwd) => {
        if (args[0] === "fetch" && cwd === "/wt/a/repo") {
          return Promise.resolve(
            { code: 1, stdout: "", stderr: "network" },
          );
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      appendLog: (_dir, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(
      makeTicket({
        ...BASE,
        prs: [{
          url: "https://github.com/myorg/myrepo/pull/7",
          title: "",
          dependsOn: [],
          merged: false,
        }],
        worktrees: {
          "a/repo": { path: "/wt/a/repo", branch: "gh-7" },
          "b/repo": { path: "/wt/b/repo", branch: "gh-7" },
        },
      }),
      "/state",
    );
    assertEquals(result, null);
    const rebaseClean = (logged as Record<string, unknown>[]).find(
      (e) => e.event === "branch-pushed",
    );
    assertNotEquals(rebaseClean, undefined);
  },
);

// ── merge/waiting run paths ──────────────────────────────────────────────────

Deno.test("checkConflictsAction: merge/waiting — clean rebase pushes and logs branch-pushed", async () => {
  const logged: object[] = [];
  const calls: string[][] = [];
  const result = await makeAction({
    runGit: (args) => {
      calls.push(args);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    appendLog: (_dir, _id, entry) => {
      logged.push(entry);
      return Promise.resolve();
    },
  }).run(
    makeTicket({
      ...BASE,
      phase: "merge",
      status: "waiting",
      prs: [{
        url: "https://github.com/myorg/myrepo/pull/7",
        title: "",
        dependsOn: [],
        merged: false,
      }],
    }),
    "/state",
  );
  assertEquals(result, null);
  assert(calls.some((a) => a[0] === "push"));
  const successEntry = (logged as Record<string, unknown>[]).find(
    (e) => e.event === "branch-pushed",
  );
  assertNotEquals(successEntry, undefined);
});

Deno.test("checkConflictsAction: merge/waiting — rebase conflict spawns agent", async () => {
  const spawnCalls: object[] = [];
  const result = await makeAction({
    runGit: (args) => {
      if (args[0] === "rebase" && args[1] === "origin/main") {
        return Promise.resolve({ code: 1, stdout: "", stderr: "CONFLICT" });
      }
      if (args[0] === "diff") {
        return Promise.resolve({ code: 0, stdout: "foo.ts", stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    spawn: (opts) => {
      spawnCalls.push(opts);
      return Promise.resolve();
    },
    writeContextFile: () => Promise.resolve("ctx.md"),
    writeTicket: () => Promise.resolve(),
    appendLog: () => Promise.resolve(),
  }).run(
    makeTicket({ ...BASE, phase: "merge", status: "waiting" }),
    "/state",
  );
  assertEquals(spawnCalls.length, 1);
  assertEquals(result?.status, "running");
});

Deno.test(
  "checkConflictsAction: multiple worktrees — both conflict → spawn targets first by insertion order, both receive git calls",
  async () => {
    const spawnCalls: Record<string, unknown>[] = [];
    const gitCalls: { args: string[]; cwd: string }[] = [];

    await makeAction({
      runGit: (args, cwd) => {
        gitCalls.push({ args, cwd });
        if (args[0] === "rebase" && args[1] === "origin/main") {
          return Promise.resolve({ code: 1, stdout: "", stderr: "CONFLICT" });
        }
        if (args[0] === "diff") {
          return Promise.resolve({ code: 0, stdout: "a.ts", stderr: "" });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      spawn: (opts) => {
        spawnCalls.push(opts as Record<string, unknown>);
        return Promise.resolve();
      },
      writeContextFile: () => Promise.resolve(""),
      writeTicket: () => Promise.resolve(),
      appendLog: () => Promise.resolve(),
    }).run(
      makeTicket({
        ...BASE,
        worktrees: {
          "a/repo": { path: "/wt/a/repo", branch: "gh-7" },
          "b/repo": { path: "/wt/b/repo", branch: "gh-7" },
        },
      }),
      "/state",
    );

    assertEquals(spawnCalls.length, 1);
    assertEquals(spawnCalls[0].worktreePath, "/wt/a/repo");
    assert(gitCalls.some((c) => c.cwd === "/wt/a/repo"));
    assert(gitCalls.some((c) => c.cwd === "/wt/b/repo"));
  },
);

Deno.test(
  "checkConflictsAction: clears phaseSessionIds.implementation on conflict-resolution-started",
  async () => {
    const written: TicketState[] = [];

    await makeAction({
      runGit: (args) => {
        if (args[0] === "rebase" && args[1] === "origin/main") {
          return Promise.resolve({ code: 1, stdout: "", stderr: "CONFLICT" });
        }
        if (args[0] === "diff") {
          return Promise.resolve({
            code: 0,
            stdout: "foo.ts",
            stderr: "",
          });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      spawn: () => Promise.resolve(),
      writeContextFile: (_ticketDir, branch) =>
        Promise.resolve(`20260727T202535-conflict-context-${branch}.md`),
      writeTicket: (_dir, t) => {
        written.push(t);
        return Promise.resolve();
      },
      appendLog: () => Promise.resolve(),
    }).run(
      makeTicket({ ...BASE, phaseSessionIds: { implementation: "sess-abc" } }),
      "/state",
    );

    const updated = written[written.length - 1];
    assertEquals(updated?.phaseSessionIds?.implementation, undefined);
  },
);

// ── rebase-blocked (no conflicted files) ─────────────────────────────────────

Deno.test(
  "checkConflictsAction: rebase fails with no conflicted files → parks as needs-attention, no spawn",
  async () => {
    const logged: object[] = [];
    const written: TicketState[] = [];
    const spawnCalls: object[] = [];
    const gitCalls: { args: string[]; cwd: string }[] = [];

    const result = await makeAction({
      runGit: (args, cwd) => {
        gitCalls.push({ args, cwd });
        if (args[0] === "rebase" && args[1] === "origin/main") {
          return Promise.resolve({
            code: 1,
            stdout: "",
            stderr: "error: cannot rebase: You have unstaged changes.",
          });
        }
        if (args[0] === "diff") {
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }
        if (args[0] === "status" && args[1] === "--short") {
          return Promise.resolve({
            code: 0,
            stdout: " M file1.ts\n M file2.ts",
            stderr: "",
          });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      spawn: (opts) => {
        spawnCalls.push(opts);
        return Promise.resolve();
      },
      writeTicket: (_dir, t) => {
        written.push(t);
        return Promise.resolve();
      },
      appendLog: (_dir, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");

    assertEquals(spawnCalls.length, 0);
    assertEquals(written.length, 1);
    assertEquals(written[0].status, "needs-attention");

    const logEntry = (logged as Record<string, unknown>[]).find(
      (e) => e.event === "needs-attention",
    );
    assertNotEquals(logEntry, undefined);
    assertEquals(logEntry!.reason, "rebase-blocked");
    assertEquals(logEntry!.worktreePath, "/wt/myorg/myrepo");
    assertEquals(logEntry!.branch, "gh-7");
    assertStringIncludes(logEntry!.rebaseStderr as string, "unstaged");
    assertEquals(logEntry!.dirtyFileCount, 2);
    assertEquals(logEntry!.dirtyFileSample, [" M file1.ts", " M file2.ts"]);

    assert(
      gitCalls.some((c) => c.args[0] === "rebase" && c.args[1] === "--abort"),
    );
    assert(
      gitCalls.some((c) => c.args[0] === "status" && c.args[1] === "--short"),
    );
    assertEquals(result?.status, "needs-attention");
  },
);

Deno.test(
  "checkConflictsAction: rebase-blocked path does not write a context file",
  async () => {
    let writeContextFileCalled = false;

    await makeAction({
      runGit: (args) => {
        if (args[0] === "rebase" && args[1] === "origin/main") {
          return Promise.resolve({
            code: 1,
            stdout: "",
            stderr: "error: cannot rebase: You have unstaged changes.",
          });
        }
        if (args[0] === "diff") {
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      writeContextFile: () => {
        writeContextFileCalled = true;
        return Promise.resolve("ctx.md");
      },
      writeTicket: () => Promise.resolve(),
      appendLog: () => Promise.resolve(),
    }).run(makeTicket(BASE), "/state");

    assertFalse(writeContextFileCalled);
  },
);

Deno.test(
  "checkConflictsAction: rebase-blocked log entry includes count and first 20 dirty file lines",
  async () => {
    const logged: object[] = [];
    const allLines = Array.from({ length: 30 }, (_, i) => ` M file${i}.ts`);

    await makeAction({
      runGit: (args) => {
        if (args[0] === "rebase" && args[1] === "origin/main") {
          return Promise.resolve({ code: 1, stdout: "", stderr: "blocked" });
        }
        if (args[0] === "diff") {
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }
        if (args[0] === "status" && args[1] === "--short") {
          return Promise.resolve({
            code: 0,
            stdout: allLines.join("\n"),
            stderr: "",
          });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      appendLog: (_dir, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
      writeTicket: () => Promise.resolve(),
    }).run(makeTicket(BASE), "/state");

    const logEntry = (logged as Record<string, unknown>[]).find(
      (e) =>
        e.event === "needs-attention" &&
        (e as Record<string, unknown>).reason === "rebase-blocked",
    );
    assertNotEquals(logEntry, undefined);
    assertEquals(logEntry!.dirtyFileCount, 30);
    assertEquals((logEntry!.dirtyFileSample as string[]).length, 20);
    assertEquals(logEntry!.dirtyFileSample as string[], allLines.slice(0, 20));
  },
);

// ── fetch serialization per slug ─────────────────────────────────────────────

Deno.test(
  "checkConflictsAction: same-slug fetches are serialized — second does not start until first completes",
  async () => {
    let resolveFirstFetch!: (v: {
      code: number;
      stdout: string;
      stderr: string;
    }) => void;
    const firstFetchDeferred = new Promise<{
      code: number;
      stdout: string;
      stderr: string;
    }>((res) => {
      resolveFirstFetch = res;
    });

    let fetchCallCount = 0;
    const action = makeAction({
      runGit: (args) => {
        if (args[0] === "fetch") {
          fetchCallCount++;
          if (fetchCallCount === 1) return firstFetchDeferred;
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    });

    const ticket = makeTicket(BASE);
    const runA = action.run(ticket, "/state");
    const runB = action.run(ticket, "/state");

    await new Promise<void>((res) => setTimeout(res, 0));
    assertEquals(
      fetchCallCount,
      1,
      "second fetch must not start while first is pending",
    );

    resolveFirstFetch({ code: 0, stdout: "", stderr: "" });
    await Promise.all([runA, runB]);

    assertEquals(fetchCallCount, 2, "both fetches must have run");
  },
);

Deno.test(
  "checkConflictsAction: different-slug fetches do not block each other — both start concurrently",
  async () => {
    const started: string[] = [];
    const resolvers: Record<string, () => void> = {};

    const action = makeAction({
      runGit: (args, cwd) => {
        if (args[0] === "fetch") {
          started.push(cwd);
          return new Promise<{ code: number; stdout: string; stderr: string }>(
            (res) => {
              resolvers[cwd] = () => res({ code: 0, stdout: "", stderr: "" });
            },
          );
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    });

    const ticketA = makeTicket({
      ...BASE,
      worktrees: { "a/repo": { path: "/wt/a/repo", branch: "gh-7" } },
    });
    const ticketB = makeTicket({
      ...BASE,
      worktrees: { "b/repo": { path: "/wt/b/repo", branch: "gh-7" } },
    });

    const runA = action.run(ticketA, "/state");
    const runB = action.run(ticketB, "/state");

    await new Promise<void>((res) => setTimeout(res, 0));

    assert(
      started.includes("/wt/a/repo"),
      "fetch for a/repo should have started",
    );
    assert(
      started.includes("/wt/b/repo"),
      "fetch for b/repo should have started without waiting for a/repo",
    );

    Object.values(resolvers).forEach((r) => r());
    await Promise.all([runA, runB]);
  },
);

Deno.test(
  "checkConflictsAction: mixed worktrees — blocked takes priority over real conflict, no spawn",
  async () => {
    const spawnCalls: object[] = [];
    const written: TicketState[] = [];

    const result = await makeAction({
      runGit: (args, cwd) => {
        if (args[0] === "rebase" && args[1] === "origin/main") {
          if (cwd === "/wt/a/repo") {
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr: "error: cannot rebase: You have unstaged changes.",
            });
          }
          return Promise.resolve({
            code: 1,
            stdout: "",
            stderr: "CONFLICT (content): Merge conflict in bar.ts",
          });
        }
        if (args[0] === "diff" && cwd === "/wt/a/repo") {
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }
        if (args[0] === "diff" && cwd === "/wt/b/repo") {
          return Promise.resolve({ code: 0, stdout: "bar.ts", stderr: "" });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      spawn: (opts) => {
        spawnCalls.push(opts);
        return Promise.resolve();
      },
      writeContextFile: () => Promise.resolve("ctx.md"),
      writeTicket: (_dir, t) => {
        written.push(t);
        return Promise.resolve();
      },
      appendLog: () => Promise.resolve(),
    }).run(
      makeTicket({
        ...BASE,
        worktrees: {
          "a/repo": { path: "/wt/a/repo", branch: "gh-7" },
          "b/repo": { path: "/wt/b/repo", branch: "gh-7" },
        },
      }),
      "/state",
    );

    assertEquals(spawnCalls.length, 0);
    assertEquals(written.length, 1);
    assertEquals(written[0].status, "needs-attention");
    assertEquals(result?.status, "needs-attention");
  },
);
