import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { Effect, Exit } from "effect";
import type { LanguageModel, LanguageModelRequest } from "./models/types.ts";
import { selfApprove } from "./self-approve.ts";

function textModel(
  response: string | null,
  onCall?: (req: LanguageModelRequest) => void,
): LanguageModel {
  return {
    name: "stub",
    generateText: (req: LanguageModelRequest) => {
      onCall?.(req);
      return Promise.resolve(response);
    },
    generateObject: () => Promise.resolve(null),
  };
}

function throwingModel(): LanguageModel {
  return {
    name: "stub",
    generateText: () => Promise.reject(new Error("model error")),
    generateObject: () => Promise.resolve(null),
  };
}

Deno.test("selfApprove: returns false when no self-approve prompt exists for phase", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const result = await Effect.runPromise(
      selfApprove({
        phase: "spec",
        ticketDir: tempDir,
        model: textModel("APPROVE"),
      }),
    );
    assertEquals(result, { approved: false, reason: null });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("selfApprove: returns false when no phase output file is found", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const result = await Effect.runPromise(
      selfApprove({
        phase: "intake",
        ticketDir: tempDir,
        model: textModel("APPROVE"),
      }),
    );
    assertEquals(result, { approved: false, reason: null });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("selfApprove: returns approved when model returns APPROVE", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260717T120000-intake.md"),
      "## Proposed Scope\n\n```yaml\nscope:\n  - /Users/jack/code/myorg/repo\n```\n",
    );
    const result = await Effect.runPromise(
      selfApprove({
        phase: "intake",
        ticketDir: tempDir,
        model: textModel("APPROVE"),
      }),
    );
    assertEquals(result, { approved: true, reason: null });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("selfApprove: returns not approved when model returns REJECT", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260717T120000-intake.md"),
      "bad output",
    );
    const result = await Effect.runPromise(
      selfApprove({
        phase: "intake",
        ticketDir: tempDir,
        model: textModel("REJECT"),
      }),
    );
    assertEquals(result, { approved: false, reason: "REJECT" });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("selfApprove: returns failed Effect when model returns null", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260717T120000-intake.md"),
      "output",
    );
    const exit = await Effect.runPromiseExit(
      selfApprove({
        phase: "intake",
        ticketDir: tempDir,
        model: textModel(null),
      }),
    );
    assert(Exit.isFailure(exit));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("selfApprove: returns failed Effect when model throws", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260717T120000-intake.md"),
      "output",
    );
    const exit = await Effect.runPromiseExit(
      selfApprove({
        phase: "intake",
        ticketDir: tempDir,
        model: throwingModel(),
      }),
    );
    assert(Exit.isFailure(exit));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("selfApprove: sends output file content as prompt to model", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const outputContent =
      "## Proposed Scope\n\n```yaml\nscope:\n  - /code/repo\n```\n";
    await Deno.writeTextFile(
      join(tempDir, "20260717T120000-intake.md"),
      outputContent,
    );
    let capturedPrompt = "";
    await Effect.runPromise(
      selfApprove({
        phase: "intake",
        ticketDir: tempDir,
        model: textModel("APPROVE", (req) => {
          capturedPrompt = req.prompt;
        }),
      }),
    );
    assertEquals(capturedPrompt, outputContent);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("selfApprove: system prompt contains APPROVE and REJECT", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260717T120000-intake.md"),
      "output",
    );
    let capturedSystemPrompt = "";
    await Effect.runPromise(
      selfApprove({
        phase: "intake",
        ticketDir: tempDir,
        model: textModel("APPROVE", (req) => {
          capturedSystemPrompt = req.systemPrompt;
        }),
      }),
    );
    assertStringIncludes(capturedSystemPrompt, "APPROVE");
    assertStringIncludes(capturedSystemPrompt, "REJECT");
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
        model: textModel("approve"),
      }),
    );
    assertEquals(result, { approved: true, reason: null });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("selfApprove: returns reason text when model outputs REJECT with explanation", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260717T120000-intake.md"),
      "bad output",
    );
    const result = await Effect.runPromise(
      selfApprove({
        phase: "intake",
        ticketDir: tempDir,
        model: textModel(
          "REJECT\nCriterion 2 was violated because the scope list is missing.",
        ),
      }),
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
        model: textModel("APPROVE"),
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
    let capturedPrompt = "";
    await Effect.runPromise(
      selfApprove({
        phase: "implementation",
        ticketDir: tempDir,
        model: textModel("APPROVE", (req) => {
          capturedPrompt = req.prompt;
        }),
        worktreePath: worktreeDir,
      }),
    );
    assertStringIncludes(capturedPrompt, "## Changed Files");
    assertStringIncludes(capturedPrompt, "new-feature.ts");
    assert(
      !capturedPrompt.includes("diff --git"),
      "should not include full diff output",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
    await Deno.remove(worktreeDir, { recursive: true });
    await Deno.remove(originDir, { recursive: true });
  }
});

