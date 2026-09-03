import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertFalse,
} from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { resolveCIFixAction } from "./resolve-ci-fix.ts";
import type { ResolveCIFixDeps } from "./resolve-ci-fix.ts";
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

const CONTEXT_FILENAME = "20260812T101500-ci-fix-context-1001-1.md";
const OUTPUT_FILENAME = "20260812T101500-ci-fix-1001-1.md";

const PR_HEAD_SHA = "1111111111111111111111111111111111111111";
const WORKTREE_HEAD_SHA = "2222222222222222222222222222222222222222";

const CONTEXT_CONTENT =
  "PR-URL: https://github.com/jackjennings/lazyboy/pull/99\n" +
  "Repo: jackjennings/lazyboy\n" +
  "Run-ID: 1001\n" +
  "Attempt: 1\n" +
  "Branch: github/jackjennings/lazyboy/178\n" +
  `Head-SHA: ${PR_HEAD_SHA}\n` +
  "Worktree-Path: /wt/lazyboy\n\n" +
  "## Failing jobs\n\n- lint";

const CONTEXT_WITHOUT_HEAD_SHA = CONTEXT_CONTENT.replace(
  `Head-SHA: ${PR_HEAD_SHA}\n`,
  "",
);

function makeGitSpy(head = WORKTREE_HEAD_SHA) {
  return spy((args: string[], _cwd: string) =>
    Promise.resolve({
      code: 0,
      stdout: args[0] === "rev-parse" ? `${head}\n` : "",
      stderr: "",
    })
  );
}

const FIXED_OUTPUT = "Ran deno fmt and committed the result.\nVERDICT: FIXED\n";
const FIXED_WITH_LEARNING_OUTPUT = "Ran deno fmt and committed the result.\n" +
  "VERDICT: FIXED\n" +
  "LEARNING: Run deno fmt after resolving conflicts so formatting drift never reaches CI.\n";
const INFRA_OUTPUT =
  "Package download timed out on the runner.\nVERDICT: INFRA\n";
const UNFIXABLE_OUTPUT =
  "The failure needs a product decision.\nVERDICT: UNFIXABLE\n";

function makeDeps(overrides: Partial<ResolveCIFixDeps> = {}): ResolveCIFixDeps {
  return {
    isProcessAlive: () => false,
    hasCIFixContextFiles: () => false,
    readDir: async function* () {
      yield { name: CONTEXT_FILENAME, isFile: true };
    },
    readFile: (path: string) =>
      Promise.resolve(
        path.endsWith(CONTEXT_FILENAME) ? CONTEXT_CONTENT : FIXED_OUTPUT,
      ),
    remove: () => Promise.resolve(),
    rename: () => Promise.resolve(),
    runGit: (args: string[]) =>
      Promise.resolve({
        code: 0,
        stdout: args[0] === "rev-parse" ? `${WORKTREE_HEAD_SHA}\n` : "",
        stderr: "",
      }),
    rerunFailedJobs: () => Promise.resolve(),
    writeTicket: () => Promise.resolve(),
    appendLog: () => Promise.resolve(),
    writeLearning: () => Promise.resolve(),
    ...overrides,
  };
}

function makeAction(overrides: Partial<ResolveCIFixDeps> = {}) {
  return resolveCIFixAction(makeDeps(overrides));
}

function outputReader(output: string) {
  return (path: string) =>
    Promise.resolve(path.endsWith(CONTEXT_FILENAME) ? CONTEXT_CONTENT : output);
}

Deno.test("resolveCIFixAction: applies when context files exist and no process is alive", () => {
  assert(
    makeAction({ hasCIFixContextFiles: () => true }).applies(makeTicket(BASE)),
  );
});

Deno.test("resolveCIFixAction: does not apply when a process is alive", () => {
  assertFalse(
    makeAction({ hasCIFixContextFiles: () => true, isProcessAlive: () => true })
      .applies(makeTicket(BASE)),
  );
});

Deno.test("resolveCIFixAction: does not apply without context files", () => {
  assertFalse(
    makeAction({ hasCIFixContextFiles: () => false }).applies(makeTicket(BASE)),
  );
});

