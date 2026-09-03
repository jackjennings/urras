import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertExists,
  assertFalse,
  assertLess,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { OllamaLanguageModel } from "./models/ollama.ts";
import { dirname, join } from "@std/path";
import {
  appendPhaseLog,
  buildContextFiles,
  dedupePrinciples,
  executePhase,
  extractClaudeCodeSessionId,
  extractClaudeCodeUsageAndText,
  extractPrinciples,
  extractSessionId,
  extractUsageAndText,
  getPiEnvironmentVariables,
  readSelfApprove,
  setupClaudeCodeDirectories,
  setupPiDirectories,
} from "./run-phase.ts";
import type { CodeAgent } from "./agents/types.ts";
import type { AnthropicPricingCache } from "./anthropic-pricing.ts";
import type { CommandRunner } from "./apfel.ts";

// ── getPiEnvironmentVariables ────────────────────────────────────────────────

Deno.test("getPiEnvironmentVariables: returns pi directory variables with expanded HOME", () => {
  const home = "/home/testuser";
  const result = getPiEnvironmentVariables(home);

  assertEquals(result.PI_CODING_AGENT_DIR, "/home/testuser/.urras/pi");
  assertEquals(
    result.PI_CODING_AGENT_SESSION_DIR,
    "/home/testuser/.urras/pi/sessions",
  );
});

Deno.test("getPiEnvironmentVariables: constructs paths correctly with different HOME values", () => {
  const home = "/Users/jack";
  const result = getPiEnvironmentVariables(home);

  assertEquals(result.PI_CODING_AGENT_DIR, "/Users/jack/.urras/pi");
  assertEquals(
    result.PI_CODING_AGENT_SESSION_DIR,
    "/Users/jack/.urras/pi/sessions",
  );
});

// ── setupPiDirectories ───────────────────────────────────────────────────────

Deno.test("setupPiDirectories: creates pi directories in temp home", async () => {
  const tempHome = await Deno.makeTempDir();

  try {
    await setupPiDirectories(tempHome);

    // Verify both directories were created
    const piDir = await Deno.stat(join(tempHome, ".urras", "pi"));
    const sessionsDir = await Deno.stat(
      join(tempHome, ".urras", "pi", "sessions"),
    );

    assert(piDir.isDirectory);
    assert(sessionsDir.isDirectory);
  } finally {
    await Deno.remove(tempHome, { recursive: true });
  }
});

Deno.test("setupPiDirectories: succeeds when directories already exist", async () => {
  const tempHome = await Deno.makeTempDir();

  try {
    // Create directories first time
    await setupPiDirectories(tempHome);

    // Call again - should not throw
    await setupPiDirectories(tempHome);

    const piDir = await Deno.stat(join(tempHome, ".urras", "pi"));
    assert(piDir.isDirectory);
  } finally {
    await Deno.remove(tempHome, { recursive: true });
  }
});

Deno.test("setupPiDirectories: symlinks turn-limit extension that is no-op when PI_MAX_TURNS absent", async () => {
  const tempHome = await Deno.makeTempDir();
  try {
    await setupPiDirectories(tempHome);
    const extensionPath = join(
      tempHome,
      ".urras",
      "pi",
      "extensions",
      "turn-limit.ts",
    );
    const info = await Deno.lstat(extensionPath);
    assert(info.isSymlink);
    const content = await Deno.readTextFile(extensionPath);
    assertStringIncludes(content, "PI_MAX_TURNS");
    assertStringIncludes(content, "ctx.abort");
  } finally {
    await Deno.remove(tempHome, { recursive: true });
  }
});

// ── setupClaudeCodeDirectories ───────────────────────────────────────────────

Deno.test("setupClaudeCodeDirectories: creates claude-code directory in temp home", async () => {
  const tempHome = await Deno.makeTempDir();
  try {
    await setupClaudeCodeDirectories(tempHome);
    const dir = await Deno.stat(join(tempHome, ".urras", "claude-code"));
    assert(dir.isDirectory);
  } finally {
    await Deno.remove(tempHome, { recursive: true });
  }
});

Deno.test("setupClaudeCodeDirectories: writes default settings.json when absent", async () => {
  const tempHome = await Deno.makeTempDir();
  try {
    await setupClaudeCodeDirectories(tempHome);
    const raw = await Deno.readTextFile(
      join(tempHome, ".urras", "claude-code", "settings.json"),
    );
    const settings = JSON.parse(raw);
    assertEquals(settings.attribution.commit, "");
    assertEquals(settings.attribution.pr, "");
  } finally {
    await Deno.remove(tempHome, { recursive: true });
  }
});

Deno.test("setupClaudeCodeDirectories: does not overwrite existing settings.json", async () => {
  const tempHome = await Deno.makeTempDir();
  try {
    const dir = join(tempHome, ".urras", "claude-code");
    await Deno.mkdir(dir, { recursive: true });
    const settingsPath = join(dir, "settings.json");
    await Deno.writeTextFile(settingsPath, '{"custom":true}');
    await setupClaudeCodeDirectories(tempHome);
    const raw = await Deno.readTextFile(settingsPath);
    assertEquals(JSON.parse(raw).custom, true);
  } finally {
    await Deno.remove(tempHome, { recursive: true });
  }
});

Deno.test("setupClaudeCodeDirectories: succeeds when directory already exists", async () => {
  const tempHome = await Deno.makeTempDir();
  try {
    await setupClaudeCodeDirectories(tempHome);
    await setupClaudeCodeDirectories(tempHome);
    const dir = await Deno.stat(join(tempHome, ".urras", "claude-code"));
    assert(dir.isDirectory);
  } finally {
    await Deno.remove(tempHome, { recursive: true });
  }
});

// ── buildContextFiles ────────────────────────────────────────────────────────

Deno.test("buildContextFiles: always includes meta.md", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "meta.md"), "---\n---\n");
    const { contextFiles: files } = await buildContextFiles({
      ticketDir: tempDir,
      stateDir: dirname(tempDir),
    });
    assertEquals(files[0], `@${tempDir}/meta.md`);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("buildContextFiles: includes prefix-timestamped phase output files", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "meta.md"), "---\n---\n");
    await Deno.writeTextFile(
      join(tempDir, "20260629T154506-intake.md"),
      "intake",
    );
    await Deno.writeTextFile(
      join(tempDir, "20260629T154506-spec.md"),
      "spec",
    );
    const { contextFiles: files } = await buildContextFiles({
      ticketDir: tempDir,
      stateDir: dirname(tempDir),
    });
    assertArrayIncludes(files, [`@${tempDir}/20260629T154506-intake.md`]);
    assertArrayIncludes(files, [`@${tempDir}/20260629T154506-spec.md`]);
    assertFalse(files.includes(`@${tempDir}/20260629T154506-enrichment.md`));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("buildContextFiles: includes prefixed output and feedback files in chronological order", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "meta.md"), "---\n---\n");
    await Deno.writeTextFile(
      join(tempDir, "20260629T154506-intake.md"),
      "output",
    );
    await Deno.writeTextFile(
      join(tempDir, "20260629T160000-intake-feedback.md"),
      "feedback",
    );
    const { contextFiles: files } = await buildContextFiles({
      ticketDir: tempDir,
      stateDir: dirname(tempDir),
    });
    const outIdx = files.indexOf(`@${tempDir}/20260629T154506-intake.md`);
    const fbIdx = files.indexOf(
      `@${tempDir}/20260629T160000-intake-feedback.md`,
    );
    assertNotEquals(outIdx, -1);
    assertNotEquals(fbIdx, -1);
    assertLess(outIdx, fbIdx);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("buildContextFiles: includes merge output and feedback files", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "meta.md"), "---\n---\n");
    await Deno.writeTextFile(
      join(tempDir, "20260819T010525-merge.md"),
      "merge",
    );
    await Deno.writeTextFile(
      join(tempDir, "20260819T011426-merge-feedback.md"),
      "feedback",
    );
    const { contextFiles: files } = await buildContextFiles({
      ticketDir: tempDir,
      stateDir: dirname(tempDir),
    });
    const outIdx = files.indexOf(`@${tempDir}/20260819T010525-merge.md`);
    const fbIdx = files.indexOf(
      `@${tempDir}/20260819T011426-merge-feedback.md`,
    );
    assertNotEquals(outIdx, -1);
    assertNotEquals(fbIdx, -1);
    assertLess(outIdx, fbIdx);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("buildContextFiles: does not include files for phases not in context list", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "meta.md"), "---\n---\n");
    await Deno.writeTextFile(
      join(tempDir, "20260629T154506-diff.md"),
      "diff",
    );
    const { contextFiles: files } = await buildContextFiles({
      ticketDir: tempDir,
      stateDir: dirname(tempDir),
    });
    assertFalse(files.includes(`@${tempDir}/20260629T154506-diff.md`));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("buildContextFiles: includes implementation output files", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "meta.md"), "---\n---\n");
    await Deno.writeTextFile(
      join(tempDir, "20260630T100000-implementation.md"),
      "output",
    );
    const { contextFiles: files } = await buildContextFiles({
      ticketDir: tempDir,
      stateDir: dirname(tempDir),
    });
    assertArrayIncludes(files, [
      `@${tempDir}/20260630T100000-implementation.md`,
    ]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("buildContextFiles: includes implementation feedback files after implementation output", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "meta.md"), "---\n---\n");
    await Deno.writeTextFile(
      join(tempDir, "20260630T100000-implementation.md"),
      "output",
    );
    await Deno.writeTextFile(
      join(tempDir, "20260630T120000-implementation-feedback.md"),
      "feedback",
    );
    const { contextFiles: files } = await buildContextFiles({
      ticketDir: tempDir,
      stateDir: dirname(tempDir),
    });
    const outIdx = files.indexOf(
      `@${tempDir}/20260630T100000-implementation.md`,
    );
    const fbIdx = files.indexOf(
      `@${tempDir}/20260630T120000-implementation-feedback.md`,
    );
    assertNotEquals(outIdx, -1);
    assertNotEquals(fbIdx, -1);
    assertLess(outIdx, fbIdx);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("buildContextFiles: implementation files appear after plan files", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "meta.md"), "---\n---\n");
    await Deno.writeTextFile(
      join(tempDir, "20260629T090000-plan.md"),
      "plan output",
    );
    await Deno.writeTextFile(
      join(tempDir, "20260630T100000-implementation.md"),
      "implementation output",
    );
    const { contextFiles: files } = await buildContextFiles({
      ticketDir: tempDir,
      stateDir: dirname(tempDir),
    });
    const planIdx = files.indexOf(`@${tempDir}/20260629T090000-plan.md`);
    const implIdx = files.indexOf(
      `@${tempDir}/20260630T100000-implementation.md`,
    );
    assertNotEquals(planIdx, -1);
    assertNotEquals(implIdx, -1);
    assertLess(planIdx, implIdx);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("buildContextFiles: prunes superseded drafts, keeping only the latest doc and feedback per phase", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "meta.md"), "---\n---\n");
    await Deno.writeTextFile(
      join(tempDir, "20260629T090000-spec.md"),
      "draft 1",
    );
    await Deno.writeTextFile(
      join(tempDir, "20260629T091000-spec-feedback.md"),
      "feedback 1",
    );
    await Deno.writeTextFile(
      join(tempDir, "20260629T092000-spec.md"),
      "draft 2",
    );
    await Deno.writeTextFile(
      join(tempDir, "20260629T093000-spec-feedback.md"),
      "feedback 2",
    );
    await Deno.writeTextFile(
      join(tempDir, "20260629T094000-spec.md"),
      "draft 3",
    );

    const { contextFiles: files } = await buildContextFiles({
      ticketDir: tempDir,
      stateDir: dirname(tempDir),
    });

    assertFalse(files.includes(`@${tempDir}/20260629T090000-spec.md`));
    assertFalse(files.includes(`@${tempDir}/20260629T091000-spec-feedback.md`));
    assertFalse(files.includes(`@${tempDir}/20260629T092000-spec.md`));
    assertFalse(files.includes(`@${tempDir}/20260629T093000-spec-feedback.md`));
    assertArrayIncludes(files, [`@${tempDir}/20260629T094000-spec.md`]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("buildContextFiles: keeps latest doc and pending feedback when a revision is awaiting rework", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "meta.md"), "---\n---\n");
    await Deno.writeTextFile(
      join(tempDir, "20260629T090000-plan.md"),
      "draft 1",
    );
    await Deno.writeTextFile(
      join(tempDir, "20260629T091000-plan-feedback.md"),
      "feedback 1",
    );
    await Deno.writeTextFile(
      join(tempDir, "20260629T092000-plan.md"),
      "draft 2",
    );
    await Deno.writeTextFile(
      join(tempDir, "20260629T093000-plan-feedback.md"),
      "feedback 2 (latest, revision pending)",
    );

    const { contextFiles: files } = await buildContextFiles({
      ticketDir: tempDir,
      stateDir: dirname(tempDir),
    });

    assertFalse(files.includes(`@${tempDir}/20260629T090000-plan.md`));
    assertFalse(files.includes(`@${tempDir}/20260629T091000-plan-feedback.md`));
    assertArrayIncludes(files, [`@${tempDir}/20260629T092000-plan.md`]);
    assertArrayIncludes(files, [
      `@${tempDir}/20260629T093000-plan-feedback.md`,
    ]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("buildContextFiles: prepends principles.md when it exists in stateDir", async () => {
  const stateDir = await Deno.makeTempDir();
  const ticketDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
    await Deno.writeTextFile(join(stateDir, "principles.md"), "- learn A");
    const { contextFiles: files } = await buildContextFiles({
      ticketDir,
      stateDir,
    });
    assertEquals(files[0], `@${stateDir}/principles.md`);
    assertEquals(files[1], `@${ticketDir}/meta.md`);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(ticketDir, { recursive: true });
  }
});

