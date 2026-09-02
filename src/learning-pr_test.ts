import { assertEquals, assertRejects } from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { applyLearningToRepo, type LearningPrDeps } from "./learning-pr.ts";
import type { LearningState } from "./state/types.ts";

function learning(overrides: Partial<LearningState> = {}): LearningState {
  return {
    id: "20260729T050000",
    ticketId: "github/jackjennings/lazyboy/226",
    repo: "jackjennings/lazyboy",
    targetFile: "AGENTS.md",
    status: "pending",
    prs: [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<LearningPrDeps> = {}): LearningPrDeps {
  return {
    roots: ["/home/user/code"],
    findLocalRepo: () => Promise.resolve("/home/user/code/jackjennings/urras"),
    createWorktree: () =>
      Promise.resolve({ path: "/tmp/wt", branch: "20260729T050000" }),
    removeWorktree: () => Promise.resolve(),
    readTextFile: () => Promise.resolve("existing content"),
    writeTextFile: () => Promise.resolve(),
    mkdir: () => Promise.resolve(),
    applyLearning: () => Promise.resolve("updated content"),
    captureCommandRunner:
      () => (() => Promise.resolve({ code: 0, stdout: "" })),
    resolveAccount: () => ({ token: "tok123", login: "jackjennings" }),
    run: (cmd) => {
      if (cmd[0] === "gh") {
        return Promise.resolve({
          code: 0,
          stdout: "https://github.com/jackjennings/urras/pull/42\n",
        });
      }
      return Promise.resolve({ code: 0, stdout: "" });
    },
    ...overrides,
  };
}

Deno.test("applyLearningToRepo: resolves the repo via findLocalRepo with the full slug", async () => {
  const findLocalRepo = spy((_roots: string[], _slug: string) =>
    Promise.resolve("/home/user/code/jackjennings/urras")
  );
  await applyLearningToRepo(
    learning(),
    "intent text",
    makeDeps({ findLocalRepo }),
  );
  assertSpyCalls(findLocalRepo, 1);
  assertEquals(findLocalRepo.calls[0].args, [
    ["/home/user/code"],
    "jackjennings/lazyboy",
  ]);
});

Deno.test("applyLearningToRepo: creates the worktree with the full org/repo slug", async () => {
  const createWorktree = spy((
    _repoPath: string,
    _branch: string,
    _slug: string,
  ) => Promise.resolve({ path: "/tmp/wt", branch: "20260729T050000" }));
  await applyLearningToRepo(
    learning(),
    "intent text",
    makeDeps({ createWorktree }),
  );
  assertSpyCalls(createWorktree, 1);
  assertEquals(createWorktree.calls[0].args[2], "jackjennings/lazyboy");
  assertEquals(
    createWorktree.calls[0].args[1],
    `learnings-${learning().id}`,
  );
});

Deno.test("applyLearningToRepo: throws local-repo-not-found when findLocalRepo returns null", async () => {
  await assertRejects(
    () =>
      applyLearningToRepo(
        learning(),
        "intent text",
        makeDeps({ findLocalRepo: () => Promise.resolve(null) }),
      ),
    Error,
    "local-repo-not-found",
  );
});

Deno.test("applyLearningToRepo: throws worktree-creation-failed when createWorktree throws", async () => {
  await assertRejects(
    () =>
      applyLearningToRepo(
        learning(),
        "intent text",
        makeDeps({
          createWorktree: () =>
            Promise.reject(new Error("git worktree add failed")),
        }),
      ),
    Error,
    "worktree-creation-failed",
  );
});

Deno.test("applyLearningToRepo: throws apply-learning-failed when applyLearning returns null", async () => {
  const removeWorktree = spy((_wt: { path: string }) => Promise.resolve());
  await assertRejects(
    () =>
      applyLearningToRepo(
        learning(),
        "intent text",
        makeDeps({
          applyLearning: () => Promise.resolve(null),
          removeWorktree,
        }),
      ),
    Error,
    "apply-learning-failed",
  );
  assertSpyCalls(removeWorktree, 1);
});

Deno.test("applyLearningToRepo: resolves successfully even when removeWorktree cleanup fails", async () => {
  const result = await applyLearningToRepo(
    learning({ targetFile: "AGENTS.md" }),
    "intent text",
    makeDeps({
      removeWorktree: () => Promise.reject(new Error("cleanup failed")),
    }),
  );
  assertEquals(result, {
    url: "https://github.com/jackjennings/urras/pull/42",
    title: "docs: apply learning to AGENTS.md",
  });
});

Deno.test("applyLearningToRepo: throws git-commit-failed when git commit exits non-zero", async () => {
  const run = spy((cmd: string[]) => {
    if (cmd[0] === "git" && cmd[1] === "commit") {
      return Promise.resolve({ code: 1, stdout: "" });
    }
    return Promise.resolve({ code: 0, stdout: "" });
  });
  await assertRejects(
    () => applyLearningToRepo(learning(), "intent text", makeDeps({ run })),
    Error,
    "git-commit-failed",
  );
});

Deno.test("applyLearningToRepo: throws pr-create-failed when gh pr create exits non-zero", async () => {
  const run = spy((cmd: string[]) => {
    if (cmd[0] === "gh") return Promise.resolve({ code: 1, stdout: "" });
    return Promise.resolve({ code: 0, stdout: "" });
  });
  await assertRejects(
    () => applyLearningToRepo(learning(), "intent text", makeDeps({ run })),
    Error,
    "pr-create-failed",
  );
});

Deno.test("applyLearningToRepo: throws pr-create-failed when no URL is in gh output", async () => {
  const run = spy((cmd: string[]) => {
    if (cmd[0] === "gh") {
      return Promise.resolve({ code: 0, stdout: "no url here\n" });
    }
    return Promise.resolve({ code: 0, stdout: "" });
  });
  await assertRejects(
    () => applyLearningToRepo(learning(), "intent text", makeDeps({ run })),
    Error,
    "pr-create-failed",
  );
});

Deno.test("applyLearningToRepo: sets GITHUB_TOKEN/GH_TOKEN from resolveAccount on git and gh calls", async () => {
  const run = spy(
    (cmd: string[], opts: { cwd: string; env: Record<string, string> }) => {
      if (cmd[0] === "gh") {
        assertEquals(opts.env.GITHUB_TOKEN, "tok123");
        assertEquals(opts.env.GH_TOKEN, "tok123");
        return Promise.resolve({
          code: 0,
          stdout: "https://github.com/jackjennings/urras/pull/42\n",
        });
      }
      assertEquals(opts.env.GITHUB_TOKEN, "tok123");
      return Promise.resolve({ code: 0, stdout: "" });
    },
  );
  await applyLearningToRepo(
    learning(),
    "intent text",
    makeDeps({ run, resolveAccount: () => ({ token: "tok123", login: "x" }) }),
  );
  assertSpyCalls(run, 3);
});

Deno.test("applyLearningToRepo: generates a docs-prefixed title citing the target file", async () => {
  const run = spy((cmd: string[]) => {
    if (cmd[0] === "git" && cmd[1] === "commit") {
      assertEquals(cmd[3], "docs: apply learning to AGENTS.md");
    }
    if (cmd[0] === "gh") {
      const titleIndex = cmd.indexOf("--title");
      assertEquals(cmd[titleIndex + 1], "docs: apply learning to AGENTS.md");
      return Promise.resolve({
        code: 0,
        stdout: "https://github.com/jackjennings/urras/pull/42\n",
      });
    }
    return Promise.resolve({ code: 0, stdout: "" });
  });
  await applyLearningToRepo(
    learning({ targetFile: "AGENTS.md" }),
    "intent text",
    makeDeps({ run }),
  );
  assertSpyCalls(run, 3);
});

Deno.test("applyLearningToRepo: body includes the intent and an originated-from trailer", async () => {
  const run = spy((cmd: string[]) => {
    if (cmd[0] === "gh") {
      const bodyIndex = cmd.indexOf("--body");
      assertEquals(
        cmd[bodyIndex + 1],
        "intent text\n\nOriginated from github/jackjennings/lazyboy/226.",
      );
      return Promise.resolve({
        code: 0,
        stdout: "https://github.com/jackjennings/urras/pull/42\n",
      });
    }
    return Promise.resolve({ code: 0, stdout: "" });
  });
  await applyLearningToRepo(learning(), "intent text", makeDeps({ run }));
});

Deno.test("applyLearningToRepo: returns the PR URL and generated title", async () => {
  const result = await applyLearningToRepo(
    learning({ targetFile: "AGENTS.md" }),
    "intent text",
    makeDeps(),
  );
  assertEquals(result, {
    url: "https://github.com/jackjennings/urras/pull/42",
    title: "docs: apply learning to AGENTS.md",
  });
});

Deno.test("applyLearningToRepo: removes the worktree even when a later step throws", async () => {
  const removeWorktree = spy((_wt: { path: string }) => Promise.resolve());
  await assertRejects(() =>
    applyLearningToRepo(
      learning(),
      "intent text",
      makeDeps({
        removeWorktree,
        run: () => Promise.resolve({ code: 1, stdout: "" }),
      }),
    )
  );
  assertSpyCalls(removeWorktree, 1);
});
