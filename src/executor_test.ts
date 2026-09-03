import {
  assert,
  assertEquals,
  assertExists,
  assertFalse,
  assertNotEquals,
} from "@std/assert";
import { join } from "@std/path";
import {
  buildPhaseArgs,
  buildPhaseEnvOverrides,
  isPhaseAlive,
  isProcessAlive,
} from "./executor.ts";
import type { ExecutorOptions } from "./executor.ts";
import { bootId } from "./paths.ts";

function makeOpts(overrides: Partial<ExecutorOptions> = {}): ExecutorOptions {
  return {
    ticketDir: "/state/gh-1",
    stateDir: "/state",
    prompt: "do the thing",
    scopeDirs: [],
    outputFile: "intake.md",
    githubToken: "tok",
    anthropicApiKey: "key",
    worktrees: {},
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    thinking: "off",
    agent: "pi",
    ...overrides,
  };
}

Deno.test("buildPhaseArgs: derives --phase from outputFile stem", () => {
  const args = buildPhaseArgs(makeOpts({ outputFile: "intake.md" }));
  const idx = args.indexOf("--phase");
  assertNotEquals(idx, -1);
  assertEquals(args[idx + 1], "intake");
});

Deno.test("buildPhaseArgs: includes --ticket-dir", () => {
  const args = buildPhaseArgs(makeOpts({ ticketDir: "/state/gh-42" }));
  const idx = args.indexOf("--ticket-dir");
  assertEquals(args[idx + 1], "/state/gh-42");
});

Deno.test("buildPhaseArgs: includes --output-file", () => {
  const args = buildPhaseArgs(makeOpts({ outputFile: "spec.md" }));
  const idx = args.indexOf("--output-file");
  assertEquals(args[idx + 1], "spec.md");
});

Deno.test("buildPhaseArgs: does not include bash wrapper flags", () => {
  const args = buildPhaseArgs(makeOpts());
  assertFalse(args.includes("-c"));
  assertFalse(args.includes("bash"));
});

Deno.test("buildPhaseArgs: first two args are run --allow-all", () => {
  const args = buildPhaseArgs(makeOpts());
  assertEquals(args[0], "run");
  assertEquals(args[1], "--allow-all");
});

Deno.test("isProcessAlive returns true for current process", () => {
  assert(isProcessAlive(Deno.pid));
});

Deno.test("isProcessAlive returns false for dead PID", () => {
  assertFalse(isProcessAlive(99999999));
});

Deno.test("buildPhaseArgs: includes --model", () => {
  const args = buildPhaseArgs(makeOpts({ model: "claude-opus-4-5" }));
  const idx = args.indexOf("--model");
  assertNotEquals(idx, -1);
  assertEquals(args[idx + 1], "claude-opus-4-5");
});

Deno.test("buildPhaseArgs: includes --provider", () => {
  const args = buildPhaseArgs(makeOpts({ provider: "bedrock" }));
  const idx = args.indexOf("--provider");
  assertNotEquals(idx, -1);
  assertEquals(args[idx + 1], "bedrock");
});

Deno.test("buildPhaseArgs: includes --thinking", () => {
  const args = buildPhaseArgs(makeOpts({ thinking: "high" }));
  const idx = args.indexOf("--thinking");
  assertNotEquals(idx, -1);
  assertEquals(args[idx + 1], "high");
});

Deno.test("buildPhaseArgs: includes --thinking off", () => {
  const args = buildPhaseArgs(makeOpts({ thinking: "off" }));
  assertEquals(args[args.indexOf("--thinking") + 1], "off");
});

Deno.test("buildPhaseArgs: includes --context-files when contextFiles is provided", () => {
  const args = buildPhaseArgs(
    makeOpts({ contextFiles: ["@/ticket/meta.md", "@/ticket/context.md"] }),
  );
  const idx = args.indexOf("--context-files");
  assertNotEquals(idx, -1);
  assertEquals(args[idx + 1], "@/ticket/meta.md,@/ticket/context.md");
});

Deno.test("buildPhaseArgs: omits --context-files when contextFiles is not provided", () => {
  const args = buildPhaseArgs(makeOpts());
  assertFalse(args.includes("--context-files"));
});