Deno.test("buildContextFiles: omits principles.md when includePrinciples is false", async () => {
  const stateDir = await Deno.makeTempDir();
  const ticketDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
    await Deno.writeTextFile(join(stateDir, "principles.md"), "- learn A");
    const { contextFiles: files } = await buildContextFiles({
      ticketDir,
      stateDir,
      includePrinciples: false,
    });
    assertEquals(files[0], `@${ticketDir}/meta.md`);
    assertFalse(files.some((f) => f.includes("principles.md")));
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(ticketDir, { recursive: true });
  }
});

Deno.test("buildContextFiles: omits principles.md when it does not exist in stateDir", async () => {
  const stateDir = await Deno.makeTempDir();
  const ticketDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
    const { contextFiles: files } = await buildContextFiles({
      ticketDir,
      stateDir,
    });
    assertEquals(files[0], `@${ticketDir}/meta.md`);
    assertFalse(files.some((f) => f.includes("principles.md")));
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(ticketDir, { recursive: true });
  }
});

Deno.test("buildContextFiles: injects local principles for github ticket when file exists", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const ticketDir = join(stateDir, "github", "acme", "repo", "42");
    await Deno.mkdir(ticketDir, { recursive: true });
    await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
    await Deno.mkdir(join(stateDir, "principles", "github", "acme"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(stateDir, "principles", "github", "acme", "repo.md"),
      "- local principle",
    );
    const { contextFiles: files } = await buildContextFiles({
      ticketDir,
      stateDir,
    });
    assertArrayIncludes(files, [
      `@${stateDir}/principles/github/acme/repo.md`,
    ]);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("buildContextFiles: injects global then local principles when both exist", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const ticketDir = join(stateDir, "github", "acme", "repo", "42");
    await Deno.mkdir(ticketDir, { recursive: true });
    await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
    await Deno.writeTextFile(join(stateDir, "principles.md"), "- global");
    await Deno.mkdir(join(stateDir, "principles", "github", "acme"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(stateDir, "principles", "github", "acme", "repo.md"),
      "- local",
    );
    const { contextFiles: files } = await buildContextFiles({
      ticketDir,
      stateDir,
    });
    const globalIdx = files.indexOf(`@${stateDir}/principles.md`);
    const localIdx = files.indexOf(
      `@${stateDir}/principles/github/acme/repo.md`,
    );
    assertNotEquals(globalIdx, -1);
    assertNotEquals(localIdx, -1);
    assertLess(globalIdx, localIdx);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("buildContextFiles: does not inject local principles when file is absent", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const ticketDir = join(stateDir, "github", "acme", "repo", "42");
    await Deno.mkdir(ticketDir, { recursive: true });
    await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
    const { contextFiles: files } = await buildContextFiles({
      ticketDir,
      stateDir,
    });
    assertFalse(files.some((f) => f.includes("principles/github")));
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("buildContextFiles: injects local principles for jira ticket when file exists", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const ticketDir = join(stateDir, "jira", "PROJ-123");
    await Deno.mkdir(ticketDir, { recursive: true });
    await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
    await Deno.mkdir(join(stateDir, "principles", "jira"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(stateDir, "principles", "jira", "PROJ.md"),
      "- jira principle",
    );
    const { contextFiles: files } = await buildContextFiles({
      ticketDir,
      stateDir,
    });
    assertArrayIncludes(files, [
      `@${stateDir}/principles/jira/PROJ.md`,
    ]);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("buildContextFiles: omits local principles when includePrinciples is false", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const ticketDir = join(stateDir, "github", "acme", "repo", "42");
    await Deno.mkdir(ticketDir, { recursive: true });
    await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
    await Deno.mkdir(join(stateDir, "principles", "github", "acme"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(stateDir, "principles", "github", "acme", "repo.md"),
      "- local principle",
    );
    const { contextFiles: files } = await buildContextFiles({
      ticketDir,
      stateDir,
      includePrinciples: false,
    });
    assertFalse(files.some((f) => f.includes("principles")));
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test(
  "buildContextFiles: includes full global corpus unchanged when corpus has <= 20 entries",
  async () => {
    const stateDir = await Deno.makeTempDir();
    const ticketDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
      const entries = Array.from({ length: 20 }, (_, i) => `- p${i}`).join(
        "\n",
      );
      await Deno.writeTextFile(join(stateDir, "principles.md"), entries);
      const run: CommandRunner = spy(() =>
        Promise.resolve({ code: 0, stdout: JSON.stringify({ indices: [0] }) })
      );
      const { contextFiles, tempPrinciplesFile } = await buildContextFiles({
        ticketDir,
        stateDir,
        run,
      });
      assertEquals(contextFiles[0], `@${stateDir}/principles.md`);
      assertEquals(tempPrinciplesFile, undefined);
      assertSpyCalls(run as ReturnType<typeof spy>, 0);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
      await Deno.remove(ticketDir, { recursive: true });
    }
  },
);

Deno.test(
  "buildContextFiles: returns temp file path instead of global principles path when corpus has > 20 entries",
  async () => {
    const stateDir = await Deno.makeTempDir();
    let tempPrinciplesFile: string | undefined;
    try {
      const ticketDir = join(stateDir, "github", "acme", "repo", "1");
      await Deno.mkdir(ticketDir, { recursive: true });
      await Deno.writeTextFile(
        join(ticketDir, "meta.md"),
        "---\ntitle: My Task\n---\n## Problem\nA problem.",
      );
      const entries = Array.from({ length: 21 }, (_, i) => `- p${i}`).join(
        "\n",
      );
      await Deno.writeTextFile(join(stateDir, "principles.md"), entries);
      const run: CommandRunner = spy(() =>
        Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ indices: [0, 2] }),
        })
      );
      ({ tempPrinciplesFile } = await buildContextFiles({
        ticketDir,
        stateDir,
        run,
      }));
      const { contextFiles } = await buildContextFiles({
        ticketDir,
        stateDir,
        run: () =>
          Promise.resolve({
            code: 0,
            stdout: JSON.stringify({ indices: [0, 2] }),
          }),
      });
      assertNotEquals(tempPrinciplesFile, undefined);
      assertFalse(contextFiles.includes(`@${stateDir}/principles.md`));
    } finally {
      await Deno.remove(stateDir, { recursive: true });
      if (tempPrinciplesFile) {
        await Deno.remove(tempPrinciplesFile).catch(() => {});
      }
    }
  },
);

Deno.test(
  "buildContextFiles: temp file contains only the selected principle entries in original order",
  async () => {
    const stateDir = await Deno.makeTempDir();
    let tempPrinciplesFile: string | undefined;
    try {
      const ticketDir = join(stateDir, "github", "acme", "repo", "1");
      await Deno.mkdir(ticketDir, { recursive: true });
      await Deno.writeTextFile(
        join(ticketDir, "meta.md"),
        "---\ntitle: T\n---\n## Problem\nP.",
      );
      const principles = Array.from(
        { length: 21 },
        (_, i) => `- entry ${i}`,
      );
      await Deno.writeTextFile(
        join(stateDir, "principles.md"),
        principles.join("\n"),
      );
      const run: CommandRunner = () =>
        Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ indices: [5, 1] }),
        });
      ({ tempPrinciplesFile } = await buildContextFiles({
        ticketDir,
        stateDir,
        run,
      }));
      const content = await Deno.readTextFile(tempPrinciplesFile!);
      assertStringIncludes(content, "- entry 1");
      assertStringIncludes(content, "- entry 5");
      assert(content.indexOf("- entry 1") < content.indexOf("- entry 5"));
    } finally {
      await Deno.remove(stateDir, { recursive: true });
      if (tempPrinciplesFile) {
        await Deno.remove(tempPrinciplesFile).catch(() => {});
      }
    }
  },
);

Deno.test(
  "buildContextFiles: falls back to full corpus when no run is provided, even when corpus exceeds threshold",
  async () => {
    const stateDir = await Deno.makeTempDir();
    const ticketDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
      const entries = Array.from({ length: 21 }, (_, i) => `- p${i}`).join(
        "\n",
      );
      await Deno.writeTextFile(join(stateDir, "principles.md"), entries);
      const { contextFiles, tempPrinciplesFile } = await buildContextFiles({
        ticketDir,
        stateDir,
      });
      assertEquals(contextFiles[0], `@${stateDir}/principles.md`);
      assertEquals(tempPrinciplesFile, undefined);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
      await Deno.remove(ticketDir, { recursive: true });
    }
  },
);

