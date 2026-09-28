import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertFalse,
  assertGreater,
  assertNotEquals,
} from "@std/assert";
import { resolveConflictsAction } from "./resolve-conflicts.ts";
import type { TicketState } from "../state/types.ts";
import { makeTicket } from "../test-support.ts";

const BASE = {
  id: "gh-7",
  url: "https://github.com/myorg/myrepo/issues/7",
  phase: "implementation" as const,
  status: "running" as const,
  worktrees: {
    "myorg/myrepo": { path: "/wt/myorg/myrepo", branch: "gh-7" },
  },
  created: "2026-06-30T00:00:00Z",
  updated: "2026-06-30T00:00:00Z",
};

const isRebaseStatePath = (path: string) =>
  path.endsWith("rebase-merge") || path.endsWith("rebase-apply");

function makeAction(
  overrides: Partial<Parameters<typeof resolveConflictsAction>[0]> = {},
) {
  const { runGit: runGitOverride, ...rest } = overrides;
  const baseRunGit = runGitOverride ??
    (() => Promise.resolve({ code: 0, stdout: "", stderr: "" }));
  return resolveConflictsAction({
    runGit: (args, cwd) => {
      if (args[0] === "symbolic-ref") {
        return baseRunGit(args, cwd).then((result) => {
          if (result.code !== 0 || result.stdout.trim()) return result;
          return { code: 0, stdout: "gh-7\n", stderr: "" };
        });
      }
      return baseRunGit(args, cwd);
    },
    isProcessAlive: () => false,
    writeTicket: () => Promise.resolve(),
    appendLog: () => Promise.resolve(),
    stat: () => Promise.resolve(false),
    readDir: async function* () {},
    remove: () => Promise.resolve(),
    readPhaseSessionId: () => Promise.resolve(null),
    ...rest,
  });
}

// ── applies ──────────────────────────────────────────────────────────────────

Deno.test("resolveConflictsAction: applies when running, pid dead", () => {
  assert(makeAction().applies(makeTicket(BASE)));
});

Deno.test("resolveConflictsAction: does not apply when pid is alive", () => {
  assertFalse(
    makeAction({ isProcessAlive: () => true }).applies(makeTicket(BASE)),
  );
});

Deno.test("resolveConflictsAction: does not apply when status is not running", () => {
  assertFalse(
    makeAction().applies(makeTicket({ ...BASE, status: "waiting" })),
  );
});

// ── run returns null with no context files ────────────────────────────────────

Deno.test(
  "resolveConflictsAction: run returns null when no conflict-context files found",
  async () => {
    const result = await makeAction({
      readDir: async function* () {
        yield { name: "plan.md", isFile: true };
      },
    }).run(makeTicket(BASE), "/state");
    assertEquals(result, null);
  },
);

// ── old-format files are ignored ─────────────────────────────────────────────

Deno.test(
  "resolveConflictsAction: run returns null for old-format context files without timestamp prefix",
  async () => {
    const result = await makeAction({
      readDir: async function* () {
        yield { name: "conflict-context-gh-7.md", isFile: true };
      },
    }).run(makeTicket(BASE), "/state");
    assertEquals(result, null);
  },
);

// ── success path ──────────────────────────────────────────────────────────────