Deno.test("isPhaseAlive: returns false when no run.pid exists", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    assertFalse(isPhaseAlive(tempDir));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("isPhaseAlive: returns true when run.pid contains current process PID", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "run.pid"), String(Deno.pid));
    assert(isPhaseAlive(tempDir));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("isPhaseAlive: returns false when run.pid contains a dead PID", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "run.pid"), "99999999");
    assertFalse(isPhaseAlive(tempDir));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("buildPhaseArgs: includes --agent pi by default", () => {
  const args = buildPhaseArgs(makeOpts());
  const idx = args.indexOf("--agent");
  assertNotEquals(idx, -1);
  assertEquals(args[idx + 1], "pi");
});

Deno.test("buildPhaseArgs: includes --agent claude-code when specified", () => {
  const args = buildPhaseArgs(makeOpts({ agent: "claude-code" }));
  const idx = args.indexOf("--agent");
  assertNotEquals(idx, -1);
  assertEquals(args[idx + 1], "claude-code");
});

Deno.test("buildPhaseArgs: pidFile option does not appear in args", () => {
  const args = buildPhaseArgs(makeOpts({ pidFile: "outlier-analysis.pid" }));
  assertFalse(args.includes("outlier-analysis.pid"));
  assertFalse(args.includes("--pid-file"));
});

Deno.test("buildPhaseArgs: includes --session-id when sessionId is provided", () => {
  const args = buildPhaseArgs(makeOpts({ sessionId: "sess-99" }));
  const idx = args.indexOf("--session-id");
  assertNotEquals(idx, -1);
  assertEquals(args[idx + 1], "sess-99");
});

Deno.test("buildPhaseArgs: omits --session-id when sessionId is absent", () => {
  const args = buildPhaseArgs(makeOpts());
  assertFalse(args.includes("--session-id"));
});

Deno.test("buildPhaseArgs: includes --skip-principles when includePrinciples is false", () => {
  const args = buildPhaseArgs(makeOpts({ includePrinciples: false }));
  assert(args.includes("--skip-principles"));
});

Deno.test("buildPhaseArgs: omits --skip-principles when includePrinciples is true", () => {
  const args = buildPhaseArgs(makeOpts({ includePrinciples: true }));
  assertFalse(args.includes("--skip-principles"));
});

Deno.test("buildPhaseArgs: omits --skip-principles when includePrinciples is absent", () => {
  const args = buildPhaseArgs(makeOpts());
  assertFalse(args.includes("--skip-principles"));
});

Deno.test("buildPhaseArgs: includes --state-dir", () => {
  const args = buildPhaseArgs(makeOpts({ stateDir: "/my/state" }));
  const idx = args.indexOf("--state-dir");
  assertNotEquals(idx, -1);
  assertEquals(args[idx + 1], "/my/state");
});

Deno.test("buildPhaseArgs: includes --ollama-models when ollamaModels is non-empty", () => {
  const args = buildPhaseArgs(
    makeOpts({
      ollamaModels: [
        { model: "llama3", url: "http://localhost:11434" },
        { model: "mistral" },
      ],
    }),
  );
  const idx = args.indexOf("--ollama-models");
  assertNotEquals(idx, -1);
  const parsed = JSON.parse(args[idx + 1]);
  assertEquals(parsed, [
    { model: "llama3", url: "http://localhost:11434" },
    { model: "mistral" },
  ]);
});

Deno.test("buildPhaseArgs: omits --ollama-models when ollamaModels is absent", () => {
  const args = buildPhaseArgs(makeOpts());
  assertFalse(args.includes("--ollama-models"));
});

Deno.test("buildPhaseArgs: omits --ollama-models when ollamaModels is empty", () => {
  const args = buildPhaseArgs(makeOpts({ ollamaModels: [] }));
  assertFalse(args.includes("--ollama-models"));
});

Deno.test("buildPhaseEnvOverrides: sets GITHUB_TOKEN and GH_TOKEN to githubToken", () => {
  const overrides = buildPhaseEnvOverrides(
    makeOpts({ githubToken: "tok_abc" }),
  );
  assertEquals(overrides["GITHUB_TOKEN"], "tok_abc");
  assertEquals(overrides["GH_TOKEN"], "tok_abc");
});