Deno.test(
  "buildContextFiles: falls back to full corpus and logs principles-filter-failed when filterPrinciples returns null",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const ticketDir = join(stateDir, "github", "acme", "repo", "1");
      await Deno.mkdir(ticketDir, { recursive: true });
      await Deno.writeTextFile(
        join(ticketDir, "meta.md"),
        "---\ntitle: T\n---\n## Problem\nP.",
      );
      const entries = Array.from({ length: 21 }, (_, i) => `- p${i}`).join(
        "\n",
      );
      await Deno.writeTextFile(join(stateDir, "principles.md"), entries);
      const run: CommandRunner = () => Promise.resolve({ code: 1, stdout: "" });
      const { contextFiles, tempPrinciplesFile } = await buildContextFiles({
        ticketDir,
        stateDir,
        run,
      });
      assertEquals(contextFiles[0], `@${stateDir}/principles.md`);
      assertEquals(tempPrinciplesFile, undefined);
      const log = await Deno.readTextFile(join(ticketDir, "log.ndjson"));
      const logEntries = log.trim().split("\n").map((l) => JSON.parse(l));
      const failed = logEntries.find((e) =>
        e.event === "principles-filter-failed"
      );
      assertExists(failed);
      assertEquals(typeof failed.reason, "string");
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "buildContextFiles: falls back to full corpus and logs principles-filter-failed when meta.md is unreadable",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const ticketDir = join(stateDir, "github", "acme", "repo", "1");
      await Deno.mkdir(ticketDir, { recursive: true });
      const entries = Array.from({ length: 21 }, (_, i) => `- p${i}`).join(
        "\n",
      );
      await Deno.writeTextFile(join(stateDir, "principles.md"), entries);
      const run: CommandRunner = () =>
        Promise.resolve({ code: 0, stdout: JSON.stringify({ indices: [0] }) });
      const { contextFiles } = await buildContextFiles({
        ticketDir,
        stateDir,
        run,
      });
      assertEquals(contextFiles[0], `@${stateDir}/principles.md`);
      const log = await Deno.readTextFile(join(ticketDir, "log.ndjson"));
      const logEntries = log.trim().split("\n").map((l) => JSON.parse(l));
      assertExists(
        logEntries.find((e) => e.event === "principles-filter-failed"),
      );
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "buildContextFiles: logs principles-filtered with correct total and included counts",
  async () => {
    const stateDir = await Deno.makeTempDir();
    let tempPrinciplesFile: string | undefined;
    try {
      const ticketDir = join(stateDir, "github", "acme", "repo", "1");
      await Deno.mkdir(ticketDir, { recursive: true });
      await Deno.writeTextFile(
        join(ticketDir, "meta.md"),
        "---\ntitle: T\n---\n## Problem\nP.",
      );
      const entries = Array.from({ length: 21 }, (_, i) => `- p${i}`).join(
        "\n",
      );
      await Deno.writeTextFile(join(stateDir, "principles.md"), entries);
      const run: CommandRunner = () =>
        Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ indices: [0, 3] }),
        });
      ({ tempPrinciplesFile } = await buildContextFiles({
        ticketDir,
        stateDir,
        run,
      }));
      const log = await Deno.readTextFile(join(ticketDir, "log.ndjson"));
      const logEntries = log.trim().split("\n").map((l) => JSON.parse(l));
      const filtered = logEntries.find((e) =>
        e.event === "principles-filtered"
      );
      assertExists(filtered);
      assertEquals(filtered.total, 21);
      assertEquals(filtered.included, 2);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
      if (tempPrinciplesFile) {
        await Deno.remove(tempPrinciplesFile).catch(() => {});
      }
    }
  },
);

Deno.test(
  "buildContextFiles: writes empty temp file when filter returns no relevant entries",
  async () => {
    const stateDir = await Deno.makeTempDir();
    let tempPrinciplesFile: string | undefined;
    try {
      const ticketDir = join(stateDir, "github", "acme", "repo", "1");
      await Deno.mkdir(ticketDir, { recursive: true });
      await Deno.writeTextFile(
        join(ticketDir, "meta.md"),
        "---\ntitle: T\n---\n## Problem\nP.",
      );
      const entries = Array.from({ length: 21 }, (_, i) => `- p${i}`).join(
        "\n",
      );
      await Deno.writeTextFile(join(stateDir, "principles.md"), entries);
      const run: CommandRunner = () =>
        Promise.resolve({ code: 0, stdout: JSON.stringify({ indices: [] }) });
      ({ tempPrinciplesFile } = await buildContextFiles({
        ticketDir,
        stateDir,
        run,
      }));
      assertExists(tempPrinciplesFile);
      const content = await Deno.readTextFile(tempPrinciplesFile!);
      assertEquals(content, "");
      const log = await Deno.readTextFile(join(ticketDir, "log.ndjson"));
      const logEntries = log.trim().split("\n").map((l) => JSON.parse(l));
      const filtered = logEntries.find((e) =>
        e.event === "principles-filtered"
      );
      assertEquals(filtered?.included, 0);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
      if (tempPrinciplesFile) {
        await Deno.remove(tempPrinciplesFile).catch(() => {});
      }
    }
  },
);

Deno.test(
  "buildContextFiles: uses ticket title and ## Problem section as filter context",
  async () => {
    const stateDir = await Deno.makeTempDir();
    let tempPrinciplesFile: string | undefined;
    let capturedPrompt = "";
    try {
      const ticketDir = join(stateDir, "github", "acme", "repo", "1");
      await Deno.mkdir(ticketDir, { recursive: true });
      await Deno.writeTextFile(
        join(ticketDir, "meta.md"),
        "---\ntitle: Improve caching\n---\n## Problem\nCache misses are too frequent.\n\n## Other\nIgnore this.",
      );
      const entries = Array.from({ length: 21 }, (_, i) => `- p${i}`).join(
        "\n",
      );
      await Deno.writeTextFile(join(stateDir, "principles.md"), entries);
      const run: CommandRunner = (args) => {
        capturedPrompt = args[args.length - 1];
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ indices: [] }),
        });
      };
      ({ tempPrinciplesFile } = await buildContextFiles({
        ticketDir,
        stateDir,
        run,
      }));
      assertStringIncludes(capturedPrompt, "Improve caching");
      assertStringIncludes(capturedPrompt, "Cache misses are too frequent.");
      assertFalse(capturedPrompt.includes("Ignore this."));
    } finally {
      await Deno.remove(stateDir, { recursive: true });
      if (tempPrinciplesFile) {
        await Deno.remove(tempPrinciplesFile).catch(() => {});
      }
    }
  },
);

Deno.test(
  "buildContextFiles: falls back to full body when meta.md has no ## Problem section",
  async () => {
    const stateDir = await Deno.makeTempDir();
    let tempPrinciplesFile: string | undefined;
    let capturedPrompt = "";
    try {
      const ticketDir = join(stateDir, "github", "acme", "repo", "1");
      await Deno.mkdir(ticketDir, { recursive: true });
      await Deno.writeTextFile(
        join(ticketDir, "meta.md"),
        "---\ntitle: Fix bug\n---\nAll the context lives here.",
      );
      const entries = Array.from({ length: 21 }, (_, i) => `- p${i}`).join(
        "\n",
      );
      await Deno.writeTextFile(join(stateDir, "principles.md"), entries);
      const run: CommandRunner = (args) => {
        capturedPrompt = args[args.length - 1];
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ indices: [] }),
        });
      };
      ({ tempPrinciplesFile } = await buildContextFiles({
        ticketDir,
        stateDir,
        run,
      }));
      assertStringIncludes(capturedPrompt, "All the context lives here.");
    } finally {
      await Deno.remove(stateDir, { recursive: true });
      if (tempPrinciplesFile) {
        await Deno.remove(tempPrinciplesFile).catch(() => {});
      }
    }
  },
);

// ── extractPrinciples ────────────────────────────────────────────────────────

Deno.test("extractPrinciples: returns body of ## Principles section", () => {
  const output =
    `## What to Build\n\nsome content\n\n## Principles\n\n- learn A\n- learn B\n\n## Next Steps\n\nmore stuff`;
  assertEquals(extractPrinciples(output), "- learn A\n- learn B");
});

Deno.test("extractPrinciples: returns null when section is absent", () => {
  const output = `## What to Build\n\nsome content`;
  assertEquals(extractPrinciples(output), null);
});

Deno.test("extractPrinciples: returns null when section is empty", () => {
  const output = `## What to Build\n\nsome\n\n## Principles\n\n## Next Steps`;
  assertEquals(extractPrinciples(output), null);
});

Deno.test("extractPrinciples: captures content to end of string when no following heading", () => {
  const output = `## Principles\n\n- only learning`;
  assertEquals(extractPrinciples(output), "- only learning");
});

Deno.test("extractPrinciples: trims surrounding whitespace", () => {
  const output = `## Principles\n\n\n  trimmed  \n\n`;
  assertEquals(extractPrinciples(output), "trimmed");
});

// ── dedupePrinciples ─────────────────────────────────────────────────────────

Deno.test("dedupePrinciples: appends a genuinely new bullet", () => {
  const existing = "- learn A";
  const extracted = "- learn B";
  assertEquals(dedupePrinciples(existing, extracted), "- learn B");
});

Deno.test("dedupePrinciples: is a no-op when the bullet is already present", () => {
  const existing = "- learn A\n\n- learn B";
  assertEquals(dedupePrinciples(existing, "- learn B"), null);
});

Deno.test("dedupePrinciples: keeps only the novel bullets from a mixed block", () => {
  const existing = "- learn A";
  const extracted = "- learn A\n- learn B";
  assertEquals(dedupePrinciples(existing, extracted), "- learn B");
});

Deno.test("dedupePrinciples: normalizes whitespace when comparing", () => {
  const existing = "- learn A with   spaces";
  const extracted = "- learn A with spaces";
  assertEquals(dedupePrinciples(existing, extracted), null);
});

Deno.test("dedupePrinciples: matches a multi-line bullet against its wrapped duplicate", () => {
  const existing = "- a long principle that\n  wraps across two lines";
  const extracted = "- a long principle that wraps across two lines";
  assertEquals(dedupePrinciples(existing, extracted), null);
});

Deno.test("dedupePrinciples: dedupes within the extracted block itself", () => {
  assertEquals(dedupePrinciples("", "- learn A\n- learn A"), "- learn A");
});

Deno.test("dedupePrinciples: returns the block unchanged when existing is empty", () => {
  const extracted = "- learn A\n- learn B";
  assertEquals(dedupePrinciples("", extracted), extracted);
});

// ── appendPhaseLog ───────────────────────────────────────────────────────────

