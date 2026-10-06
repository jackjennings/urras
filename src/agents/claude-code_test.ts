import {
  assert,
  assertEquals,
  assertFalse,
  assertLess,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import {
  buildClaudeCodeArgs,
  ClaudeCodeAgent,
  deriveAddDirs,
} from "./claude-code.ts";

// ── deriveAddDirs ────────────────────────────────────────────────────────────

Deno.test("deriveAddDirs: returns parent dirs of context files outside cwd", () => {
  const dirs = deriveAddDirs(
    ["@/ticket/meta.md", "@/ticket/intake.md"],
    "/worktree",
  );
  assertEquals(dirs, ["/ticket"]);
});

Deno.test("deriveAddDirs: dedupes repeated parent dirs", () => {
  const dirs = deriveAddDirs(
    ["@/ticket/meta.md", "@/ticket/intake.md", "@/other/file.md"],
    "/worktree",
  );
  assertEquals(dirs, ["/other", "/ticket"]);
});

Deno.test("deriveAddDirs: excludes files already inside cwd", () => {
  const dirs = deriveAddDirs(["@/worktree/src/foo.ts"], "/worktree");
  assertEquals(dirs, []);
});

Deno.test("deriveAddDirs: excludes a file whose path equals cwd exactly (no filename)", () => {
  const dirs = deriveAddDirs(["@/worktree"], "/worktree");
  assertEquals(dirs, []);
});

Deno.test("deriveAddDirs: returns [] for empty contextFiles", () => {
  assertEquals(deriveAddDirs([], "/worktree"), []);
});

// ── buildClaudeCodeArgs ──────────────────────────────────────────────────────

Deno.test("buildClaudeCodeArgs: prompt is the first argument", () => {
  const args = buildClaudeCodeArgs({
    prompt: "do the thing",
    model: "claude-sonnet-4-6",
    thinking: "off",
    contextFiles: [],
    cwd: "/wt",
    settingsPath: "/s.json",
  });
  assertEquals(args[0], "do the thing");
});

Deno.test("buildClaudeCodeArgs: always includes --print, --output-format stream-json, --dangerously-skip-permissions", () => {
  const args = buildClaudeCodeArgs({
    prompt: "p",
    model: "claude-sonnet-4-6",
    thinking: "off",
    contextFiles: [],
    cwd: "/wt",
    settingsPath: "/s.json",
  });
  assert(args.includes("--print"));
  const idx = args.indexOf("--output-format");
  assertNotEquals(idx, -1);
  assertEquals(args[idx + 1], "stream-json");
  assert(args.includes("--verbose"));
  assert(args.includes("--dangerously-skip-permissions"));
});

Deno.test("buildClaudeCodeArgs: scopes settings to project,local to exclude the operator's user-level hooks/skills/MCP servers", () => {
  const args = buildClaudeCodeArgs({
    prompt: "p",
    model: "m",
    thinking: "off",
    contextFiles: [],
    cwd: "/wt",
    settingsPath: "/s.json",
  });
  const idx = args.indexOf("--setting-sources");
  assertNotEquals(idx, -1);
  assertEquals(args[idx + 1], "project,local");
});

Deno.test("buildClaudeCodeArgs: includes --model with provided value", () => {
  const args = buildClaudeCodeArgs({
    prompt: "p",
    model: "claude-opus-4-8",
    thinking: "off",
    contextFiles: [],
    cwd: "/wt",
    settingsPath: "/s.json",
  });
  const idx = args.indexOf("--model");
  assertNotEquals(idx, -1);
  assertEquals(args[idx + 1], "claude-opus-4-8");
});

Deno.test("buildClaudeCodeArgs: thinking 'high' maps to --effort high", () => {
  const args = buildClaudeCodeArgs({
    prompt: "p",
    model: "m",
    thinking: "high",
    contextFiles: [],
    cwd: "/wt",
    settingsPath: "/s.json",
  });
  const idx = args.indexOf("--effort");
  assertNotEquals(idx, -1);
  assertEquals(args[idx + 1], "high");
});

Deno.test("buildClaudeCodeArgs: thinking 'xhigh' and 'max' pass through to --effort unchanged", () => {
  const xhigh = buildClaudeCodeArgs({
    prompt: "p",
    model: "m",
    thinking: "xhigh",
    contextFiles: [],
    cwd: "/wt",
    settingsPath: "/s.json",
  });
  assertEquals(xhigh[xhigh.indexOf("--effort") + 1], "xhigh");
  const max = buildClaudeCodeArgs({
    prompt: "p",
    model: "m",
    thinking: "max",
    contextFiles: [],
    cwd: "/wt",
    settingsPath: "/s.json",
  });
  assertEquals(max[max.indexOf("--effort") + 1], "max");
});

Deno.test("buildClaudeCodeArgs: thinking 'off' omits --effort", () => {
  const args = buildClaudeCodeArgs({
    prompt: "p",
    model: "m",
    thinking: "off",
    contextFiles: [],
    cwd: "/wt",
    settingsPath: "/s.json",
  });
  assertFalse(args.includes("--effort"));
});

Deno.test("buildClaudeCodeArgs: thinking 'minimal' omits --effort", () => {
  const args = buildClaudeCodeArgs({
    prompt: "p",
    model: "m",
    thinking: "minimal",
    contextFiles: [],
    cwd: "/wt",
    settingsPath: "/s.json",
  });
  assertFalse(args.includes("--effort"));
});

Deno.test("buildClaudeCodeArgs: appends a 'Read these files first' list to the prompt when contextFiles is non-empty", () => {
  const args = buildClaudeCodeArgs({
    prompt: "base prompt",
    model: "m",
    thinking: "off",
    contextFiles: ["@/ticket/meta.md", "@/ticket/intake.md"],
    cwd: "/worktree",
    settingsPath: "/s.json",
  });
  assert(args[0].startsWith("base prompt"));
  assertStringIncludes(args[0], "Read these files first:");
  assertStringIncludes(args[0], "- /ticket/meta.md");
  assertStringIncludes(args[0], "- /ticket/intake.md");
});

Deno.test("buildClaudeCodeArgs: does not append file list when contextFiles is empty", () => {
  const args = buildClaudeCodeArgs({
    prompt: "base prompt",
    model: "m",
    thinking: "off",
    contextFiles: [],
    cwd: "/wt",
    settingsPath: "/s.json",
  });
  assertEquals(args[0], "base prompt");
});

Deno.test("buildClaudeCodeArgs: --add-dir is the last flag and takes all dirs as varargs", () => {
  const args = buildClaudeCodeArgs({
    prompt: "p",
    model: "m",
    thinking: "off",
    contextFiles: ["@/ticket/meta.md", "@/other/file.md"],
    cwd: "/worktree",
    settingsPath: "/s.json",
  });
  const idx = args.indexOf("--add-dir");
  assertNotEquals(idx, -1);
  assertEquals(args.slice(idx + 1), ["/other", "/ticket"]);
});

Deno.test("buildClaudeCodeArgs: omits --add-dir entirely when there are no external dirs", () => {
  const args = buildClaudeCodeArgs({
    prompt: "p",
    model: "m",
    thinking: "off",
    contextFiles: [],
    cwd: "/wt",
    settingsPath: "/s.json",
  });
  assertFalse(args.includes("--add-dir"));
});

// ── ClaudeCodeAgent ──────────────────────────────────────────────────────────

Deno.test("ClaudeCodeAgent: implements CodeAgent's runPhase signature", () => {
  const agent = new ClaudeCodeAgent("/settings.json");
  assertEquals(typeof agent.runPhase, "function");
});

Deno.test("buildClaudeCodeArgs: includes --settings with the provided path between project,local and --model", () => {
  const args = buildClaudeCodeArgs({
    prompt: "p",
    model: "claude-sonnet-4-6",
    thinking: "off",
    contextFiles: [],
    cwd: "/wt",
    settingsPath: "/home/user/.lazyboy/claude-code/settings.json",
  });
  const settingSourcesIdx = args.indexOf("--setting-sources");
  const settingsIdx = args.indexOf("--settings");
  const modelIdx = args.indexOf("--model");
  assertNotEquals(settingsIdx, -1);
  assertEquals(
    args[settingsIdx + 1],
    "/home/user/.lazyboy/claude-code/settings.json",
  );
  assertLess(settingSourcesIdx, settingsIdx);
  assertLess(settingsIdx, modelIdx);
});

Deno.test("ClaudeCodeAgent: implements CodeAgent's runPhase signature with settingsPath constructor param", () => {
  const agent = new ClaudeCodeAgent("/some/settings.json");
  assertEquals(typeof agent.runPhase, "function");
});

Deno.test(
  "buildClaudeCodeArgs: uses --session-id when sessionId is provided and resume is absent",
  () => {
    const args = buildClaudeCodeArgs({
      prompt: "p",
      model: "m",
      thinking: "off",
      contextFiles: [],
      cwd: "/wt",
      settingsPath: "/s.json",
      sessionId: "sess-xyz",
    });
    const idx = args.indexOf("--session-id");
    assertNotEquals(idx, -1);
    assertEquals(args[idx + 1], "sess-xyz");
    assertFalse(args.includes("--resume"));
  },
);

Deno.test(
  "buildClaudeCodeArgs: uses --resume when sessionId is provided and resume is true",
  () => {
    const args = buildClaudeCodeArgs({
      prompt: "p",
      model: "m",
      thinking: "off",
      contextFiles: [],
      cwd: "/wt",
      settingsPath: "/s.json",
      sessionId: "sess-xyz",
      resume: true,
    });
    const idx = args.indexOf("--resume");
    assertNotEquals(idx, -1);
    assertEquals(args[idx + 1], "sess-xyz");
    assertFalse(args.includes("--session-id"));
  },
);

Deno.test("buildClaudeCodeArgs: omits --resume when sessionId is absent", () => {
  const args = buildClaudeCodeArgs({
    prompt: "p",
    model: "m",
    thinking: "off",
    contextFiles: [],
    cwd: "/wt",
    settingsPath: "/s.json",
  });
  assertFalse(args.includes("--resume"));
});

Deno.test(
  "buildClaudeCodeArgs: includes --mcp-config and --strict-mcp-config when mcpConfigPath is set",
  () => {
    const args = buildClaudeCodeArgs({
      prompt: "p",
      model: "m",
      thinking: "off",
      contextFiles: [],
      cwd: "/wt",
      settingsPath: "/s.json",
      mcpConfigPath: "/tmp/mcp.json",
    });
    const idx = args.indexOf("--mcp-config");
    assertNotEquals(idx, -1);
    assertEquals(args[idx + 1], "/tmp/mcp.json");
    assert(args.includes("--strict-mcp-config"));
  },
);

Deno.test(
  "buildClaudeCodeArgs: omits --mcp-config and --strict-mcp-config when mcpConfigPath is absent",
  () => {
    const args = buildClaudeCodeArgs({
      prompt: "p",
      model: "m",
      thinking: "off",
      contextFiles: [],
      cwd: "/wt",
      settingsPath: "/s.json",
    });
    assertFalse(args.includes("--mcp-config"));
    assertFalse(args.includes("--strict-mcp-config"));
  },
);

Deno.test(
  "buildClaudeCodeArgs: --mcp-config appears before --add-dir when both are present",
  () => {
    const args = buildClaudeCodeArgs({
      prompt: "p",
      model: "m",
      thinking: "off",
      contextFiles: ["@/ticket/meta.md"],
      cwd: "/worktree",
      settingsPath: "/s.json",
      mcpConfigPath: "/tmp/mcp.json",
    });
    const mcpIdx = args.indexOf("--mcp-config");
    const addDirIdx = args.indexOf("--add-dir");
    assertNotEquals(mcpIdx, -1);
    assertNotEquals(addDirIdx, -1);
    assertLess(mcpIdx, addDirIdx);
  },
);
