import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { join } from "@std/path";
import { Effect, Exit } from "effect";
import { OllamaLanguageModel } from "./models/ollama.ts";
import { selfApprove } from "./self-approve.ts";
import type { CommandRunner } from "./apfel.ts";

function runnerReturning(stdout: string, code = 0): CommandRunner {
  return spy((_args: string[]) => Promise.resolve({ code, stdout }));
}

Deno.test("selfApprove: returns false when no self-approve prompt exists for phase", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const run = runnerReturning("APPROVE");
    const result = await Effect.runPromise(
      selfApprove({ phase: "spec", ticketDir: tempDir, run }),
    );
    assertEquals(result, { approved: false, reason: null });
    assertSpyCalls(run as ReturnType<typeof spy>, 0);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("selfApprove: returns false when no phase output file is found", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const run = runnerReturning("APPROVE");
    const result = await Effect.runPromise(
      selfApprove({ phase: "intake", ticketDir: tempDir, run }),
    );
    assertEquals(result, { approved: false, reason: null });
    assertSpyCalls(run as ReturnType<typeof spy>, 0);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("selfApprove: returns approved when claude CLI outputs APPROVE", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260717T120000-intake.md"),
      "## Proposed Scope\n\n```yaml\nscope:\n  - /Users/jack/code/myorg/repo\n```\n",
    );
    const run = runnerReturning("APPROVE");
    const result = await Effect.runPromise(
      selfApprove({ phase: "intake", ticketDir: tempDir, run }),
    );
    assertEquals(result, { approved: true, reason: null });
    assertSpyCalls(run as ReturnType<typeof spy>, 1);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("selfApprove: returns not approved when claude CLI outputs REJECT", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260717T120000-intake.md"),
      "bad output",
    );
    const run = runnerReturning("REJECT");
    const result = await Effect.runPromise(
      selfApprove({ phase: "intake", ticketDir: tempDir, run }),
    );
    assertEquals(result, { approved: false, reason: "REJECT" });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("selfApprove: returns failed Effect when claude CLI exits non-zero", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260717T120000-intake.md"),
      "output",
    );
    const run = runnerReturning("", 1);
    const exit = await Effect.runPromiseExit(
      selfApprove({ phase: "intake", ticketDir: tempDir, run }),
    );
    assert(Exit.isFailure(exit));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("selfApprove: returns failed Effect when run throws", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260717T120000-intake.md"),
      "output",
    );
    const run: CommandRunner = spy((_args: string[]) =>
      Promise.reject(new Error("not found"))
    );
    const exit = await Effect.runPromiseExit(
      selfApprove({ phase: "intake", ticketDir: tempDir, run }),
    );
    assert(Exit.isFailure(exit));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("selfApprove: passes output file content after -- to claude", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const outputContent =
      "## Proposed Scope\n\n```yaml\nscope:\n  - /code/repo\n```\n";
    await Deno.writeTextFile(
      join(tempDir, "20260717T120000-intake.md"),
      outputContent,
    );
    const run = runnerReturning("APPROVE");
    await Effect.runPromise(
      selfApprove({ phase: "intake", ticketDir: tempDir, run }),
    );
    const args = (run as ReturnType<typeof spy>).calls[0].args[0] as string[];
    assertEquals(args[0], "claude");
    assertEquals(args[args.length - 1], outputContent);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("selfApprove: passes --system-prompt containing APPROVE and REJECT to claude", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260717T120000-intake.md"),
      "output",
    );
    const run = runnerReturning("APPROVE");
    await Effect.runPromise(
      selfApprove({ phase: "intake", ticketDir: tempDir, run }),
    );
    const args = (run as ReturnType<typeof spy>).calls[0].args[0] as string[];
    const promptIdx = args.indexOf("--system-prompt");
    assertNotEquals(promptIdx, -1);
    assertStringIncludes(args[promptIdx + 1], "APPROVE");
    assertStringIncludes(args[promptIdx + 1], "REJECT");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("selfApprove: passes --model claude-haiku-4-5 to claude", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260717T120000-intake.md"),
      "output",
    );
    const run = runnerReturning("APPROVE");
    await Effect.runPromise(
      selfApprove({ phase: "intake", ticketDir: tempDir, run }),
    );
    const args = (run as ReturnType<typeof spy>).calls[0].args[0] as string[];
    const modelIdx = args.indexOf("--model");
    assertNotEquals(modelIdx, -1);
    assertEquals(args[modelIdx + 1], "claude-haiku-4-5");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("selfApprove: APPROVE is case-insensitive", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260717T120000-intake.md"),
      "output",
    );
    const result = await Effect.runPromise(
      selfApprove({
        phase: "intake",
        ticketDir: tempDir,
        run: runnerReturning("approve"),
      }),
    );
    assertEquals(result, { approved: true, reason: null });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("selfApprove: returns reason text when claude outputs REJECT with explanation", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260717T120000-intake.md"),
      "bad output",
    );
    const run = runnerReturning(
      "REJECT\nCriterion 2 was violated because the scope list is missing.",
    );
    const result = await Effect.runPromise(
      selfApprove({ phase: "intake", ticketDir: tempDir, run }),
    );
    assertEquals(result, {
      approved: false,
      reason:
        "REJECT\nCriterion 2 was violated because the scope list is missing.",
    });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("selfApprove: works for enrichment phase when output file exists", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260717T120000-enrichment.md"),
      "## Relevant Code\n\nFile: src/main.ts\n",
    );
    const result = await Effect.runPromise(
      selfApprove({
        phase: "enrichment",
        ticketDir: tempDir,
        run: runnerReturning("APPROVE"),
      }),
    );
    assertEquals(result, { approved: true, reason: null });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test(
  "intake-self-approve.md criterion 3 accepts GitHub slug and URL formats",
  async () => {
    const promptPath = new URL(
      "./phases/prompts/intake-self-approve.md",
      import.meta.url,
    ).pathname;
    const content = await Deno.readTextFile(promptPath);
    assertStringIncludes(content, "https://github.com/");
    assertStringIncludes(content, "org/repo");
  },
);

async function runCmd(args: string[], cwd?: string): Promise<void> {
  await new Deno.Command(args[0], {
    args: args.slice(1),
    cwd,
    stdout: "null",
    stderr: "null",
  }).output();
}

async function setupGitWorktree(): Promise<
  { worktreeDir: string; originDir: string }
> {
  const originDir = await Deno.makeTempDir();
  const worktreeDir = await Deno.makeTempDir();

  await runCmd(["git", "init", "--bare", originDir]);
  await runCmd(["git", "init", worktreeDir]);
  await runCmd(["git", "-C", worktreeDir, "config", "user.email", "t@t.com"]);
  await runCmd(["git", "-C", worktreeDir, "config", "user.name", "T"]);
  await runCmd([
    "git",
    "-C",
    worktreeDir,
    "remote",
    "add",
    "origin",
    originDir,
  ]);

  await Deno.writeTextFile(join(worktreeDir, "README.md"), "initial");
  await runCmd(["git", "-C", worktreeDir, "add", "."]);
  await runCmd(["git", "-C", worktreeDir, "commit", "-m", "initial"]);
  await runCmd(["git", "-C", worktreeDir, "push", "origin", "HEAD:main"]);
  await runCmd(["git", "-C", worktreeDir, "fetch", "origin"]);

  await Deno.writeTextFile(
    join(worktreeDir, "new-feature.ts"),
    "export const x = 1;",
  );
  await runCmd(["git", "-C", worktreeDir, "add", "."]);
  await runCmd(["git", "-C", worktreeDir, "commit", "-m", "feat: add feature"]);

  return { worktreeDir, originDir };
}

Deno.test("selfApprove: appends changed files list to content when worktreePath is provided", async () => {
  const tempDir = await Deno.makeTempDir();
  const { worktreeDir, originDir } = await setupGitWorktree();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260811T120000-implementation.md"),
      "## Changes Made\n\n- new-feature.ts\n\n## Summary of Changes\n\nAdded feature.\n\n## Tests\n\nok | 1 passed\n\n## PR\n\nhttps://github.com/example/repo/pull/1\n",
    );
    const run = runnerReturning("APPROVE");
    await Effect.runPromise(
      selfApprove({
        phase: "implementation",
        ticketDir: tempDir,
        run,
        worktreePath: worktreeDir,
      }),
    );
    const args = (run as ReturnType<typeof spy>).calls[0].args[0] as string[];
    const content = args[args.length - 1];
    assertStringIncludes(content, "## Changed Files");
    assertStringIncludes(content, "new-feature.ts");
    assert(
      !content.includes("diff --git"),
      "should not include full diff output",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
    await Deno.remove(worktreeDir, { recursive: true });
    await Deno.remove(originDir, { recursive: true });
  }
});

Deno.test("selfApprove: uses ollamaModels before Claude when provided", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260101T000000-intake.md"),
      "Some intake output",
    );
    const ollamaFetch = spy(
      (_url: unknown, _init?: RequestInit) =>
        Promise.resolve(
          new Response(JSON.stringify({ response: "APPROVE" }), {
            status: 200,
          }),
        ),
    ) as unknown as typeof fetch;
    const ollama = new OllamaLanguageModel(ollamaFetch, { model: "test" });
    let claudeCalled = false;
    const run = spy((args: string[]) => {
      if (args[0] === "claude") claudeCalled = true;
      return Promise.resolve({ code: 1, stdout: "" });
    });
    const result = await Effect.runPromise(
      selfApprove({
        phase: "intake",
        ticketDir: tempDir,
        run,
        ollamaModels: [ollama],
      }),
    );
    assert(result.approved);
    assertFalse(claudeCalled);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("selfApprove: continues without diff when worktreePath git command fails", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260717T120000-intake.md"),
      "## Proposed Scope\n\n```yaml\nscope:\n  - jackjennings/lazyboy\n```\n",
    );
    const run = runnerReturning("APPROVE");
    const result = await Effect.runPromise(
      selfApprove({
        phase: "intake",
        ticketDir: tempDir,
        run,
        worktreePath: "/nonexistent/path/that/does/not/exist",
      }),
    );
    assertEquals(result, { approved: true, reason: null });
    assertSpyCalls(run as ReturnType<typeof spy>, 1);
    const args = (run as ReturnType<typeof spy>).calls[0].args[0] as string[];
    assert(
      !args[args.length - 1].includes("## Changed Files"),
      "should not include changed files on git failure",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