Deno.test("appendPhaseLog: creates log.ndjson and writes a valid JSON line", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await appendPhaseLog(tempDir, { event: "phase-start", phase: "intake" });

    const content = await Deno.readTextFile(`${tempDir}/log.ndjson`);
    const lines = content.trim().split("\n");
    assertEquals(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assertEquals(entry.event, "phase-start");
    assertEquals(entry.phase, "intake");
    assertEquals(typeof entry.ts, "string");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("appendPhaseLog: appends to existing log.ndjson", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await appendPhaseLog(tempDir, { event: "phase-start", phase: "spec" });
    await appendPhaseLog(tempDir, {
      event: "phase-end",
      phase: "spec",
      exitCode: 0,
      output: "",
    });

    const content = await Deno.readTextFile(`${tempDir}/log.ndjson`);
    const lines = content.trim().split("\n");
    assertEquals(lines.length, 2);
    assertEquals(JSON.parse(lines[0]).event, "phase-start");
    assertEquals(JSON.parse(lines[1]).event, "phase-end");
    assertEquals(JSON.parse(lines[1]).exitCode, 0);
    assertEquals(JSON.parse(lines[1]).output, "");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("appendPhaseLog: propagates error when directory does not exist", async () => {
  await assertRejects(() =>
    appendPhaseLog("/nonexistent/ticket/dir", {
      event: "phase-start",
      phase: "intake",
    })
  );
});

// ── executePhase ─────────────────────────────────────────────────────────────

Deno.test("executePhase: forwards buildContextFiles result to agent.runPhase", async () => {
  const ticketDir = await Deno.makeTempDir();
  const homeDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
    await Deno.writeTextFile(
      join(ticketDir, "20260101T000000-intake.md"),
      "intake",
    );

    let capturedContextFiles: string[] = [];
    const agent: CodeAgent = {
      runPhase(opts) {
        capturedContextFiles = opts.contextFiles;
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      },
    };

    await executePhase(
      {
        ticketDir,
        stateDir: dirname(ticketDir),
        outputFile: "out.md",
        phase: "intake",
        scopeDirs: [],
        prompt: "do the thing",
        worktrees: {},
        homeDir,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        thinking: "off",
        agentType: "pi",
      },
      agent,
    );

    assertArrayIncludes(capturedContextFiles, [`@${ticketDir}/meta.md`]);
    assertArrayIncludes(capturedContextFiles, [
      `@${ticketDir}/20260101T000000-intake.md`,
    ]);
  } finally {
    await Deno.remove(ticketDir, { recursive: true });
    await Deno.remove(homeDir, { recursive: true });
  }
});

Deno.test("executePhase: prompt includes base prompt, ticketDir, scopeDirs, and worktree paths", async () => {
  const ticketDir = await Deno.makeTempDir();
  const homeDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");

    let capturedPrompt = "";
    const agent: CodeAgent = {
      runPhase(opts) {
        capturedPrompt = opts.prompt;
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      },
    };

    await executePhase(
      {
        ticketDir,
        stateDir: dirname(ticketDir),
        outputFile: "out.md",
        phase: "intake",
        scopeDirs: ["/some/scope"],
        prompt: "base prompt",
        worktrees: { repo: { path: "/some/worktree", branch: "main" } },
        homeDir,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        thinking: "off",
        agentType: "pi",
      },
      agent,
    );

    assert(capturedPrompt.startsWith("base prompt"));
    assertStringIncludes(capturedPrompt, ticketDir);
    assertStringIncludes(capturedPrompt, "/some/scope");
    assertStringIncludes(capturedPrompt, "/some/worktree");
  } finally {
    await Deno.remove(ticketDir, { recursive: true });
    await Deno.remove(homeDir, { recursive: true });
  }
});

Deno.test("executePhase: passes provider, model, and thinking to agent.runPhase", async () => {
  const ticketDir = await Deno.makeTempDir();
  const homeDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");

    let capturedProvider = "";
    let capturedModel = "";
    let capturedThinking = "";
    const agent: CodeAgent = {
      runPhase(opts) {
        capturedProvider = opts.provider;
        capturedModel = opts.model;
        capturedThinking = opts.thinking;
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      },
    };

    await executePhase(
      {
        ticketDir,
        stateDir: dirname(ticketDir),
        outputFile: "out.md",
        phase: "intake",
        scopeDirs: [],
        prompt: "prompt",
        worktrees: {},
        homeDir,
        provider: "anthropic",
        model: "claude-haiku-4-5",
        thinking: "minimal",
        agentType: "pi",
      },
      agent,
    );

    assertEquals(capturedProvider, "anthropic");
    assertEquals(capturedModel, "claude-haiku-4-5");
    assertEquals(capturedThinking, "minimal");
  } finally {
    await Deno.remove(ticketDir, { recursive: true });
    await Deno.remove(homeDir, { recursive: true });
  }
});

Deno.test("executePhase: forwards a non-default provider (bedrock) to agent.runPhase", async () => {
  const ticketDir = await Deno.makeTempDir();
  const homeDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");

    let capturedProvider = "";
    const agent: CodeAgent = {
      runPhase(opts) {
        capturedProvider = opts.provider;
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      },
    };

    await executePhase(
      {
        ticketDir,
        stateDir: dirname(ticketDir),
        outputFile: "out.md",
        phase: "intake",
        scopeDirs: [],
        prompt: "prompt",
        worktrees: {},
        homeDir,
        provider: "bedrock",
        model: "anthropic.claude-opus-4-8",
        thinking: "off",
        agentType: "pi",
      },
      agent,
    );

    assertEquals(capturedProvider, "bedrock");
  } finally {
    await Deno.remove(ticketDir, { recursive: true });
    await Deno.remove(homeDir, { recursive: true });
  }
});

Deno.test(
  "executePhase: includes output file path in prompt context",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
      let capturedPrompt = "";
      const agent: CodeAgent = {
        runPhase(opts) {
          capturedPrompt = opts.prompt;
          return Promise.resolve({ stdout: "", stderr: "", code: 0 });
        },
      };
      await executePhase(
        {
          ticketDir,
          stateDir: dirname(ticketDir),
          outputFile: "20260727T000000-spec.md",
          phase: "spec",
          scopeDirs: [],
          prompt: "prompt",
          worktrees: {},
          homeDir,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          thinking: "off",
          agentType: "pi",
        },
        agent,
      );
      assertStringIncludes(
        capturedPrompt,
        join(ticketDir, "20260727T000000-spec.md"),
      );
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

Deno.test(
  "executePhase: deletes pre-existing output file before launching agent",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
      await Deno.writeTextFile(join(ticketDir, "result.md"), "stale content");
      const agent: CodeAgent = {
        runPhase() {
          return Promise.resolve({ stdout: "", stderr: "", code: 0 });
        },
      };
      await executePhase(
        {
          ticketDir,
          stateDir: dirname(ticketDir),
          outputFile: "result.md",
          phase: "spec",
          scopeDirs: [],
          prompt: "prompt",
          worktrees: {},
          homeDir,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          thinking: "off",
          agentType: "pi",
        },
        agent,
      );
      await assertRejects(
        () => Deno.readTextFile(join(ticketDir, "result.md")),
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

Deno.test(
  "executePhase: reads output file from disk; does not overwrite agent-written content",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
      const outputPath = join(ticketDir, "result.md");
      const agent: CodeAgent = {
        async runPhase() {
          await Deno.writeTextFile(outputPath, "## Section\n\nAgent content.");
          return Promise.resolve({ stdout: "", stderr: "", code: 7 });
        },
      };
      const exitCode = await executePhase(
        {
          ticketDir,
          stateDir: dirname(ticketDir),
          outputFile: "result.md",
          phase: "spec",
          scopeDirs: [],
          prompt: "prompt",
          worktrees: {},
          homeDir,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          thinking: "off",
          agentType: "pi",
        },
        agent,
      );
      assertEquals(exitCode, 7);
      const content = await Deno.readTextFile(outputPath);
      assertEquals(content, "## Section\n\nAgent content.");
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

Deno.test(
  "executePhase: still writes usage sidecar and logs phase-end when agent writes output file",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
      const outputPath = join(ticketDir, "result.md");
      const agentEndNdjson = JSON.stringify({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "agent output" }],
            usage: {
              input: 5,
              output: 3,
              cacheRead: 10,
              cacheWrite: 2,
              totalTokens: 20,
              cacheWrite1h: 0,
              reasoning: 0,
              cost: {},
            },
          },
        ],
      });
      const agent: CodeAgent = {
        async runPhase() {
          await Deno.writeTextFile(
            outputPath,
            "## Output\n\nWritten by agent.",
          );
          return Promise.resolve({
            stdout: agentEndNdjson,
            stderr: "agent errors",
            code: 42,
          });
        },
      };
      const exitCode = await executePhase(
        {
          ticketDir,
          stateDir: dirname(ticketDir),
          outputFile: "result.md",
          phase: "spec",
          scopeDirs: [],
          prompt: "prompt",
          worktrees: {},
          homeDir,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          thinking: "off",
          agentType: "pi",
        },
        agent,
      );
      assertEquals(exitCode, 42);
      const usageRaw = await Deno.readTextFile(
        join(ticketDir, "result.usage.json"),
      );
      const usage = JSON.parse(usageRaw);
      assertEquals(usage.models[0].input, 5);
      assertEquals(usage.models[0].output, 3);
      assertEquals(usage.models[0].model, "claude-sonnet-4-6");
      const logContent = await Deno.readTextFile(join(ticketDir, "log.ndjson"));
      const logLines = logContent.trim().split("\n");
      const endEntry = JSON.parse(logLines[logLines.length - 1]);
      assertEquals(endEntry.event, "phase-end");
      assertEquals(endEntry.exitCode, 42);
      assertEquals(endEntry.output, "agent errors");
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

Deno.test("executePhase: writes .exit sidecar with exit code before returning", async () => {
  const ticketDir = await Deno.makeTempDir();
  const homeDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
    const outputFile = "20260101T120000-intake.md";
    const agent: CodeAgent = {
      runPhase: () => Promise.resolve({ stdout: "", stderr: "", code: 2 }),
    };
    await executePhase(
      {
        ticketDir,
        stateDir: ticketDir,
        outputFile,
        phase: "intake",
        scopeDirs: [],
        prompt: "p",
        worktrees: {},
        homeDir,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        thinking: "off",
        agentType: "pi",
      },
      agent,
    );
    const sidecar = await Deno.readTextFile(
      join(ticketDir, outputFile + ".exit"),
    );
    assertEquals(sidecar, "2");
  } finally {
    await Deno.remove(ticketDir, { recursive: true });
    await Deno.remove(homeDir, { recursive: true });
  }
});

Deno.test("executePhase: .exit sidecar write failure does not suppress returned exit code", async () => {
  const ticketDir = await Deno.makeTempDir();
  const homeDir = await Deno.makeTempDir();
  const outputFile = "20260101T120000-intake.md";
  const sidecarPath = join(ticketDir, outputFile + ".exit");
  try {
    await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
    // pre-create the sidecar as read-only so the write inside executePhase fails
    await Deno.writeTextFile(sidecarPath, "old");
    await Deno.chmod(sidecarPath, 0o444);
    const agent: CodeAgent = {
      runPhase: () => Promise.resolve({ stdout: "", stderr: "", code: 1 }),
    };
    const returnedCode = await executePhase(
      {
        ticketDir,
        stateDir: ticketDir,
        outputFile,
        phase: "intake",
        scopeDirs: [],
        prompt: "p",
        worktrees: {},
        homeDir,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        thinking: "off",
        agentType: "pi",
      },
      agent,
    );
    assertEquals(returnedCode, 1);
  } finally {
    await Deno.chmod(sidecarPath, 0o644).catch(() => {});
    await Deno.remove(ticketDir, { recursive: true });
    await Deno.remove(homeDir, { recursive: true });
  }
});

Deno.test("executePhase: writes .session sidecar with session ID when present", async () => {
  const ticketDir = await Deno.makeTempDir();
  const homeDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
    const outputFile = "20260101T120000-intake.md";
    const sessionLine = JSON.stringify({
      type: "session",
      version: 3,
      id: "sess-abc",
    });
    const agent: CodeAgent = {
      runPhase: () =>
        Promise.resolve({ stdout: sessionLine, stderr: "", code: 0 }),
    };
    await executePhase(
      {
        ticketDir,
        stateDir: ticketDir,
        outputFile,
        phase: "intake",
        scopeDirs: [],
        prompt: "p",
        worktrees: {},
        homeDir,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        thinking: "off",
        agentType: "pi",
      },
      agent,
    );
    const sidecar = await Deno.readTextFile(
      join(ticketDir, outputFile + ".session"),
    );
    assertEquals(sidecar, "sess-abc");
  } finally {
    await Deno.remove(ticketDir, { recursive: true });
    await Deno.remove(homeDir, { recursive: true });
  }
});