Deno.test("selfApprove: continues without diff when worktreePath git command fails", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260717T120000-intake.md"),
      "## Proposed Scope\n\n```yaml\nscope:\n  - jackjennings/lazyboy\n```\n",
    );
    let capturedPrompt = "";
    const result = await Effect.runPromise(
      selfApprove({
        phase: "intake",
        ticketDir: tempDir,
        model: textModel("APPROVE", (req) => {
          capturedPrompt = req.prompt;
        }),
        worktreePath: "/nonexistent/path/that/does/not/exist",
      }),
    );
    assertEquals(result, { approved: true, reason: null });
    assert(
      !capturedPrompt.includes("## Changed Files"),
      "should not include changed files on git failure",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("selfApprove: appends global state-dir self-approve supplement to system prompt", async () => {
  const tempDir = await Deno.makeTempDir();
  const stateDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260717T120000-intake.md"),
      "output",
    );
    await Deno.mkdir(join(stateDir, "prompts"), { recursive: true });
    await Deno.writeTextFile(
      join(stateDir, "prompts", "intake-self-approve.md"),
      "Always approve tickets scoped to example/repo.",
    );
    let capturedSystemPrompt = "";
    await Effect.runPromise(
      selfApprove({
        phase: "intake",
        ticketDir: tempDir,
        model: textModel("APPROVE", (req) => {
          capturedSystemPrompt = req.systemPrompt;
        }),
        stateDir,
      }),
    );
    assertStringIncludes(
      capturedSystemPrompt,
      "Always approve tickets scoped to example/repo.",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("selfApprove: appends project-scoped self-approve supplement for matching ticket", async () => {
  const tempDir = await Deno.makeTempDir();
  const stateDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260717T120000-implementation.md"),
      "output",
    );
    const projectPromptDir = join(
      stateDir,
      "prompts",
      "github",
      "jackjennings",
      "lazyboy",
    );
    await Deno.mkdir(projectPromptDir, { recursive: true });
    await Deno.writeTextFile(
      join(projectPromptDir, "implementation-self-approve.md"),
      "Approve unconditionally for this repository.",
    );
    let capturedSystemPrompt = "";
    await Effect.runPromise(
      selfApprove({
        phase: "implementation",
        ticketDir: tempDir,
        model: textModel("APPROVE", (req) => {
          capturedSystemPrompt = req.systemPrompt;
        }),
        stateDir,
        ticketId: "github/jackjennings/lazyboy/652",
      }),
    );
    assertStringIncludes(
      capturedSystemPrompt,
      "Approve unconditionally for this repository.",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("selfApprove: does not apply another project's scoped supplement", async () => {
  const tempDir = await Deno.makeTempDir();
  const stateDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260717T120000-implementation.md"),
      "output",
    );
    const otherProjectPromptDir = join(
      stateDir,
      "prompts",
      "github",
      "someoneelse",
      "otherrepo",
    );
    await Deno.mkdir(otherProjectPromptDir, { recursive: true });
    await Deno.writeTextFile(
      join(otherProjectPromptDir, "implementation-self-approve.md"),
      "Approve unconditionally for this repository.",
    );
    let capturedSystemPrompt = "";
    await Effect.runPromise(
      selfApprove({
        phase: "implementation",
        ticketDir: tempDir,
        model: textModel("APPROVE", (req) => {
          capturedSystemPrompt = req.systemPrompt;
        }),
        stateDir,
        ticketId: "github/jackjennings/lazyboy/652",
      }),
    );
    assert(
      !capturedSystemPrompt.includes(
        "Approve unconditionally for this repository.",
      ),
      "should not include another project's supplement",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("selfApprove: prepends ticket id to content sent to model when ticketId provided", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260717T120000-intake.md"),
      "output",
    );
    let capturedPrompt = "";
    await Effect.runPromise(
      selfApprove({
        phase: "intake",
        ticketDir: tempDir,
        model: textModel("APPROVE", (req) => {
          capturedPrompt = req.prompt;
        }),
        ticketId: "github/jackjennings/lazyboy/652",
      }),
    );
    assertStringIncludes(capturedPrompt, "## Ticket");
    assertStringIncludes(capturedPrompt, "github/jackjennings/lazyboy/652");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