Deno.test("resolveCIFixAction: returns null when the directory holds no context files", async () => {
  const result = await makeAction({
    readDir: async function* () {
      yield { name: "plan.md", isFile: true };
    },
  }).run(makeTicket(BASE), "/state");
  assertEquals(result, null);
});

Deno.test("resolveCIFixAction: FIXED force-pushes the branch and logs branch-pushed", async () => {
  const gitSpy = makeGitSpy();
  const logged: Record<string, unknown>[] = [];
  const result = await makeAction({
    runGit: gitSpy,
    appendLog: (_sd, _id, entry) => {
      logged.push(entry as Record<string, unknown>);
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assertSpyCalls(gitSpy, 2);
  assertEquals(gitSpy.calls[1]!.args[0], [
    "push",
    `--force-with-lease=refs/heads/github/jackjennings/lazyboy/178:${PR_HEAD_SHA}`,
    "origin",
    "github/jackjennings/lazyboy/178",
  ]);
  assertEquals(gitSpy.calls[1]!.args[1], "/wt/lazyboy");
  assertEquals(logged[0].event, "branch-pushed");
  assertEquals(result?.status, "waiting");
});

Deno.test("resolveCIFixAction: FIXED without a Head-SHA header pushes with a bare lease", async () => {
  const gitSpy = makeGitSpy();
  const result = await makeAction({
    runGit: gitSpy,
    readFile: (path: string) =>
      Promise.resolve(
        path.endsWith(CONTEXT_FILENAME)
          ? CONTEXT_WITHOUT_HEAD_SHA
          : FIXED_OUTPUT,
      ),
  }).run(makeTicket(BASE), "/state");
  assertSpyCalls(gitSpy, 1);
  assertEquals(gitSpy.calls[0]!.args[0], [
    "push",
    "--force-with-lease",
    "origin",
    "github/jackjennings/lazyboy/178",
  ]);
  assertEquals(result?.status, "waiting");
});

Deno.test("resolveCIFixAction: FIXED with an unmoved worktree HEAD parks without pushing", async () => {
  const gitSpy = makeGitSpy(PR_HEAD_SHA);
  const logged: Record<string, unknown>[] = [];
  const result = await makeAction({
    runGit: gitSpy,
    appendLog: (_sd, _id, entry) => {
      logged.push(entry as Record<string, unknown>);
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assertSpyCalls(gitSpy, 1);
  assertEquals(gitSpy.calls[0]!.args[0], ["rev-parse", "HEAD"]);
  assertEquals(result?.status, "needs-attention");
  assertEquals(logged[0].reason, "no-commit");
  assertFalse(logged.some((e) => e.event === "branch-pushed"));
});

Deno.test("resolveCIFixAction: FIXED with an unmoved worktree HEAD renames context and preserves output", async () => {
  const renamed: Array<[string, string]> = [];
  const removed: string[] = [];
  await makeAction({
    runGit: makeGitSpy(PR_HEAD_SHA),
    rename: (oldPath: string, newPath: string) => {
      renamed.push([oldPath, newPath]);
      return Promise.resolve();
    },
    remove: (path: string) => {
      removed.push(path);
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assert(renamed.some(([old]) => old.endsWith(CONTEXT_FILENAME)));
  assert(renamed.some(([, n]) => n.endsWith(CONTEXT_FILENAME + ".parked")));
  assertFalse(removed.some((p) => p.endsWith(OUTPUT_FILENAME)));
});

Deno.test("resolveCIFixAction: FIXED with an unreadable worktree HEAD still pushes", async () => {
  const gitSpy = spy((args: string[], _cwd: string) =>
    Promise.resolve(
      args[0] === "rev-parse"
        ? { code: 128, stdout: "", stderr: "not a git repository" }
        : { code: 0, stdout: "", stderr: "" },
    )
  );
  const result = await makeAction({ runGit: gitSpy }).run(
    makeTicket(BASE),
    "/state",
  );
  assertSpyCalls(gitSpy, 2);
  assertArrayIncludes(gitSpy.calls[1]!.args[0], ["push"]);
  assertEquals(result?.status, "waiting");
});

Deno.test("resolveCIFixAction: FIXED logs ci-fix-resolved with the verdict and attempt", async () => {
  const logged: Record<string, unknown>[] = [];
  await makeAction({
    appendLog: (_sd, _id, entry) => {
      logged.push(entry as Record<string, unknown>);
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  const resolved = logged.find((e) => e.event === "ci-fix-resolved");
  assertEquals(resolved?.verdict, "FIXED");
  assertEquals(resolved?.runId, "1001");
  assertEquals(resolved?.attempt, "1");
});

Deno.test("resolveCIFixAction: FIXED with a push failure parks the ticket", async () => {
  const logged: Record<string, unknown>[] = [];
  const result = await makeAction({
    runGit: () => Promise.resolve({ code: 1, stdout: "", stderr: "rejected" }),
    appendLog: (_sd, _id, entry) => {
      logged.push(entry as Record<string, unknown>);
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assertEquals(result?.status, "needs-attention");
  assertEquals(logged[0].reason, "push-failed");
});

Deno.test("resolveCIFixAction: FIXED writes the learning when a LEARNING line is present", async () => {
  const learningSpy = spy(() => Promise.resolve());
  await makeAction({
    readFile: outputReader(FIXED_WITH_LEARNING_OUTPUT),
    writeLearning: learningSpy,
  }).run(makeTicket(BASE), "/state");
  assertSpyCalls(learningSpy, 1);
  // deno-lint-ignore no-explicit-any
  const passed = (learningSpy as any).calls[0].args[0] as Record<
    string,
    unknown
  >;
  assertEquals("prTitle" in passed, false);
  assertEquals("prBody" in passed, false);
  assertEquals(passed.targetFile, "AGENTS.md");
});

Deno.test("resolveCIFixAction: FIXED without a LEARNING line writes no learning", async () => {
  const learningSpy = spy(() => Promise.resolve());
  await makeAction({ writeLearning: learningSpy }).run(
    makeTicket(BASE),
    "/state",
  );
  assertSpyCalls(learningSpy, 0);
});

Deno.test("resolveCIFixAction: INFRA on attempt 1 re-runs the failed jobs and does not push", async () => {
  const gitSpy = spy(
    (_args: string[], _cwd: string) =>
      Promise.resolve({ code: 0, stdout: "", stderr: "" }),
  );
  const rerunSpy = spy((_opts: { repo: string; runId: string }) =>
    Promise.resolve()
  );
  const result = await makeAction({
    readFile: outputReader(INFRA_OUTPUT),
    runGit: gitSpy,
    rerunFailedJobs: rerunSpy,
  }).run(makeTicket(BASE), "/state");
  assertSpyCalls(gitSpy, 0);
  assertSpyCalls(rerunSpy, 1);
  assertEquals(rerunSpy.calls[0]!.args[0], {
    repo: "jackjennings/lazyboy",
    runId: "1001",
  });
  assertEquals(result?.status, "waiting");
});

Deno.test("resolveCIFixAction: INFRA on attempt 2 parks and does not re-run", async () => {
  const rerunSpy = spy((_opts: { repo: string; runId: string }) =>
    Promise.resolve()
  );
  const logged: Record<string, unknown>[] = [];
  const result = await makeAction({
    readFile: (path: string) =>
      Promise.resolve(
        path.endsWith(CONTEXT_FILENAME)
          ? CONTEXT_CONTENT.replace("Attempt: 1", "Attempt: 2")
          : INFRA_OUTPUT,
      ),
    rerunFailedJobs: rerunSpy,
    appendLog: (_sd, _id, entry) => {
      logged.push(entry as Record<string, unknown>);
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assertSpyCalls(rerunSpy, 0);
  assertEquals(result?.status, "needs-attention");
  assertEquals(logged[0].reason, "infra-rerun-exhausted");
});

Deno.test("resolveCIFixAction: INFRA with a missing Attempt header re-runs rather than parking", async () => {
  const rerunSpy = spy((_opts: { repo: string; runId: string }) =>
    Promise.resolve()
  );
  const result = await makeAction({
    readFile: (path: string) =>
      Promise.resolve(
        path.endsWith(CONTEXT_FILENAME)
          ? CONTEXT_CONTENT.replace("Attempt: 1\n", "")
          : INFRA_OUTPUT,
      ),
    rerunFailedJobs: rerunSpy,
  }).run(makeTicket(BASE), "/state");
  assertSpyCalls(rerunSpy, 1);
  assertEquals(result?.status, "waiting");
});

Deno.test("resolveCIFixAction: INFRA with a non-numeric Attempt header re-runs rather than parking", async () => {
  const rerunSpy = spy((_opts: { repo: string; runId: string }) =>
    Promise.resolve()
  );
  const result = await makeAction({
    readFile: (path: string) =>
      Promise.resolve(
        path.endsWith(CONTEXT_FILENAME)
          ? CONTEXT_CONTENT.replace("Attempt: 1", "Attempt: not-a-number")
          : INFRA_OUTPUT,
      ),
    rerunFailedJobs: rerunSpy,
  }).run(makeTicket(BASE), "/state");
  assertSpyCalls(rerunSpy, 1);
  assertEquals(result?.status, "waiting");
});

Deno.test("resolveCIFixAction: a failed re-run is logged and does not park the ticket", async () => {
  const logged: Record<string, unknown>[] = [];
  const result = await makeAction({
    readFile: outputReader(INFRA_OUTPUT),
    rerunFailedJobs: () => Promise.reject(new Error("rate limit")),
    appendLog: (_sd, _id, entry) => {
      logged.push(entry as Record<string, unknown>);
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assertEquals(result?.status, "waiting");
  assertEquals(logged[0].reason, "rerun-failed");
});

Deno.test("resolveCIFixAction: UNFIXABLE parks the ticket", async () => {
  const logged: Record<string, unknown>[] = [];
  const result = await makeAction({
    readFile: outputReader(UNFIXABLE_OUTPUT),
    appendLog: (_sd, _id, entry) => {
      logged.push(entry as Record<string, unknown>);
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assertEquals(result?.status, "needs-attention");
  assertEquals(logged[0].reason, "ci-unfixable");
});

Deno.test("resolveCIFixAction: a missing output file parks the ticket", async () => {
  const logged: Record<string, unknown>[] = [];
  const result = await makeAction({
    readFile: (path: string) =>
      Promise.resolve(path.endsWith(CONTEXT_FILENAME) ? CONTEXT_CONTENT : null),
    appendLog: (_sd, _id, entry) => {
      logged.push(entry as Record<string, unknown>);
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assertEquals(result?.status, "needs-attention");
  assertEquals(logged[0].reason, "output-file-missing");
});

Deno.test("resolveCIFixAction: a missing verdict line parks the ticket", async () => {
  const logged: Record<string, unknown>[] = [];
  const result = await makeAction({
    readFile: outputReader("I looked at the logs and gave up.\n"),
    appendLog: (_sd, _id, entry) => {
      logged.push(entry as Record<string, unknown>);
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assertEquals(result?.status, "needs-attention");
  assertEquals(logged[0].reason, "no-verdict-line");
});

Deno.test("resolveCIFixAction: no-verdict-line log entry includes outputExcerpt", async () => {
  const OUTPUT = "I looked at the logs and gave up.\n";
  const logged: Record<string, unknown>[] = [];
  await makeAction({
    readFile: outputReader(OUTPUT),
    appendLog: (_sd, _id, entry) => {
      logged.push(entry as Record<string, unknown>);
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assertEquals(logged[0].reason, "no-verdict-line");
  assertEquals(logged[0].outputExcerpt, OUTPUT.trim().slice(0, 200));
});

Deno.test("resolveCIFixAction: FIXED with an empty worktree path parks the ticket", async () => {
  const logged: Record<string, unknown>[] = [];
  const result = await makeAction({
    readFile: (path: string) =>
      Promise.resolve(
        path.endsWith(CONTEXT_FILENAME)
          ? CONTEXT_CONTENT.replace(
            "Worktree-Path: /wt/lazyboy",
            "Worktree-Path:",
          )
          : FIXED_OUTPUT,
      ),
    appendLog: (_sd, _id, entry) => {
      logged.push(entry as Record<string, unknown>);
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assertEquals(result?.status, "needs-attention");
  assertEquals(logged[0].reason, "no-worktrees");
});

Deno.test("resolveCIFixAction: renames context to .parked and preserves output on no-verdict-line park", async () => {
  const renamed: Array<[string, string]> = [];
  const removed: string[] = [];
  await makeAction({
    readFile: outputReader("I looked at the logs and gave up.\n"),
    rename: (oldPath: string, newPath: string) => {
      renamed.push([oldPath, newPath]);
      return Promise.resolve();
    },
    remove: (path: string) => {
      removed.push(path);
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assert(renamed.some(([old]) => old.endsWith(CONTEXT_FILENAME)));
  assert(renamed.some(([, n]) => n.endsWith(CONTEXT_FILENAME + ".parked")));
  assertFalse(removed.some((p) => p.endsWith(OUTPUT_FILENAME)));
});

Deno.test("resolveCIFixAction: renames context to .parked and preserves output on push-failed park", async () => {
  const renamed: Array<[string, string]> = [];
  const removed: string[] = [];
  await makeAction({
    runGit: () => Promise.resolve({ code: 1, stdout: "", stderr: "rejected" }),
    rename: (oldPath: string, newPath: string) => {
      renamed.push([oldPath, newPath]);
      return Promise.resolve();
    },
    remove: (path: string) => {
      removed.push(path);
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assert(renamed.some(([old]) => old.endsWith(CONTEXT_FILENAME)));
  assert(renamed.some(([, n]) => n.endsWith(CONTEXT_FILENAME + ".parked")));
  assertFalse(removed.some((p) => p.endsWith(OUTPUT_FILENAME)));
});

Deno.test("resolveCIFixAction: renames context to .parked and preserves output on UNFIXABLE park", async () => {
  const renamed: Array<[string, string]> = [];
  const removed: string[] = [];
  await makeAction({
    readFile: outputReader(UNFIXABLE_OUTPUT),
    rename: (oldPath: string, newPath: string) => {
      renamed.push([oldPath, newPath]);
      return Promise.resolve();
    },
    remove: (path: string) => {
      removed.push(path);
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assert(renamed.some(([old]) => old.endsWith(CONTEXT_FILENAME)));
  assert(renamed.some(([, n]) => n.endsWith(CONTEXT_FILENAME + ".parked")));
  assertFalse(removed.some((p) => p.endsWith(OUTPUT_FILENAME)));
});

Deno.test("resolveCIFixAction: renames context to .parked on output-file-missing park", async () => {
  const renamed: Array<[string, string]> = [];
  const renameSpy = spy((oldPath: string, newPath: string) => {
    renamed.push([oldPath, newPath]);
    return Promise.resolve();
  });
  await makeAction({
    readFile: (path: string) =>
      Promise.resolve(path.endsWith(CONTEXT_FILENAME) ? CONTEXT_CONTENT : null),
    rename: renameSpy,
  }).run(makeTicket(BASE), "/state");
  assert(renamed.some(([old]) => old.endsWith(CONTEXT_FILENAME)));
  assert(renamed.some(([, n]) => n.endsWith(CONTEXT_FILENAME + ".parked")));
  assertFalse(renamed.some(([old]) => old.endsWith(OUTPUT_FILENAME)));
});

Deno.test("resolveCIFixAction: an unreadable context file is removed so the action stops re-firing", async () => {
  const removed: string[] = [];
  const gitSpy = makeGitSpy();
  const logged: Record<string, unknown>[] = [];
  const result = await makeAction({
    readFile: (path: string) =>
      Promise.resolve(path.endsWith(CONTEXT_FILENAME) ? null : FIXED_OUTPUT),
    remove: (path: string) => {
      removed.push(path);
      return Promise.resolve();
    },
    runGit: gitSpy,
    appendLog: (_sd, _id, entry) => {
      logged.push(entry as Record<string, unknown>);
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assertArrayIncludes(removed, [`/state/${BASE.id}/${CONTEXT_FILENAME}`]);
  assertSpyCalls(gitSpy, 0);
  assertEquals(logged[0].reason, "context-file-unreadable");
  assertEquals(result?.status, "waiting");
});

Deno.test("resolveCIFixAction: removes the context and output files after a FIXED run", async () => {
  const removed: string[] = [];
  await makeAction({
    remove: (path: string) => {
      removed.push(path);
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assert(removed.some((p) => p.endsWith(CONTEXT_FILENAME)));
  assert(removed.some((p) => p.endsWith(OUTPUT_FILENAME)));
});