Deno.test("executePhase: does not write .session sidecar when no session ID in output", async () => {
  const ticketDir = await Deno.makeTempDir();
  const homeDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
    const outputFile = "20260101T120000-intake.md";
    const agent: CodeAgent = {
      runPhase: () => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
    };
    await executePhase(
      {
        ticketDir,
        stateDir: ticketDir,
        outputFile,
        phase: "intake",
        scopeDirs: [],
        prompt: "p",
        worktrees: {},
        homeDir,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        thinking: "off",
        agentType: "pi",
      },
      agent,
    );
    let exists = true;
    try {
      await Deno.stat(join(ticketDir, outputFile + ".session"));
    } catch {
      exists = false;
    }
    assertFalse(exists);
  } finally {
    await Deno.remove(ticketDir, { recursive: true });
    await Deno.remove(homeDir, { recursive: true });
  }
});

// ── extractUsageAndText ──────────────────────────────────────────────────────

const singleTurnNdjson = [
  JSON.stringify({ type: "session", version: 3, id: "test-session-id-single" }),
  JSON.stringify({
    type: "agent_end",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hi" }],
      },
      {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Hello!" }],
        usage: {
          input: 10,
          output: 5,
          cacheRead: 100,
          cacheWrite: 50,
          totalTokens: 165,
          cacheWrite1h: 0,
          reasoning: 0,
          cost: {},
        },
      },
    ],
  }),
].join("\n");

Deno.test(
  "extractUsageAndText: single-turn returns correct text, usage fields, and durationMs",
  () => {
    const result = extractUsageAndText(singleTurnNdjson, 1234);
    assertEquals(result.text, "Hello!");
    assertEquals(result.usage?.models[0].input, 10);
    assertEquals(result.usage?.models[0].output, 5);
    assertEquals(result.usage?.models[0].cacheRead, 100);
    assertEquals(result.usage?.models[0].cacheWrite, 50);
    assertEquals(result.usage?.models[0].model, "claude-sonnet-4-6");
    assertEquals(result.usage?.durationMs, 1234);
    assertEquals(result.usage?.turns, 1);
  },
);

const multiTurnNdjson = [
  JSON.stringify({ type: "session", version: 3, id: "test-session-id-multi" }),
  JSON.stringify({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "q" }] },
      {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "First." }],
        usage: {
          input: 8,
          output: 3,
          cacheRead: 40,
          cacheWrite: 20,
          totalTokens: 71,
          cacheWrite1h: 0,
          reasoning: 0,
          cost: {},
        },
      },
      { role: "user", content: [{ type: "text", text: "tool result" }] },
      {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Second." }],
        usage: {
          input: 2,
          output: 7,
          cacheRead: 60,
          cacheWrite: 30,
          totalTokens: 99,
          cacheWrite1h: 0,
          reasoning: 0,
          cost: {},
        },
      },
    ],
  }),
].join("\n");

Deno.test(
  "extractUsageAndText: multi-turn sums usage fields and keeps only the final assistant turn's text",
  () => {
    const result = extractUsageAndText(multiTurnNdjson, 500);
    assertEquals(result.text, "Second.");
    assertEquals(result.usage?.models[0].input, 10);
    assertEquals(result.usage?.models[0].output, 10);
    assertEquals(result.usage?.models[0].cacheRead, 100);
    assertEquals(result.usage?.models[0].cacheWrite, 50);
    assertEquals(result.usage?.models[0].model, "claude-sonnet-4-6");
    assertEquals(result.usage?.durationMs, 500);
    assertEquals(result.usage?.turns, 2);
  },
);

Deno.test(
  "extractUsageAndText: trailing text-only assistant turn after a tool-only turn returns only that final text",
  () => {
    const ndjson = JSON.stringify({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [
            { type: "text", text: "Let me check the file." },
            { type: "tool_use", name: "read", input: {} },
          ],
        },
        { role: "user", content: [{ type: "tool_result", text: "..." }] },
        {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "## Proposed Scope\n..." }],
        },
      ],
    });
    const result = extractUsageAndText(ndjson, 50);
    assertEquals(result.text, "## Proposed Scope\n...");
  },
);

Deno.test(
  "extractUsageAndText: no agent_end line returns empty text and null usage",
  () => {
    const ndjson = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "test-session-id-none",
      }),
      JSON.stringify({ type: "message_update", delta: "hi" }),
    ].join("\n");
    const result = extractUsageAndText(ndjson, 100);
    assertEquals(result.text, "");
    assertEquals(result.usage, null);
  },
);

Deno.test(
  "extractUsageAndText: assistant content with only thinking items returns empty text and usage",
  () => {
    const ndjson = JSON.stringify({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "thinking", thinking: "internal" }],
          usage: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cacheWrite1h: 0,
            reasoning: 0,
            cost: {},
          },
        },
      ],
    });
    const result = extractUsageAndText(ndjson, 50);
    assertEquals(result.text, "");
    assertEquals(result.usage?.models[0].input, 1);
    assertEquals(result.usage?.models[0].output, 2);
    assertEquals(result.usage?.turns, 1);
  },
);

// ── extractSessionId ─────────────────────────────────────────────────────────

Deno.test("extractSessionId: returns id from session event", () => {
  const ndjson = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "019efc41-6064-70b9-bc99-8656c9148a50",
    }),
    JSON.stringify({ type: "message_update", delta: "hi" }),
  ].join("\n");
  assertEquals(
    extractSessionId(ndjson),
    "019efc41-6064-70b9-bc99-8656c9148a50",
  );
});

Deno.test("extractSessionId: returns null when no session event is present", () => {
  const ndjson = JSON.stringify({ type: "agent_end", messages: [] });
  assertEquals(extractSessionId(ndjson), null);
});

Deno.test("extractSessionId: returns null when session event has no id field", () => {
  const ndjson = [
    JSON.stringify({ type: "session" }),
    JSON.stringify({ type: "agent_end", messages: [] }),
  ].join("\n");
  assertEquals(extractSessionId(ndjson), null);
});

// ── extractClaudeCodeUsageAndText / extractClaudeCodeSessionId ─────────────

const claudeCodeResultNdjson = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "cc-session-abc",
  }),
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "..." }] },
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "cc-session-abc",
    num_turns: 2,
    duration_ms: 4321,
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    },
    result: "final assistant text",
    modelUsage: { "claude-sonnet-4-6": { inputTokens: 100, outputTokens: 50 } },
  }),
].join("\n");

Deno.test(
  "extractClaudeCodeUsageAndText: returns result text, mapped usage fields, and durationMs override",
  () => {
    const result = extractClaudeCodeUsageAndText(
      claudeCodeResultNdjson,
      999,
      "claude-sonnet-4-6",
    );
    assertEquals(result.text, "final assistant text");
    assertEquals(result.usage?.models.length, 1);
    assertEquals(result.usage?.models[0].input, 100);
    assertEquals(result.usage?.models[0].output, 50);
    assertEquals(result.usage?.models[0].cacheRead, 10);
    assertEquals(result.usage?.models[0].cacheWrite, 5);
    assertEquals(result.usage?.models[0].model, "claude-sonnet-4-6");
    assertEquals(result.usage?.durationMs, 999);
    assertEquals(result.usage?.turns, 2);
  },
);

Deno.test(
  "extractClaudeCodeUsageAndText: strips context-window suffix from modelUsage key",
  () => {
    const ndjson = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "text",
      modelUsage: { "claude-opus-4-8[1m]": { inputTokens: 1 } },
    });
    const result = extractClaudeCodeUsageAndText(ndjson, 100, "");
    assertEquals(result.usage?.models[0].model, "claude-opus-4-8");
  },
);

Deno.test(
  "extractClaudeCodeUsageAndText: two-model modelUsage attributes cache tokens to primary model",
  () => {
    const ndjson = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "text",
      num_turns: 43,
      usage: {
        input_tokens: 177,
        output_tokens: 7751,
        cache_read_input_tokens: 1822762,
        cache_creation_input_tokens: 43186,
      },
      modelUsage: {
        "claude-haiku-4-5-20251001": { inputTokens: 10, outputTokens: 5 },
        "claude-sonnet-4-6": { inputTokens: 167, outputTokens: 7746 },
      },
    });
    const result = extractClaudeCodeUsageAndText(
      ndjson,
      244618,
      "claude-sonnet-4-6",
    );
    assertEquals(result.usage?.models.length, 2);
    const sonnet = result.usage!.models.find(
      (m) => m.model === "claude-sonnet-4-6",
    )!;
    const haiku = result.usage!.models.find(
      (m) => m.model === "claude-haiku-4-5-20251001",
    )!;
    assertEquals(sonnet.input, 167);
    assertEquals(sonnet.output, 7746);
    assertEquals(sonnet.cacheRead, 1822762);
    assertEquals(sonnet.cacheWrite, 43186);
    assertEquals(haiku.input, 10);
    assertEquals(haiku.output, 5);
    assertEquals(haiku.cacheRead, 0);
    assertEquals(haiku.cacheWrite, 0);
    assertEquals(result.usage?.turns, 43);
    assertEquals(result.usage?.durationMs, 244618);
  },
);

Deno.test(
  "extractClaudeCodeUsageAndText: requestedModel wins cache attribution even when another model has more direct tokens",
  () => {
    const ndjson = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "text",
      usage: {
        input_tokens: 600,
        output_tokens: 600,
        cache_read_input_tokens: 999,
        cache_creation_input_tokens: 111,
      },
      modelUsage: {
        "claude-haiku-4-5-20251001": { inputTokens: 500, outputTokens: 500 },
        "claude-sonnet-4-6": { inputTokens: 100, outputTokens: 100 },
      },
    });
    const result = extractClaudeCodeUsageAndText(
      ndjson,
      0,
      "claude-sonnet-4-6",
    );
    const sonnet = result.usage!.models.find(
      (m) => m.model === "claude-sonnet-4-6",
    )!;
    const haiku = result.usage!.models.find(
      (m) => m.model === "claude-haiku-4-5-20251001",
    )!;
    assertEquals(sonnet.cacheRead, 999);
    assertEquals(sonnet.cacheWrite, 111);
    assertEquals(haiku.cacheRead, 0);
    assertEquals(haiku.cacheWrite, 0);
  },
);

Deno.test(
  "extractClaudeCodeUsageAndText: no result event returns empty text and null usage",
  () => {
    const ndjson = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "x" }),
      JSON.stringify({ type: "assistant", message: { content: [] } }),
    ].join("\n");
    const result = extractClaudeCodeUsageAndText(ndjson, 100, "");
    assertEquals(result.text, "");
    assertEquals(result.usage, null);
  },
);

Deno.test("extractClaudeCodeSessionId: returns session_id from the system init event", () => {
  assertEquals(
    extractClaudeCodeSessionId(claudeCodeResultNdjson),
    "cc-session-abc",
  );
});

Deno.test("extractClaudeCodeSessionId: returns null when no system event is present", () => {
  const ndjson = JSON.stringify({
    type: "result",
    session_id: "should-not-use-this",
  });
  assertEquals(extractClaudeCodeSessionId(ndjson), null);
});