Deno.test("buildPhaseEnvOverrides: sets ANTHROPIC_API_KEY", () => {
  const overrides = buildPhaseEnvOverrides(
    makeOpts({ anthropicApiKey: "sk_test" }),
  );
  assertEquals(overrides["ANTHROPIC_API_KEY"], "sk_test");
});

Deno.test("buildPhaseEnvOverrides: GH_TOKEN matches GITHUB_TOKEN (no divergence)", () => {
  const overrides = buildPhaseEnvOverrides(
    makeOpts({ githubToken: "tok_xyz" }),
  );
  assertEquals(overrides["GH_TOKEN"], overrides["GITHUB_TOKEN"]);
});

Deno.test("buildPhaseEnvOverrides: sets CLAUDE_MAX_TURNS when agent is claude-code and maxTurns set", () => {
  const overrides = buildPhaseEnvOverrides(
    makeOpts({ agent: "claude-code", maxTurns: 50 }),
  );
  assertEquals(overrides["CLAUDE_MAX_TURNS"], "50");
});

Deno.test("buildPhaseEnvOverrides: sets PI_MAX_TURNS when agent is pi and maxTurns set", () => {
  const overrides = buildPhaseEnvOverrides(
    makeOpts({ agent: "pi", maxTurns: 75 }),
  );
  assertEquals(overrides["PI_MAX_TURNS"], "75");
});

Deno.test("buildPhaseEnvOverrides: does not set CLAUDE_MAX_TURNS when agent is pi", () => {
  const overrides = buildPhaseEnvOverrides(
    makeOpts({ agent: "pi", maxTurns: 50 }),
  );
  assertEquals(overrides["CLAUDE_MAX_TURNS"], undefined);
});

Deno.test("buildPhaseEnvOverrides: does not set PI_MAX_TURNS when agent is claude-code", () => {
  const overrides = buildPhaseEnvOverrides(
    makeOpts({ agent: "claude-code", maxTurns: 50 }),
  );
  assertEquals(overrides["PI_MAX_TURNS"], undefined);
});

Deno.test("buildPhaseEnvOverrides: does not set CLAUDE_MAX_TURNS when maxTurns absent", () => {
  const overrides = buildPhaseEnvOverrides(
    makeOpts({ agent: "claude-code" }),
  );
  assertEquals(overrides["CLAUDE_MAX_TURNS"], undefined);
});

Deno.test("buildPhaseEnvOverrides: does not set PI_MAX_TURNS when maxTurns absent", () => {
  const overrides = buildPhaseEnvOverrides(
    makeOpts({ agent: "pi" }),
  );
  assertEquals(overrides["PI_MAX_TURNS"], undefined);
});

Deno.test("buildPhaseEnvOverrides: PATH starts with resolved bin/ directory", () => {
  const overrides = buildPhaseEnvOverrides(makeOpts());
  const binDir = new URL("../bin", import.meta.url).pathname;
  assertExists(overrides["PATH"]);
  assert(overrides["PATH"].startsWith(`${binDir}:`));
});

Deno.test("buildPhaseArgs: includes --resume boolean flag when resume is true", () => {
  const args = buildPhaseArgs(makeOpts({ resume: true }));
  assert(args.includes("--resume"));
});

Deno.test("buildPhaseArgs: omits --resume flag when resume is absent", () => {
  const args = buildPhaseArgs(makeOpts());
  assertFalse(args.includes("--resume"));
});

Deno.test("bootId: returns a non-empty decimal string", () => {
  const id = bootId();
  assert(id.length > 0);
  assert(/^\d+$/.test(id));
});

Deno.test(
  "isPhaseAlive: returns false when run.pid boot ID does not match current boot ID",
  async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(tempDir, "run.pid"),
        `${Deno.pid}\nwrong-boot-id`,
      );
      assertFalse(isPhaseAlive(tempDir));
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "isPhaseAlive: returns true when run.pid boot ID matches current boot ID and PID is alive",
  async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(tempDir, "run.pid"),
        `${Deno.pid}\n${bootId()}`,
      );
      assert(isPhaseAlive(tempDir));
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);