Deno.test(
  "resolveConflictsAction: success — no rebase in progress, pushes, logs conflict-resolved, status waiting",
  async () => {
    const logged: object[] = [];
    const written: TicketState[] = [];
    const gitCalls: string[][] = [];
    const removed: string[] = [];

    const result = await makeAction({
      runGit: (args) => {
        gitCalls.push(args);
        if (args[0] === "rev-parse") {
          return Promise.resolve({ code: 0, stdout: "/wt/.git\n", stderr: "" });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      stat: (path) => Promise.resolve(!isRebaseStatePath(path)),
      readDir: async function* () {
        yield {
          name: "20260101T000000-conflict-context-gh-7.md",
          isFile: true,
        };
      },
      remove: (path) => {
        removed.push(path);
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

    assert(gitCalls.some((a) => a[0] === "push"));
    assertGreater(removed.length, 0);
    assertEquals(result?.status, "waiting");

    const resolved = (logged as Record<string, unknown>[]).find(
      (e) => e.event === "conflict-resolved",
    );
    assertNotEquals(resolved, undefined);
    assertEquals(resolved!.worktreePath, "/wt/myorg/myrepo");
    assertEquals(resolved!.branch, "gh-7");

    const pushed = (logged as Record<string, unknown>[]).find(
      (e) => e.event === "branch-pushed",
    );
    assertNotEquals(pushed, undefined);
    assertEquals(pushed!.worktreePath, "/wt/myorg/myrepo");
    assertEquals(pushed!.branch, "gh-7");
  },
);

// ── multiple worktrees — only the resolved one is touched ────────────────────

Deno.test(
  "resolveConflictsAction: multi-worktree — only pushes/logs the worktree with a matching context file",
  async () => {
    const logged: object[] = [];
    const gitCalls: { args: string[]; cwd: string }[] = [];

    const result = await makeAction({
      runGit: (args, cwd) => {
        gitCalls.push({ args, cwd });
        if (args[0] === "rev-parse") {
          return Promise.resolve({ code: 0, stdout: "/wt/.git\n", stderr: "" });
        }
        if (args[0] === "symbolic-ref" && cwd === "/wt/a/repo") {
          return Promise.resolve({ code: 0, stdout: "a-repo\n", stderr: "" });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      stat: () => Promise.resolve(false),
      readDir: async function* () {
        yield {
          name: "20260101T000000-conflict-context-a-repo.md",
          isFile: true,
        };
      },
      remove: () => Promise.resolve(),
      appendLog: (_dir, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(
      makeTicket({
        ...BASE,
        worktrees: {
          "a/repo": { path: "/wt/a/repo", branch: "a-repo" },
          "b/repo": { path: "/wt/b/repo", branch: "b-repo" },
        },
      }),
      "/state",
    );

    assertEquals(result?.status, "waiting");
    assertFalse(
      gitCalls.some((c) => c.cwd === "/wt/b/repo"),
    );
    const resolvedEntries = (logged as Record<string, unknown>[]).filter(
      (e) => e.event === "conflict-resolved",
    );
    assertEquals(resolvedEntries.length, 1);
    assertEquals(resolvedEntries[0].branch, "a-repo");
  },
);

// ── failure path: rebase still in progress ───────────────────────────────────

Deno.test(
  "resolveConflictsAction: failure — rebase in progress → aborts, logs agent-failed, status needs-attention",
  async () => {
    const logged: object[] = [];
    const written: TicketState[] = [];
    const gitCalls: string[][] = [];
    const removed: string[] = [];

    const result = await makeAction({
      readPhaseSessionId: () => Promise.resolve("sess_agent_failed"),
      runGit: (args) => {
        gitCalls.push(args);
        if (args[0] === "rev-parse") {
          return Promise.resolve({ code: 0, stdout: "/wt/.git\n", stderr: "" });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      stat: (path) => Promise.resolve(isRebaseStatePath(path)),
      readDir: async function* () {
        yield {
          name: "20260101T000000-conflict-context-gh-7.md",
          isFile: true,
        };
      },
      remove: (path) => {
        removed.push(path);
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

    assert(
      gitCalls.some((a) => a[0] === "rebase" && a[1] === "--abort"),
    );
    assertGreater(removed.length, 0);
    assertEquals(result?.status, "needs-attention");

    const failed = (logged as Record<string, unknown>[]).find(
      (e) => e.event === "conflict-resolution-failed",
    );
    assertNotEquals(failed, undefined);
    assertEquals(failed!.reason, "agent-failed");
    assertEquals(failed!.sessionId, "sess_agent_failed");
  },
);

// ── REBASE_HEAD lingers after a completed rebase ─────────────────────────────

Deno.test(
  "resolveConflictsAction: success — leftover REBASE_HEAD with no rebase dirs still resolves",
  async () => {
    const logged: object[] = [];

    const result = await makeAction({
      runGit: (args) => {
        if (args[0] === "rev-parse") {
          return Promise.resolve({ code: 0, stdout: "/wt/.git\n", stderr: "" });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      stat: (path) => Promise.resolve(!isRebaseStatePath(path)),
      readDir: async function* () {
        yield {
          name: "20260101T000000-conflict-context-gh-7.md",
          isFile: true,
        };
      },
      remove: () => Promise.resolve(),
      appendLog: (_dir, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");

    assertEquals(result?.status, "waiting");
    assertArrayIncludes(
      (logged as Record<string, unknown>[]).map((e) => e.event),
      ["conflict-resolved"],
    );
  },
);

// ── failure path: push fails ──────────────────────────────────────────────────

Deno.test(
  "resolveConflictsAction: failure — push fails → logs push-failed, status needs-attention",
  async () => {
    const logged: object[] = [];
    const written: TicketState[] = [];
    const gitCalls: string[][] = [];

    const result = await makeAction({
      readPhaseSessionId: () => Promise.resolve("sess_push_failed"),
      runGit: (args) => {
        gitCalls.push(args);
        if (args[0] === "push") {
          return Promise.resolve({
            code: 1,
            stdout: "",
            stderr: "auth failure",
          });
        }
        if (args[0] === "rev-parse") {
          return Promise.resolve({ code: 0, stdout: "/wt/.git\n", stderr: "" });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      stat: (path) => Promise.resolve(!isRebaseStatePath(path)),
      readDir: async function* () {
        yield {
          name: "20260101T000000-conflict-context-gh-7.md",
          isFile: true,
        };
      },
      remove: () => Promise.resolve(),
      writeTicket: (_dir, t) => {
        written.push(t);
        return Promise.resolve();
      },
      appendLog: (_dir, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");

    assertEquals(result?.status, "needs-attention");

    const failed = (logged as Record<string, unknown>[]).find(
      (e) => e.event === "conflict-resolution-failed",
    );
    assertNotEquals(failed, undefined);
    assertEquals(failed!.reason, "push-failed");
    assertEquals(failed!.sessionId, "sess_push_failed");
  },
);

// ── branch mismatch ──────────────────────────────────────────────────────────

Deno.test(
  "resolveConflictsAction: branch mismatch before push → parks as needs-attention",
  async () => {
    const logged: object[] = [];
    const written: TicketState[] = [];
    const gitCalls: string[][] = [];

    const result = await makeAction({
      runGit: (args) => {
        gitCalls.push(args);
        if (args[0] === "rev-parse") {
          return Promise.resolve({ code: 0, stdout: "/wt/.git\n", stderr: "" });
        }
        if (args[0] === "symbolic-ref") {
          return Promise.resolve({
            code: 0,
            stdout: "fix/other-branch\n",
            stderr: "",
          });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      stat: (path) => Promise.resolve(!isRebaseStatePath(path)),
      readDir: async function* () {
        yield {
          name: "20260101T000000-conflict-context-gh-7.md",
          isFile: true,
        };
      },
      remove: () => Promise.resolve(),
      writeTicket: (_dir, t) => {
        written.push(t);
        return Promise.resolve();
      },
      appendLog: (_dir, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");

    assertEquals(result?.status, "needs-attention");
    assertFalse(gitCalls.some((a) => a[0] === "push"));

    const logEntry = (logged as Record<string, unknown>[]).find(
      (e) => e.event === "needs-attention",
    );
    assertNotEquals(logEntry, undefined);
    assertEquals(logEntry!.reason, "worktree-branch-mismatch");
    assertEquals(logEntry!.worktreePath, "/wt/myorg/myrepo");
    assertEquals(logEntry!.expected, "gh-7");
    assertEquals(logEntry!.found, "fix/other-branch");
  },
);

Deno.test(
  "resolveConflictsAction: detached HEAD before push → parks as needs-attention with found '(detached)'",
  async () => {
    const logged: object[] = [];
    const written: TicketState[] = [];

    const result = await makeAction({
      runGit: (args) => {
        if (args[0] === "rev-parse") {
          return Promise.resolve({ code: 0, stdout: "/wt/.git\n", stderr: "" });
        }
        if (args[0] === "symbolic-ref") {
          return Promise.resolve({
            code: 128,
            stdout: "",
            stderr: "fatal: ref HEAD is not a symbolic ref",
          });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      stat: (path) => Promise.resolve(!isRebaseStatePath(path)),
      readDir: async function* () {
        yield {
          name: "20260101T000000-conflict-context-gh-7.md",
          isFile: true,
        };
      },
      remove: () => Promise.resolve(),
      writeTicket: (_dir, t) => {
        written.push(t);
        return Promise.resolve();
      },
      appendLog: (_dir, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");

    assertEquals(result?.status, "needs-attention");
    const logEntry = (logged as Record<string, unknown>[]).find(
      (e) => e.event === "needs-attention",
    );
    assertNotEquals(logEntry, undefined);
    assertEquals(logEntry!.reason, "worktree-branch-mismatch");
    assertEquals(logEntry!.found, "(detached)");
  },
);

// ── failure path: no session sidecar → sessionId absent ──────────────────────

Deno.test(
  "resolveConflictsAction: failure — no session sidecar → sessionId absent from log entry",
  async () => {
    const logged: object[] = [];

    await makeAction({
      readPhaseSessionId: () => Promise.resolve(null),
      runGit: (args) => {
        if (args[0] === "rev-parse") {
          return Promise.resolve({ code: 0, stdout: "/wt/.git\n", stderr: "" });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      stat: (path) => Promise.resolve(isRebaseStatePath(path)),
      readDir: async function* () {
        yield {
          name: "20260101T000000-conflict-context-gh-7.md",
          isFile: true,
        };
      },
      remove: () => Promise.resolve(),
      writeTicket: () => Promise.resolve(),
      appendLog: (_dir, _id, entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");

    const failed = (logged as Record<string, unknown>[]).find(
      (e) => e.event === "conflict-resolution-failed",
    );
    assertNotEquals(failed, undefined);
    assertFalse("sessionId" in failed!);
  },
);