Deno.test("extractClaudeCodeSessionId: returns null when system event has no session_id field", () => {
  const ndjson = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "result", session_id: "x" }),
  ].join("\n");
  assertEquals(extractClaudeCodeSessionId(ndjson), null);
});

Deno.test(
  "executePhase: phase-end log entry includes sessionId when agent stdout contains a session event with an id",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");

      const stdout = [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "abc123-session-id",
        }),
        JSON.stringify({ type: "agent_end", messages: [] }),
      ].join("\n");

      const agent: CodeAgent = {
        runPhase() {
          return Promise.resolve({ stdout, stderr: "", code: 0 });
        },
      };

      await executePhase(
        {
          ticketDir,
          stateDir: dirname(ticketDir),
          outputFile: "out.md",
          phase: "intake",
          scopeDirs: [],
          prompt: "prompt",
          worktrees: {},
          homeDir,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          thinking: "off",
          agentType: "pi",
        },
        agent,
      );

      const logContent = await Deno.readTextFile(
        join(ticketDir, "log.ndjson"),
      );
      const logLines = logContent.trim().split("\n");
      const endEntry = JSON.parse(logLines[logLines.length - 1]);
      assertEquals(endEntry.event, "phase-end");
      assertEquals(endEntry.sessionId, "abc123-session-id");
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

Deno.test(
  "executePhase: agentType 'claude-code' uses the Claude Code parser for usage",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");

      const resultNdjson = JSON.stringify({
        type: "result",
        subtype: "success",
        num_turns: 1,
        result: "claude code output",
        model: "claude-sonnet-4-6",
        usage: {
          input_tokens: 7,
          output_tokens: 4,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      });

      const agent: CodeAgent = {
        runPhase() {
          return Promise.resolve({ stdout: resultNdjson, stderr: "", code: 0 });
        },
      };

      await executePhase(
        {
          ticketDir,
          stateDir: dirname(ticketDir),
          outputFile: "result.md",
          phase: "spec",
          scopeDirs: [],
          prompt: "prompt",
          worktrees: {},
          homeDir,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          thinking: "off",
          agentType: "claude-code",
        },
        agent,
      );

      const usage = JSON.parse(
        await Deno.readTextFile(join(ticketDir, "result.usage.json")),
      );
      assertEquals(usage.models[0].input, 7);
      assertEquals(usage.models[0].output, 4);
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

Deno.test(
  "executePhase: phase-end log entry includes sessionId parsed via the Claude Code parser when agentType is claude-code",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");

      const stdout = [
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "cc-xyz",
        }),
        JSON.stringify({ type: "result", result: "" }),
      ].join("\n");

      const agent: CodeAgent = {
        runPhase() {
          return Promise.resolve({ stdout, stderr: "", code: 0 });
        },
      };

      await executePhase(
        {
          ticketDir,
          stateDir: dirname(ticketDir),
          outputFile: "out.md",
          phase: "intake",
          scopeDirs: [],
          prompt: "prompt",
          worktrees: {},
          homeDir,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          thinking: "off",
          agentType: "claude-code",
        },
        agent,
      );

      const logContent = await Deno.readTextFile(join(ticketDir, "log.ndjson"));
      const logLines = logContent.trim().split("\n");
      const endEntry = JSON.parse(logLines[logLines.length - 1]);
      assertEquals(endEntry.sessionId, "cc-xyz");
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

// ── executePhase: costUsd in sidecar ─────────────────────────────────────────

Deno.test(
  "executePhase: includes costUsd in sidecar when pricing cache contains the model",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
      await Deno.mkdir(join(homeDir, ".urras"));

      const pricingCache: AnthropicPricingCache = {
        fetchedAt: Temporal.Now.instant().toString(),
        models: {
          "claude-sonnet-4-6": {
            inputPerMTok: 3,
            outputPerMTok: 15,
            cacheWritePerMTok: 3.75,
            cacheReadPerMTok: 0.30,
          },
        },
      };
      await Deno.writeTextFile(
        join(homeDir, ".urras", "anthropic-pricing.json"),
        JSON.stringify(pricingCache),
      );

      const agentEndNdjson = JSON.stringify({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "output" }],
            usage: {
              input: 1_000_000,
              output: 1_000_000,
              cacheRead: 0,
              cacheWrite: 0,
            },
          },
        ],
      });

      const agent: CodeAgent = {
        runPhase() {
          return Promise.resolve({
            stdout: agentEndNdjson,
            stderr: "",
            code: 0,
          });
        },
      };

      await executePhase(
        {
          ticketDir,
          stateDir: dirname(ticketDir),
          outputFile: "result.md",
          phase: "spec",
          scopeDirs: [],
          prompt: "p",
          worktrees: {},
          homeDir,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          thinking: "off",
          agentType: "pi",
        },
        agent,
      );

      const usageRaw = await Deno.readTextFile(
        join(ticketDir, "result.usage.json"),
      );
      const usage = JSON.parse(usageRaw);
      // 1_000_000 * 3/1_000_000 + 1_000_000 * 15/1_000_000 = 18
      assertEquals(usage.models[0].costUsd, 18);
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

Deno.test(
  "executePhase: omits costUsd from sidecar when pricing cache is absent",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");

      const agentEndNdjson = JSON.stringify({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "output" }],
            usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      });

      const agent: CodeAgent = {
        runPhase() {
          return Promise.resolve({
            stdout: agentEndNdjson,
            stderr: "",
            code: 0,
          });
        },
      };

      await executePhase(
        {
          ticketDir,
          stateDir: dirname(ticketDir),
          outputFile: "result.md",
          phase: "spec",
          scopeDirs: [],
          prompt: "p",
          worktrees: {},
          homeDir,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          thinking: "off",
          agentType: "pi",
        },
        agent,
      );

      const usageRaw = await Deno.readTextFile(
        join(ticketDir, "result.usage.json"),
      );
      const usage = JSON.parse(usageRaw);
      assertFalse("costUsd" in usage);
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

Deno.test(
  "executePhase: agentType 'claude-code' calls setupClaudeCodeDirectories, not setupPiDirectories",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");

      const agent: CodeAgent = {
        runPhase: () => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
      };

      await executePhase(
        {
          ticketDir,
          stateDir: dirname(ticketDir),
          outputFile: "out.md",
          phase: "spec",
          scopeDirs: [],
          prompt: "p",
          worktrees: {},
          homeDir,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          thinking: "off",
          agentType: "claude-code",
        },
        agent,
      );

      const claudeCodeDir = await Deno.stat(
        join(homeDir, ".urras", "claude-code"),
      );
      assert(claudeCodeDir.isDirectory);

      const settings = JSON.parse(
        await Deno.readTextFile(
          join(homeDir, ".urras", "claude-code", "settings.json"),
        ),
      );
      assertEquals(settings.attribution.commit, "");
      assertEquals(settings.attribution.pr, "");

      let piDirExists = false;
      try {
        await Deno.stat(join(homeDir, ".urras", "pi"));
        piDirExists = true;
      } catch { /* expected */ }
      assertFalse(piDirExists);
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

Deno.test(
  "executePhase: agentType 'pi' calls setupPiDirectories and injects pi env vars, does not create claude-code dir",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");

      let capturedEnv: Record<string, string> = {};
      const agent: CodeAgent = {
        runPhase(opts) {
          capturedEnv = opts.env;
          return Promise.resolve({ stdout: "", stderr: "", code: 0 });
        },
      };

      await executePhase(
        {
          ticketDir,
          stateDir: dirname(ticketDir),
          outputFile: "out.md",
          phase: "spec",
          scopeDirs: [],
          prompt: "p",
          worktrees: {},
          homeDir,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          thinking: "off",
          agentType: "pi",
        },
        agent,
      );

      assertEquals(
        capturedEnv.PI_CODING_AGENT_DIR,
        join(homeDir, ".urras", "pi"),
      );

      let claudeCodeDirExists = false;
      try {
        await Deno.stat(join(homeDir, ".urras", "claude-code"));
        claudeCodeDirExists = true;
      } catch { /* expected */ }
      assertFalse(claudeCodeDirExists);
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

Deno.test(
  "executePhase: omits costUsd from sidecar when model is not in pricing cache",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
      await Deno.mkdir(join(homeDir, ".urras"));
      await Deno.writeTextFile(
        join(homeDir, ".urras", "anthropic-pricing.json"),
        JSON.stringify({
          fetchedAt: Temporal.Now.instant().toString(),
          models: {
            "claude-haiku-4-5": {
              inputPerMTok: 1,
              outputPerMTok: 5,
              cacheWritePerMTok: 1.25,
              cacheReadPerMTok: 0.10,
            },
          },
        }),
      );

      const agentEndNdjson = JSON.stringify({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            model: "claude-unknown-model",
            content: [{ type: "text", text: "output" }],
            usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      });

      const agent: CodeAgent = {
        runPhase() {
          return Promise.resolve({
            stdout: agentEndNdjson,
            stderr: "",
            code: 0,
          });
        },
      };

      await executePhase(
        {
          ticketDir,
          stateDir: dirname(ticketDir),
          outputFile: "result.md",
          phase: "spec",
          scopeDirs: [],
          prompt: "p",
          worktrees: {},
          homeDir,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          thinking: "off",
          agentType: "pi",
        },
        agent,
      );

      const usageRaw = await Deno.readTextFile(
        join(ticketDir, "result.usage.json"),
      );
      const usage = JSON.parse(usageRaw);
      assertFalse("costUsd" in usage);
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

Deno.test(
  "executePhase: agentType 'claude-code' calls setupClaudeCodeDirectories, not setupPiDirectories",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");

      const agent: CodeAgent = {
        runPhase: () => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
      };

      await executePhase(
        {
          ticketDir,
          stateDir: dirname(ticketDir),
          outputFile: "out.md",
          phase: "spec",
          scopeDirs: [],
          prompt: "p",
          worktrees: {},
          homeDir,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          thinking: "off",
          agentType: "claude-code",
        },
        agent,
      );

      const claudeCodeDir = await Deno.stat(
        join(homeDir, ".urras", "claude-code"),
      );
      assert(claudeCodeDir.isDirectory);

      const settings = JSON.parse(
        await Deno.readTextFile(
          join(homeDir, ".urras", "claude-code", "settings.json"),
        ),
      );
      assertEquals(settings.attribution.commit, "");
      assertEquals(settings.attribution.pr, "");

      let piDirExists = false;
      try {
        await Deno.stat(join(homeDir, ".urras", "pi"));
        piDirExists = true;
      } catch { /* expected */ }
      assertFalse(piDirExists);
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

Deno.test(
  "executePhase: agentType 'pi' calls setupPiDirectories and injects pi env vars, does not create claude-code dir",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");

      let capturedEnv: Record<string, string> = {};
      const agent: CodeAgent = {
        runPhase(opts) {
          capturedEnv = opts.env;
          return Promise.resolve({ stdout: "", stderr: "", code: 0 });
        },
      };

      await executePhase(
        {
          ticketDir,
          stateDir: dirname(ticketDir),
          outputFile: "out.md",
          phase: "spec",
          scopeDirs: [],
          prompt: "p",
          worktrees: {},
          homeDir,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          thinking: "off",
          agentType: "pi",
        },
        agent,
      );

      assertEquals(
        capturedEnv.PI_CODING_AGENT_DIR,
        join(homeDir, ".urras", "pi"),
      );

      let claudeCodeDirExists = false;
      try {
        await Deno.stat(join(homeDir, ".urras", "claude-code"));
        claudeCodeDirExists = true;
      } catch { /* expected */ }
      assertFalse(claudeCodeDirExists);
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

// ── extractUsageAndText: tool counting ───────────────────────────────────────

Deno.test("extractUsageAndText: single tool_use item counted into usage.tools", () => {
  const ndjson = JSON.stringify({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "tool_use", name: "read", input: {} }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  const result = extractUsageAndText(ndjson, 100);
  assertEquals(result.usage?.tools, { read: 1 });
});

Deno.test("extractUsageAndText: tool_use items across multiple assistant messages are counted and aggregated", () => {
  const ndjson = JSON.stringify({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          { type: "tool_use", name: "read", input: {} },
          { type: "tool_use", name: "read", input: {} },
        ],
        usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
      { role: "user", content: [{ type: "tool_result", text: "" }] },
      {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          { type: "tool_use", name: "write", input: {} },
          { type: "text", text: "done" },
        ],
        usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  const result = extractUsageAndText(ndjson, 100);
  assertEquals(result.usage?.tools, { read: 2, write: 1 });
});

Deno.test("extractUsageAndText: no tool_use items leaves usage.tools undefined", () => {
  const result = extractUsageAndText(singleTurnNdjson, 100);
  assertEquals(result.usage?.tools, undefined);
});

// ── extractClaudeCodeUsageAndText: tool counting ─────────────────────────────

Deno.test("extractClaudeCodeUsageAndText: tool_use items from assistant events are counted and lowercased", () => {
  const ndjson = [
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
    }),
    JSON.stringify({
      type: "result",
      result: "text",
      num_turns: 1,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }),
  ].join("\n");
  const result = extractClaudeCodeUsageAndText(ndjson, 100, "");
  assertEquals(result.usage?.tools, { read: 1 });
});

Deno.test("extractClaudeCodeUsageAndText: tool_use items across multiple assistant events are aggregated", () => {
  const ndjson = [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Read", input: {} },
          { type: "tool_use", name: "Bash", input: {} },
        ],
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Read", input: {} }],
      },
    }),
    JSON.stringify({
      type: "result",
      result: "text",
      num_turns: 2,
      usage: {
        input_tokens: 20,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }),
  ].join("\n");
  const result = extractClaudeCodeUsageAndText(ndjson, 100, "");
  assertEquals(result.usage?.tools, { read: 2, bash: 1 });
});

Deno.test("extractClaudeCodeUsageAndText: no tool_use content leaves usage.tools undefined", () => {
  const result = extractClaudeCodeUsageAndText(
    claudeCodeResultNdjson,
    100,
    "claude-sonnet-4-6",
  );
  assertEquals(result.usage?.tools, undefined);
});

// ── executePhase: tools in sidecar ───────────────────────────────────────────

Deno.test("executePhase: usage sidecar includes tools when agent stdout contains tool_use items", async () => {
  const ticketDir = await Deno.makeTempDir();
  const homeDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
    const stdout = JSON.stringify({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [
            { type: "tool_use", name: "read", input: {} },
            { type: "tool_use", name: "read", input: {} },
            { type: "tool_use", name: "bash", input: {} },
          ],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    const agent: CodeAgent = {
      runPhase: () => Promise.resolve({ stdout, stderr: "", code: 0 }),
    };
    await executePhase(
      {
        ticketDir,
        stateDir: dirname(ticketDir),
        outputFile: "result.md",
        phase: "spec",
        scopeDirs: [],
        prompt: "p",
        worktrees: {},
        homeDir,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        thinking: "off",
        agentType: "pi",
      },
      agent,
    );
    const usage = JSON.parse(
      await Deno.readTextFile(join(ticketDir, "result.usage.json")),
    );
    assertEquals(usage.tools, { read: 2, bash: 1 });
  } finally {
    await Deno.remove(ticketDir, { recursive: true });
    await Deno.remove(homeDir, { recursive: true });
  }
});

Deno.test("executePhase: usage sidecar omits tools when agent stdout has no tool_use items", async () => {
  const ticketDir = await Deno.makeTempDir();
  const homeDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
    const stdout = JSON.stringify({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "output" }],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    const agent: CodeAgent = {
      runPhase: () => Promise.resolve({ stdout, stderr: "", code: 0 }),
    };
    await executePhase(
      {
        ticketDir,
        stateDir: dirname(ticketDir),
        outputFile: "result.md",
        phase: "spec",
        scopeDirs: [],
        prompt: "p",
        worktrees: {},
        homeDir,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        thinking: "off",
        agentType: "pi",
      },
      agent,
    );
    const usage = JSON.parse(
      await Deno.readTextFile(join(ticketDir, "result.usage.json")),
    );
    assertFalse("tools" in usage);
  } finally {
    await Deno.remove(ticketDir, { recursive: true });
    await Deno.remove(homeDir, { recursive: true });
  }
});

// ── executePhase: sessionId threading ────────────────────────────────────────

Deno.test("executePhase: passes sessionId to agent.runPhase when provided", async () => {
  const ticketDir = await Deno.makeTempDir();
  const homeDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
    let capturedSessionId: string | undefined;
    const agent: CodeAgent = {
      runPhase(opts) {
        capturedSessionId = opts.sessionId;
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      },
    };
    await executePhase(
      {
        ticketDir,
        stateDir: dirname(ticketDir),
        outputFile: "out.md",
        phase: "implementation",
        scopeDirs: [],
        prompt: "do thing",
        worktrees: {},
        homeDir,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        thinking: "off",
        agentType: "pi",
        sessionId: "sess-42",
      },
      agent,
    );
    assertEquals(capturedSessionId, "sess-42");
  } finally {
    await Deno.remove(ticketDir, { recursive: true });
    await Deno.remove(homeDir, { recursive: true });
  }
});

Deno.test("executePhase: passes undefined sessionId to agent when not provided", async () => {
  const ticketDir = await Deno.makeTempDir();
  const homeDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
    let capturedSessionId: string | undefined = "sentinel";
    const agent: CodeAgent = {
      runPhase(opts) {
        capturedSessionId = opts.sessionId;
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      },
    };
    await executePhase(
      {
        ticketDir,
        stateDir: dirname(ticketDir),
        outputFile: "out.md",
        phase: "implementation",
        scopeDirs: [],
        prompt: "do thing",
        worktrees: {},
        homeDir,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        thinking: "off",
        agentType: "pi",
      },
      agent,
    );
    assertEquals(capturedSessionId, undefined);
  } finally {
    await Deno.remove(ticketDir, { recursive: true });
    await Deno.remove(homeDir, { recursive: true });
  }
});

Deno.test(
  "executePhase: passes resume: true to agent.runPhase when resume is true",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    let capturedResume: boolean | undefined;
    const agent: CodeAgent = {
      runPhase(opts) {
        capturedResume = opts.resume;
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      },
    };
    try {
      await executePhase(
        {
          ticketDir,
          stateDir: dirname(ticketDir),
          outputFile: "out.md",
          phase: "implementation",
          scopeDirs: [],
          prompt: "do thing",
          worktrees: {},
          homeDir,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          thinking: "off",
          agentType: "pi",
          resume: true,
        },
        agent,
      );
      assertEquals(capturedResume, true);
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

// ── executePhase: filtered principles file lifecycle ─────────────────────────

Deno.test(
  "executePhase: persists filtered principles file in ticket directory after agent completes",
  async () => {
    const stateDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    try {
      const ticketDir = join(stateDir, "github", "acme", "repo", "1");
      await Deno.mkdir(ticketDir, { recursive: true });
      await Deno.writeTextFile(
        join(ticketDir, "meta.md"),
        "---\ntitle: T\n---\n## Problem\nP.",
      );
      const entries = Array.from({ length: 21 }, (_, i) => `- p${i}`).join(
        "\n",
      );
      await Deno.writeTextFile(join(stateDir, "principles.md"), entries);

      const agent: CodeAgent = {
        runPhase() {
          return Promise.resolve({ stdout: "", stderr: "", code: 0 });
        },
      };
      const run: CommandRunner = () =>
        Promise.resolve({ code: 0, stdout: JSON.stringify({ indices: [0] }) });

      await executePhase(
        {
          ticketDir,
          stateDir,
          outputFile: "out.md",
          phase: "plan",
          scopeDirs: [],
          prompt: "p",
          worktrees: {},
          homeDir,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          thinking: "off",
          agentType: "pi",
          run,
        },
        agent,
      );

      const filteredFile = join(ticketDir, "principles-filtered.md");
      const info = await Deno.stat(filteredFile);
      assert(info.isFile);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

// ── executePhase: critique pass ──────────────────────────────────────────────

Deno.test(
  "executePhase: skips critique when no <phase>-critique.md exists for phase",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
      let callCount = 0;
      const agent: CodeAgent = {
        runPhase() {
          callCount++;
          return Promise.resolve({ stdout: "", stderr: "", code: 0 });
        },
      };
      await executePhase(
        {
          ticketDir,
          stateDir: dirname(ticketDir),
          outputFile: "result.md",
          phase: "intake",
          scopeDirs: [],
          prompt: "p",
          worktrees: {},
          homeDir,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          thinking: "off",
          agentType: "pi",
        },
        agent,
      );
      assertEquals(callCount, 1);
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

Deno.test(
  "executePhase: critique APPROVED leaves no critique file and makes no re-run",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
      const outputPath = join(ticketDir, "result.md");
      let callCount = 0;
      const agent: CodeAgent = {
        async runPhase() {
          callCount++;
          if (callCount === 1) {
            await Deno.writeTextFile(outputPath, "## Plan\n\ncontent");
            return { stdout: "", stderr: "", code: 0 };
          }
          return {
            stdout: JSON.stringify({
              type: "agent_end",
              messages: [{
                role: "assistant",
                model: "claude-sonnet-4-6",
                content: [{ type: "text", text: "VERDICT: APPROVED" }],
                usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
              }],
            }),
            stderr: "",
            code: 0,
          };
        },
      };
      await executePhase(
        {
          ticketDir,
          stateDir: dirname(ticketDir),
          outputFile: "result.md",
          phase: "plan",
          scopeDirs: [],
          prompt: "p",
          worktrees: {},
          homeDir,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          thinking: "off",
          agentType: "pi",
        },
        agent,
      );
      assertEquals(callCount, 2);
      const critiqueFiles: string[] = [];
      for await (const e of Deno.readDir(ticketDir)) {
        if (e.name.endsWith("-critique.md")) critiqueFiles.push(e.name);
      }
      assertEquals(critiqueFiles.length, 0);
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

Deno.test(
  "executePhase: persists filtered principles file in ticket directory even when agent throws",
  async () => {
    const stateDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    try {
      const ticketDir = join(stateDir, "github", "acme", "repo", "1");
      await Deno.mkdir(ticketDir, { recursive: true });
      await Deno.writeTextFile(
        join(ticketDir, "meta.md"),
        "---\ntitle: T\n---\n## Problem\nP.",
      );
      const entries = Array.from({ length: 21 }, (_, i) => `- p${i}`).join(
        "\n",
      );
      await Deno.writeTextFile(join(stateDir, "principles.md"), entries);

      const agent: CodeAgent = {
        runPhase() {
          throw new Error("agent crashed");
        },
      };
      const run: CommandRunner = () =>
        Promise.resolve({ code: 0, stdout: JSON.stringify({ indices: [0] }) });

      await assertRejects(
        () =>
          executePhase(
            {
              ticketDir,
              stateDir,
              outputFile: "out.md",
              phase: "plan",
              scopeDirs: [],
              prompt: "p",
              worktrees: {},
              homeDir,
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              thinking: "off",
              agentType: "pi",
              run,
            },
            agent,
          ),
        Error,
        "agent crashed",
      );

      const filteredFile = join(ticketDir, "principles-filtered.md");
      const info = await Deno.stat(filteredFile);
      assert(info.isFile);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

Deno.test("buildContextFiles: passes ollamaModels to filterPrinciples", async () => {
  const stateDir = await Deno.makeTempDir();
  const ticketDir = join(stateDir, "github", "test-org", "test-repo", "1");
  await Deno.mkdir(ticketDir, { recursive: true });
  try {
    const principles = Array.from(
      { length: 21 },
      (_, i) => `- principle ${i}`,
    ).join("\n");
    await Deno.writeTextFile(join(stateDir, "principles.md"), principles);
    await Deno.writeTextFile(
      join(ticketDir, "meta.md"),
      "---\ntitle: Test\n---\n## Problem\nsome problem",
    );
    const ollamaFetch = spy(
      (_url: unknown, _init?: RequestInit) =>
        Promise.resolve(
          new Response(
            JSON.stringify({ response: JSON.stringify({ indices: [3] }) }),
            { status: 200 },
          ),
        ),
    ) as unknown as typeof fetch;
    const ollama = new OllamaLanguageModel(ollamaFetch, { model: "test" });
    const run = spy((_args: string[]) =>
      Promise.resolve({ code: 1, stdout: "" })
    );
    const { contextFiles, tempPrinciplesFile } = await buildContextFiles({
      ticketDir,
      stateDir,
      run,
      ollamaModels: [ollama],
    });
    assert(
      contextFiles.some((f) => f.includes("principles-filtered")),
      "filtered principles not in contextFiles",
    );
    const content = await Deno.readTextFile(tempPrinciplesFile!);
    assertStringIncludes(content, "principle 3");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});
Deno.test(
  "executePhase: critique ISSUES_FOUND writes critique file and re-runs phase agent exactly once",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
      const outputPath = join(ticketDir, "result.md");
      let callCount = 0;
      const agent: CodeAgent = {
        async runPhase() {
          callCount++;
          if (callCount === 1) {
            await Deno.writeTextFile(outputPath, "## Plan\n\ndraft");
            return { stdout: "", stderr: "", code: 0 };
          }
          if (callCount === 2) {
            return {
              stdout: JSON.stringify({
                type: "agent_end",
                messages: [{
                  role: "assistant",
                  model: "claude-sonnet-4-6",
                  content: [{
                    type: "text",
                    text:
                      "- component X does not exist\n\nVERDICT: ISSUES_FOUND",
                  }],
                  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                }],
              }),
              stderr: "",
              code: 0,
            };
          }
          await Deno.writeTextFile(outputPath, "## Plan\n\nrevised");
          return { stdout: "", stderr: "", code: 0 };
        },
      };
      await executePhase(
        {
          ticketDir,
          stateDir: dirname(ticketDir),
          outputFile: "result.md",
          phase: "plan",
          scopeDirs: [],
          prompt: "p",
          worktrees: {},
          homeDir,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          thinking: "off",
          agentType: "pi",
        },
        agent,
      );
      assertEquals(callCount, 3);
      const critiqueFiles: string[] = [];
      for await (const e of Deno.readDir(ticketDir)) {
        if (e.name.endsWith("-plan-critique.md")) critiqueFiles.push(e.name);
      }
      assertEquals(critiqueFiles.length, 1);
      assertStringIncludes(
        await Deno.readTextFile(join(ticketDir, critiqueFiles[0])),
        "VERDICT: ISSUES_FOUND",
      );
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

Deno.test(
  "executePhase: critique agent crash does not block the pipeline",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
      const outputPath = join(ticketDir, "result.md");
      let callCount = 0;
      const agent: CodeAgent = {
        async runPhase() {
          callCount++;
          if (callCount === 1) {
            await Deno.writeTextFile(outputPath, "## Plan\n\ncontent");
            return { stdout: "", stderr: "", code: 0 };
          }
          throw new Error("critique agent crashed");
        },
      };
      const code = await executePhase(
        {
          ticketDir,
          stateDir: dirname(ticketDir),
          outputFile: "result.md",
          phase: "plan",
          scopeDirs: [],
          prompt: "p",
          worktrees: {},
          homeDir,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          thinking: "off",
          agentType: "pi",
        },
        agent,
      );
      assertEquals(code, 0);
      assertStringIncludes(await Deno.readTextFile(outputPath), "content");
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

Deno.test(
  "executePhase: critique garbled output (no VERDICT line) is treated as APPROVED",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
      const outputPath = join(ticketDir, "result.md");
      let callCount = 0;
      const agent: CodeAgent = {
        async runPhase() {
          callCount++;
          if (callCount === 1) {
            await Deno.writeTextFile(outputPath, "## Plan\n\ncontent");
            return { stdout: "", stderr: "", code: 0 };
          }
          return {
            stdout: JSON.stringify({
              type: "agent_end",
              messages: [{
                role: "assistant",
                model: "claude-sonnet-4-6",
                content: [{
                  type: "text",
                  text: "I cannot determine a verdict",
                }],
                usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
              }],
            }),
            stderr: "",
            code: 0,
          };
        },
      };
      await executePhase(
        {
          ticketDir,
          stateDir: dirname(ticketDir),
          outputFile: "result.md",
          phase: "plan",
          scopeDirs: [],
          prompt: "p",
          worktrees: {},
          homeDir,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          thinking: "off",
          agentType: "pi",
        },
        agent,
      );
      assertEquals(callCount, 2);
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

Deno.test(
  "executePhase: ISSUES_FOUND re-run usage is accumulated into the usage sidecar",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
      const outputPath = join(ticketDir, "result.md");
      const makeUsageNdjson = (input: number, output: number) =>
        JSON.stringify({
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              model: "claude-sonnet-4-6",
              content: [{ type: "text", text: "out" }],
              usage: { input, output, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        });
      const critiqueNdjson = JSON.stringify({
        type: "agent_end",
        messages: [{
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "VERDICT: ISSUES_FOUND" }],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        }],
      });
      let callCount = 0;
      const agent: CodeAgent = {
        async runPhase() {
          callCount++;
          if (callCount === 1) {
            await Deno.writeTextFile(outputPath, "## Plan\n\ndraft");
            return { stdout: makeUsageNdjson(10, 5), stderr: "", code: 0 };
          }
          if (callCount === 2) {
            return { stdout: critiqueNdjson, stderr: "", code: 0 };
          }
          await Deno.writeTextFile(outputPath, "## Plan\n\nrevised");
          return { stdout: makeUsageNdjson(8, 4), stderr: "", code: 0 };
        },
      };
      await executePhase(
        {
          ticketDir,
          stateDir: dirname(ticketDir),
          outputFile: "result.md",
          phase: "plan",
          scopeDirs: [],
          prompt: "p",
          worktrees: {},
          homeDir,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          thinking: "off",
          agentType: "pi",
        },
        agent,
      );
      const usage = JSON.parse(
        await Deno.readTextFile(join(ticketDir, "result.usage.json")),
      );
      const totalInput = usage.models.reduce(
        (s: number, m: { input: number }) => s + m.input,
        0,
      );
      const totalOutput = usage.models.reduce(
        (s: number, m: { output: number }) => s + m.output,
        0,
      );
      assertEquals(totalInput, 18);
      assertEquals(totalOutput, 9);
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

Deno.test(
  "executePhase: critique skipped when draft file absent after phase agent exits",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
      let callCount = 0;
      const agent: CodeAgent = {
        runPhase() {
          callCount++;
          return Promise.resolve({ stdout: "", stderr: "", code: 1 });
        },
      };
      await executePhase(
        {
          ticketDir,
          stateDir: dirname(ticketDir),
          outputFile: "result.md",
          phase: "plan",
          scopeDirs: [],
          prompt: "p",
          worktrees: {},
          homeDir,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          thinking: "off",
          agentType: "pi",
        },
        agent,
      );
      assertEquals(callCount, 1);
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

// ── executePhase: .selfapprove sidecar ───────────────────────────────────────

Deno.test(
  "executePhase: writes .selfapprove sidecar after agent runs",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    const homeDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(ticketDir, "meta.md"), "---\n---\n");
      const agent: CodeAgent = {
        runPhase: () => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
      };
      await executePhase(
        {
          ticketDir,
          stateDir: dirname(ticketDir),
          outputFile: "20260101T120000-no-such-phase.md",
          phase: "no-such-phase",
          scopeDirs: [],
          prompt: "p",
          worktrees: {},
          homeDir,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          thinking: "off",
          agentType: "pi",
        },
        agent,
      );
      const raw = await Deno.readTextFile(
        join(ticketDir, "20260101T120000-no-such-phase.md.selfapprove"),
      );
      const parsed = JSON.parse(raw);
      assertEquals(typeof parsed.approved, "boolean");
      assert("reason" in parsed);
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
      await Deno.remove(homeDir, { recursive: true });
    }
  },
);

// ── readSelfApprove ──────────────────────────────────────────────────────────

Deno.test("readSelfApprove: returns null when no matching file exists", async () => {
  const ticketDir = await Deno.makeTempDir();
  try {
    assertEquals(await readSelfApprove(ticketDir, "intake"), null);
  } finally {
    await Deno.remove(ticketDir, { recursive: true });
  }
});

Deno.test(
  "readSelfApprove: returns null when ticketDir does not exist",
  async () => {
    assertEquals(await readSelfApprove("/nonexistent/dir/xyz", "intake"), null);
  },
);

Deno.test(
  "readSelfApprove: returns parsed result from matching .selfapprove file",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(ticketDir, "20260101T120000-intake.md.selfapprove"),
        JSON.stringify({ approved: true, reason: null }),
      );
      const result = await readSelfApprove(ticketDir, "intake");
      assertEquals(result, { approved: true, reason: null });
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
    }
  },
);

Deno.test(
  "readSelfApprove: returns result from latest file when multiple matches exist",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(ticketDir, "20260101T100000-intake.md.selfapprove"),
        JSON.stringify({ approved: false, reason: "old" }),
      );
      await Deno.writeTextFile(
        join(ticketDir, "20260101T120000-intake.md.selfapprove"),
        JSON.stringify({ approved: true, reason: null }),
      );
      const result = await readSelfApprove(ticketDir, "intake");
      assertEquals(result, { approved: true, reason: null });
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
    }
  },
);

Deno.test(
  "readSelfApprove: returns null when file content is not valid JSON",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(ticketDir, "20260101T120000-intake.md.selfapprove"),
        "not json",
      );
      assertEquals(await readSelfApprove(ticketDir, "intake"), null);
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
    }
  },
);

Deno.test(
  "readSelfApprove: does not match files for a different phase",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(ticketDir, "20260101T120000-spec.md.selfapprove"),
        JSON.stringify({ approved: true, reason: null }),
      );
      assertEquals(await readSelfApprove(ticketDir, "intake"), null);
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
    }
  },
);
