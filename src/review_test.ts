import {
  assert,
  assertEquals,
  assertFalse,
  assertGreater,
  assertLessOrEqual,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dim, stripAnsiCode } from "@std/fmt/colors";
import { assertSpyCalls, spy, stub } from "@std/testing/mock";
import {
  answerQuestion,
  applyApproval,
  buildQuestionSystemPrompt,
  classifyApproval,
  ErrorOverlay,
  findAllPhaseOutputs,
  findLatestPhaseOutput,
  findLatestSelfReview,
  formatTimestamp,
  renderDiff,
  renderTabBar,
  renderTicketTab,
  review,
  wrapDiffLines,
} from "./review.ts";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { join } from "@std/path";
import { readTicket, writeTicket } from "./state/store.ts";
import { makeTicket } from "./test-support.ts";
import type { TicketState } from "./state/types.ts";
import type { LanguageModel } from "./models/types.ts";

const BASE = { id: "gh-1" };

async function initGitRepo(dir: string): Promise<void> {
  const run = (cmd: string[]) =>
    new Deno.Command(cmd[0], { args: cmd.slice(1), cwd: dir }).output();
  await run(["git", "init"]);
  await run(["git", "config", "user.email", "test@example.com"]);
  await run(["git", "config", "user.name", "Test User"]);
  await run(["git", "config", "commit.gpgsign", "false"]);
}

// ── classifyApproval ──────────────────────────────────────────────────────────

Deno.test("classifyApproval: returns true when model returns APPROVE", async () => {
  const model = {
    name: "stub",
    generateText: () => Promise.resolve(null),
    generateObject: () => Promise.resolve({ verdict: "APPROVE" }),
  } as unknown as LanguageModel;
  assert(await classifyApproval("Looks good!", model));
});

Deno.test("classifyApproval: returns false when model returns FEEDBACK", async () => {
  const model = {
    name: "stub",
    generateText: () => Promise.resolve(null),
    generateObject: () => Promise.resolve({ verdict: "FEEDBACK" }),
  } as unknown as LanguageModel;
  assertFalse(await classifyApproval("fix the tests", model));
});

Deno.test(
  "classifyApproval: returns false without calling model when text exceeds 50 characters",
  async () => {
    const generateObject = spy(() => Promise.resolve({ verdict: "APPROVE" }));
    const model = {
      name: "stub",
      generateText: () => Promise.resolve(null),
      generateObject,
    } as unknown as LanguageModel;
    assertFalse(await classifyApproval("a".repeat(51), model));
    assertSpyCalls(generateObject, 0);
  },
);

Deno.test("classifyApproval: throws when model returns null", async () => {
  const model = {
    name: "stub",
    generateText: () => Promise.resolve(null),
    generateObject: () => Promise.resolve(null),
  } as unknown as LanguageModel;
  await assertRejects(
    () => classifyApproval("approved", model),
    Error,
    "Approval detection failed",
  );
});

// ── applyApproval ─────────────────────────────────────────────────────────────

Deno.test("applyApproval: appends entry with actor human and current phase", async () => {
  const dir = await Deno.makeTempDir();
  await initGitRepo(dir);
  const run = (cmd: string[]) =>
    new Deno.Command(cmd[0], { args: cmd.slice(1), cwd: dir }).output();
  try {
    await writeTicket(
      dir,
      makeTicket({ ...BASE, phase: "spec", status: "waiting" }),
    );
    await run(["git", "add", "-A"]);
    await run(["git", "commit", "-m", "initial"]);
    const now = Temporal.ZonedDateTime.from("2026-06-29T12:00:00+00:00[UTC]");
    await applyApproval(dir, "gh-1", now);
    const ticket = await readTicket(dir, "gh-1");
    assertEquals(ticket.approvals.length, 1);
    assertEquals(ticket.approvals[0].actor, "human");
    assertEquals(ticket.approvals[0].phase, "spec");
    assertEquals(ticket.approvals[0].timestamp, now.toInstant().toString());
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("applyApproval: does not write approved key to frontmatter", async () => {
  const dir = await Deno.makeTempDir();
  await initGitRepo(dir);
  const run = (cmd: string[]) =>
    new Deno.Command(cmd[0], { args: cmd.slice(1), cwd: dir }).output();
  try {
    await writeTicket(dir, makeTicket(BASE));
    await run(["git", "add", "-A"]);
    await run(["git", "commit", "-m", "initial"]);
    await applyApproval(dir, "gh-1", Temporal.Now.zonedDateTimeISO("UTC"));
    const raw = await Deno.readTextFile(`${dir}/gh-1/meta.md`);
    assertFalse(raw.includes("approved:"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("applyApproval: leaves status unchanged", async () => {
  const dir = await Deno.makeTempDir();
  await initGitRepo(dir);
  const run = (cmd: string[]) =>
    new Deno.Command(cmd[0], { args: cmd.slice(1), cwd: dir }).output();
  try {
    await writeTicket(dir, makeTicket({ ...BASE, status: "waiting" }));
    await run(["git", "add", "-A"]);
    await run(["git", "commit", "-m", "initial"]);
    await applyApproval(dir, "gh-1", Temporal.Now.zonedDateTimeISO("UTC"));
    const ticket = await readTicket(dir, "gh-1");
    assertEquals(ticket.status, "waiting");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test(
  "applyApproval: sets updated to the provided timestamp",
  async () => {
    const dir = await Deno.makeTempDir();
    await initGitRepo(dir);
    const run = (cmd: string[]) =>
      new Deno.Command(cmd[0], { args: cmd.slice(1), cwd: dir }).output();
    try {
      await writeTicket(dir, makeTicket(BASE));
      await run(["git", "add", "-A"]);
      await run(["git", "commit", "-m", "initial"]);
      const now = Temporal.ZonedDateTime.from(
        "2026-06-29T12:00:00+00:00[UTC]",
      );
      await applyApproval(dir, "gh-1", now);
      const ticket = await readTicket(dir, "gh-1");
      assertEquals(ticket.updated, now.toInstant().toString());
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test("applyApproval: commits with message approve: <id>", async () => {
  const dir = await Deno.makeTempDir();
  await initGitRepo(dir);
  const run = (cmd: string[]) =>
    new Deno.Command(cmd[0], { args: cmd.slice(1), cwd: dir }).output();
  try {
    await writeTicket(dir, makeTicket(BASE));
    await run(["git", "add", "-A"]);
    await run(["git", "commit", "-m", "initial"]);
    await applyApproval(dir, "gh-1", Temporal.Now.zonedDateTimeISO("UTC"));
    const log = await run(["git", "log", "--oneline", "-1"]);
    const message = new TextDecoder().decode(log.stdout).trim();
    assert(message.endsWith("approve: gh-1"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── findLatestPhaseOutput ─────────────────────────────────────────────────────

Deno.test("findLatestPhaseOutput: returns prefixed output file for the most advanced phase present", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "20260629T154506-spec.md"), "spec");
    const result = await findLatestPhaseOutput(tempDir);
    assertEquals(result?.filename, "20260629T154506-spec.md");
    assertEquals(result?.phaseName, "spec");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findLatestPhaseOutput: returns lexicographically latest of multiple prefixed files", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "20260629T154506-spec.md"), "v1");
    await Deno.writeTextFile(join(tempDir, "20260629T225507-spec.md"), "v2");
    const result = await findLatestPhaseOutput(tempDir);
    assertEquals(result?.filename, "20260629T225507-spec.md");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findLatestPhaseOutput: excludes feedback files when finding latest output", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "20260629T154506-spec.md"), "v1");
    await Deno.writeTextFile(
      join(tempDir, "20260629T225507-spec-feedback.md"),
      "fb",
    );
    const result = await findLatestPhaseOutput(tempDir);
    assertEquals(result?.filename, "20260629T154506-spec.md");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findLatestPhaseOutput: returns null when only old-format canonical file exists", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "spec.md"), "old canonical");
    const result = await findLatestPhaseOutput(tempDir);
    assertEquals(result, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findLatestPhaseOutput: returns null when ticket directory is empty", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const result = await findLatestPhaseOutput(tempDir);
    assertEquals(result, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findLatestPhaseOutput: returns null previousFilename when only one revision exists", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "20260629T154506-spec.md"), "v1");
    const result = await findLatestPhaseOutput(tempDir);
    assertEquals(result?.previousFilename, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findLatestPhaseOutput: returns second-to-last file as previousFilename with two revisions", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "20260629T154506-spec.md"), "v1");
    await Deno.writeTextFile(join(tempDir, "20260629T225507-spec.md"), "v2");
    const result = await findLatestPhaseOutput(tempDir);
    assertEquals(result?.previousFilename, "20260629T154506-spec.md");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findLatestPhaseOutput: returns second-to-last file as previousFilename with three revisions", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "20260629T154506-spec.md"), "v1");
    await Deno.writeTextFile(join(tempDir, "20260629T225507-spec.md"), "v2");
    await Deno.writeTextFile(join(tempDir, "20260630T100000-spec.md"), "v3");
    const result = await findLatestPhaseOutput(tempDir);
    assertEquals(result?.filename, "20260630T100000-spec.md");
    assertEquals(result?.previousFilename, "20260629T225507-spec.md");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findLatestPhaseOutput: returns merge output file with phaseName merge", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260629T154506-merge.md"),
      "merge output",
    );
    const result = await findLatestPhaseOutput(tempDir);
    assertEquals(result?.filename, "20260629T154506-merge.md");
    assertEquals(result?.phaseName, "merge");
    assertEquals(result?.previousFilename, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findLatestPhaseOutput: prefers merge output over earlier phase files", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260629T154506-implementation.md"),
      "impl",
    );
    await Deno.writeTextFile(
      join(tempDir, "20260629T225507-merge.md"),
      "merge",
    );
    const result = await findLatestPhaseOutput(tempDir);
    assertEquals(result?.filename, "20260629T225507-merge.md");
    assertEquals(result?.phaseName, "merge");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ── findAllPhaseOutputs ───────────────────────────────────────────────────────

Deno.test("findAllPhaseOutputs: returns empty array when no output files exist", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    assertEquals(await findAllPhaseOutputs(tempDir), []);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findAllPhaseOutputs: returns all phases with output in PHASE_SEQUENCE order", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260629T154506-intake.md"),
      "intake",
    );
    await Deno.writeTextFile(join(tempDir, "20260629T154507-spec.md"), "spec");
    const result = await findAllPhaseOutputs(tempDir);
    assertEquals(result.length, 2);
    assertEquals(result[0].phaseName, "intake");
    assertEquals(result[1].phaseName, "spec");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findAllPhaseOutputs: omits phases with no output files", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "20260629T154507-spec.md"), "spec");
    const result = await findAllPhaseOutputs(tempDir);
    assertEquals(result.length, 1);
    assertEquals(result[0].phaseName, "spec");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findAllPhaseOutputs: filename is lexicographically last; previousFilename is second-to-last", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "20260629T154506-spec.md"), "v1");
    await Deno.writeTextFile(join(tempDir, "20260629T225507-spec.md"), "v2");
    const result = await findAllPhaseOutputs(tempDir);
    assertEquals(result[0].filename, "20260629T225507-spec.md");
    assertEquals(result[0].previousFilename, "20260629T154506-spec.md");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findAllPhaseOutputs: previousFilename is null when only one file exists for a phase", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "20260629T154506-intake.md"), "v1");
    const result = await findAllPhaseOutputs(tempDir);
    assertEquals(result[0].previousFilename, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findAllPhaseOutputs: places merge phase after all PHASE_SEQUENCE phases", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260629T154506-intake.md"),
      "intake",
    );
    await Deno.writeTextFile(
      join(tempDir, "20260629T154507-merge.md"),
      "merge",
    );
    const result = await findAllPhaseOutputs(tempDir);
    assertEquals(result.length, 2);
    assertEquals(result[0].phaseName, "intake");
    assertEquals(result[1].phaseName, "merge");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findAllPhaseOutputs: excludes feedback files", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "20260629T154506-spec.md"), "v1");
    await Deno.writeTextFile(
      join(tempDir, "20260629T225507-spec-feedback.md"),
      "fb",
    );
    const result = await findAllPhaseOutputs(tempDir);
    assertEquals(result.length, 1);
    assertEquals(result[0].filename, "20260629T154506-spec.md");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ── findLatestSelfReview ──────────────────────────────────────────────────────

Deno.test("findLatestSelfReview: returns null when no self-review file exists", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    assertEquals(
      await findLatestSelfReview(tempDir, "plan", "20260812T031620"),
      null,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findLatestSelfReview: returns null when self-review timestamp is not strictly after afterTimestamp", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260812T031620-plan-self-review.md"),
      "REJECT reason",
    );
    assertEquals(
      await findLatestSelfReview(tempDir, "plan", "20260812T031620"),
      null,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findLatestSelfReview: returns null when first line does not start with REJECT", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260812T032227-plan-self-review.md"),
      "APPROVE",
    );
    assertEquals(
      await findLatestSelfReview(tempDir, "plan", "20260812T031620"),
      null,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findLatestSelfReview: returns filename and fullText for valid rejection after afterTimestamp", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const content = "REJECT plan has no task sections\nmore detail";
    await Deno.writeTextFile(
      join(tempDir, "20260812T032227-plan-self-review.md"),
      content,
    );
    const result = await findLatestSelfReview(
      tempDir,
      "plan",
      "20260812T031620",
    );
    assertEquals(result?.filename, "20260812T032227-plan-self-review.md");
    assertEquals(result?.fullText, content);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findLatestSelfReview: returns newest self-review, skips stale ones", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "20260807T191215-plan-self-review.md"),
      "REJECT old",
    );
    await Deno.writeTextFile(
      join(tempDir, "20260812T032227-plan-self-review.md"),
      "REJECT newer",
    );
    const result = await findLatestSelfReview(
      tempDir,
      "plan",
      "20260812T031620",
    );
    assertEquals(result?.filename, "20260812T032227-plan-self-review.md");
    assertEquals(result?.fullText, "REJECT newer");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ── renderTabBar ──────────────────────────────────────────────────────────────

Deno.test("renderTabBar: single tab renders as [phaseName]", () => {
  const result = renderTabBar([{ phaseName: "spec" }], 0);
  assertEquals(stripAnsiCode(result), "[spec]");
});

Deno.test("renderTabBar: active tab is bracketed and inactive tabs are not", () => {
  const result = stripAnsiCode(
    renderTabBar([{ phaseName: "intake" }, { phaseName: "spec" }], 1),
  );
  assertStringIncludes(result, "[spec]");
  assertFalse(result.includes("[intake]"));
});

Deno.test("renderTabBar: inactive tab text is dimmed", () => {
  const result = renderTabBar(
    [{ phaseName: "intake" }, { phaseName: "spec" }],
    1,
  );
  assertStringIncludes(result, dim("intake"));
});

Deno.test("renderTabBar: tabs are separated by ' ─ '", () => {
  const result = stripAnsiCode(
    renderTabBar(
      [{ phaseName: "intake" }, { phaseName: "enrichment" }, {
        phaseName: "spec",
      }],
      2,
    ),
  );
  assertStringIncludes(result, "intake ─ enrichment ─ [spec]");
});

// ── renderDiff ────────────────────────────────────────────────────────────────

Deno.test("renderDiff: prefixes added lines with green '+ ' and removed with red '- '", () => {
  const lines = renderDiff("old\n", "new\n");
  const stripped = lines.map((l) => stripAnsiCode(l));
  assert(stripped.some((l) => l === "- old"));
  assert(stripped.some((l) => l === "+ new"));
});

Deno.test("renderDiff: prefixes unchanged lines with two spaces dimmed", () => {
  const lines = renderDiff("same\nold\n", "same\nnew\n");
  const stripped = lines.map((l) => stripAnsiCode(l));
  assert(stripped.some((l) => l === "  same"));
});

Deno.test("renderDiff: does not emit trailing blank line from file-ending newline", () => {
  const lines = renderDiff("a\n", "a\n");
  assert(lines.every((l) => stripAnsiCode(l) !== ""));
});

// ── wrapDiffLines ─────────────────────────────────────────────────────────────

Deno.test("wrapDiffLines: wraps long added line and prefixes each continuation with '+ '", () => {
  const lines = renderDiff("", ("word ".repeat(40)).trimEnd() + "\n");
  const result = wrapDiffLines(lines, 80);
  assertGreater(result.length, 1);
  for (const line of result) {
    assertLessOrEqual(stripAnsiCode(line).length, 80);
    assert(stripAnsiCode(line).startsWith("+ "));
    assertFalse(stripAnsiCode(line).endsWith("..."));
  }
});

Deno.test("wrapDiffLines: does not truncate long single-token removed line", () => {
  const lines = renderDiff("a".repeat(200) + "\n", "");
  const result = wrapDiffLines(lines, 80);
  assertEquals(result.length, 1);
  assertGreater(stripAnsiCode(result[0]).length, 80);
  assertFalse(stripAnsiCode(result[0]).endsWith("..."));
});

Deno.test("wrapDiffLines: short context line is returned unchanged", () => {
  const lines = renderDiff("context text\n", "context text\n");
  const result = wrapDiffLines(lines, 80);
  assertEquals(result.length, 1);
  assertEquals(result[0], lines[0]);
});

Deno.test("wrapDiffLines: short diff lines produce identical output to renderDiff", () => {
  const diffLines = renderDiff("old line\n", "new line\n");
  const result = wrapDiffLines(diffLines, 80);
  assertEquals(result, diffLines);
});

// ── buildQuestionSystemPrompt ────────────────────────────────────────────────

Deno.test("buildQuestionSystemPrompt: includes fixed framing sentence", async () => {
  const readFile = spy((_path: string | URL) => Promise.resolve("content"));
  const result = await buildQuestionSystemPrompt(
    ["@/ticket/meta.md"],
    readFile,
  );
  assert(
    result.startsWith(
      "You are a helpful assistant answering questions about a ticket's phase output.",
    ),
  );
});

Deno.test("buildQuestionSystemPrompt: strips leading @ when reading file", async () => {
  const readFile = spy((_path: string | URL) => Promise.resolve("content"));
  await buildQuestionSystemPrompt(["@/ticket/meta.md"], readFile);
  assertSpyCalls(readFile, 1);
  assertEquals(readFile.calls[0].args[0] as string, "/ticket/meta.md");
});

Deno.test("buildQuestionSystemPrompt: includes file content in output", async () => {
  const readFile = spy((_path: string | URL) =>
    Promise.resolve("# Phase Output\n\nSome content.")
  );
  const result = await buildQuestionSystemPrompt(
    ["@/ticket/spec.md"],
    readFile,
  );
  assertStringIncludes(result, "# Phase Output");
  assertStringIncludes(result, "Some content.");
});

Deno.test("buildQuestionSystemPrompt: silently skips unreadable files", async () => {
  const readFile = spy((_path: string | URL) =>
    Promise.reject(new Error("ENOENT"))
  );
  const result = await buildQuestionSystemPrompt(["@/missing.md"], readFile);
  assertEquals(typeof result, "string");
  assertSpyCalls(readFile, 1);
  assertFalse(result.includes("ENOENT"));
});

Deno.test("buildQuestionSystemPrompt: separates multiple files with headings", async () => {
  const readFile = spy((_path: string | URL) => Promise.resolve("body"));
  const result = await buildQuestionSystemPrompt(
    ["@/ticket/meta.md", "@/ticket/spec.md"],
    readFile,
  );
  assertSpyCalls(readFile, 2);
  assertStringIncludes(result, "/ticket/meta.md");
  assertStringIncludes(result, "/ticket/spec.md");
});

// ── answerQuestion ────────────────────────────────────────────────────────────

Deno.test(
  "answerQuestion: appends user then assistant message on success",
  async () => {
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
    const fetcher = spy(
      (_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              content: [{ type: "text", text: "Here is the answer." }],
            }),
            { status: 200 },
          ),
        ),
    );
    await answerQuestion(messages, "What does this do?", "System.", fetcher);
    assertEquals(messages.length, 2);
    assertEquals(messages[0], { role: "user", content: "What does this do?" });
    assertEquals(messages[1], {
      role: "assistant",
      content: "Here is the answer.",
    });
  },
);

Deno.test(
  "answerQuestion: appends error message on non-2xx response",
  async () => {
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
    const fetcher = spy(
      (_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(new Response("Unauthorized", { status: 401 })),
    );
    await answerQuestion(messages, "What?", "System.", fetcher);
    assertEquals(messages.length, 2);
    assertEquals(messages[1].content, "Error: could not get a response.");
  },
);

Deno.test(
  "answerQuestion: appends error message when fetch throws",
  async () => {
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
    const fetcher = spy(
      (_url: string | URL | Request, _init?: RequestInit) =>
        Promise.reject(new Error("network error")),
    );
    await answerQuestion(messages, "What?", "System.", fetcher);
    assertEquals(messages.length, 2);
    assertEquals(messages[1].content, "Error: could not get a response.");
  },
);

Deno.test(
  "answerQuestion: sends full conversation history on each call",
  async () => {
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
    ];
    const fetcher = spy(
      (_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              content: [{ type: "text", text: "Second answer." }],
            }),
            { status: 200 },
          ),
        ),
    );
    await answerQuestion(messages, "Second question", "System.", fetcher);
    assertSpyCalls(fetcher, 1);
    const body = JSON.parse(fetcher.calls[0].args[1]!.body as string);
    assertEquals(body.messages.length, 3);
    assertEquals(body.messages[0], {
      role: "user",
      content: "First question",
    });
    assertEquals(body.messages[1], {
      role: "assistant",
      content: "First answer",
    });
    assertEquals(body.messages[2], {
      role: "user",
      content: "Second question",
    });
    assertEquals(messages.length, 4);
  },
);

Deno.test("answerQuestion: uses model claude-haiku-4-5", async () => {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  const fetcher = spy(
    (_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({ content: [{ type: "text", text: "ok" }] }),
          { status: 200 },
        ),
      ),
  );
  await answerQuestion(messages, "hi", "System.", fetcher);
  const body = JSON.parse(fetcher.calls[0].args[1]!.body as string);
  assertEquals(body.model, "claude-haiku-4-5");
});

Deno.test("answerQuestion: sends system prompt in request body", async () => {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  const fetcher = spy(
    (_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({ content: [{ type: "text", text: "ok" }] }),
          { status: 200 },
        ),
      ),
  );
  await answerQuestion(messages, "hi", "Custom system prompt.", fetcher);
  const body = JSON.parse(fetcher.calls[0].args[1]!.body as string);
  assertEquals(body.system, "Custom system prompt.");
});

// ── formatTimestamp ───────────────────────────────────────────────────────────

Deno.test("formatTimestamp: returns YYYYMMDDTHHMMSS with no hyphens in the date portion", () => {
  const zdt = Temporal.ZonedDateTime.from("2026-06-29T22:46:53+00:00[UTC]");
  assertEquals(formatTimestamp(zdt), "20260629T224653");
});

Deno.test("formatTimestamp: zero-pads single-digit month, day, hour, minute, second", () => {
  const zdt = Temporal.ZonedDateTime.from("2026-01-05T03:07:09+00:00[UTC]");
  assertEquals(formatTimestamp(zdt), "20260105T030709");
});

// ── ErrorOverlay ──────────────────────────────────────────────────────────────

Deno.test("ErrorOverlay: render includes the message set via setMessage", () => {
  const mockTui = {
    requestRender: spy((_full: boolean) => {}),
  } as unknown as TUI;
  const overlay = new ErrorOverlay(mockTui);
  overlay.setMessage("Approval detection failed: 401 Unauthorized");
  const lines = overlay.render(80);
  assert(
    lines.some((l) =>
      l.includes("Approval detection failed: 401 Unauthorized")
    ),
  );
});

Deno.test(
  "ErrorOverlay: handleInput with any key calls setHidden(true) on the handle",
  () => {
    const mockTui = {
      requestRender: spy((_full: boolean) => {}),
    } as unknown as TUI;
    const overlay = new ErrorOverlay(mockTui);
    const setHidden = spy((_hidden: boolean) => {});
    const mockHandle = { setHidden } as unknown as OverlayHandle;
    overlay.setHandle(mockHandle, () => {});
    overlay.handleInput("a");
    assertSpyCalls(setHidden, 1);
    assertEquals(setHidden.calls[0].args[0], true);
  },
);

Deno.test("ErrorOverlay: handleInput calls the onDismiss callback", () => {
  const mockTui = {
    requestRender: spy((_full: boolean) => {}),
  } as unknown as TUI;
  const overlay = new ErrorOverlay(mockTui);
  const setHidden = spy((_hidden: boolean) => {});
  const mockHandle = { setHidden } as unknown as OverlayHandle;
  const onDismiss = spy(() => {});
  overlay.setHandle(mockHandle, onDismiss);
  overlay.handleInput("\x1b");
  assertSpyCalls(onDismiss, 1);
});

// ── review ───────────────────────────────────────────────────────────────────

async function withReviewConfig(
  stateDir: string,
  fn: () => Promise<void>,
): Promise<void> {
  const homeDir = await Deno.makeTempDir();
  const configDir = join(homeDir, ".config", "urras");
  await Deno.mkdir(configDir, { recursive: true });
  await Deno.writeTextFile(
    join(configDir, "config.toml"),
    `[github]\nrepos = []\n\n[state]\ndir = "${stateDir}"\n\n[tick]\nconcurrency = 1\n\n[codebase]\nroots = []\n`,
  );
  const originalHome = Deno.env.get("HOME");
  Deno.env.set("HOME", homeDir);
  try {
    await fn();
  } finally {
    if (originalHome !== undefined) {
      Deno.env.set("HOME", originalHome);
    } else {
      Deno.env.delete("HOME");
    }
    await Deno.remove(homeDir, { recursive: true });
  }
}

Deno.test(
  "review: exits with code 1 and prints error when ticket is running",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const ticketId = "github/test/repo/1";
      await writeTicket(
        stateDir,
        makeTicket({ id: ticketId, phase: "spec", status: "running" }),
      );
      await Deno.writeTextFile(
        join(stateDir, ticketId, "20260101T000000-spec.md"),
        "spec output",
      );
      await withReviewConfig(stateDir, async () => {
        const exitStub = stub(Deno, "exit", (_code?: number) => {
          throw new Error(`exit:${_code}`);
        });
        const errorStub = stub(console, "error");
        try {
          await review(ticketId);
        } catch {
          // expected: exitStub throws
        } finally {
          exitStub.restore();
          errorStub.restore();
        }
        assertSpyCalls(exitStub, 1);
        assertEquals(exitStub.calls[0].args[0], 1);
        assertSpyCalls(errorStub, 1);
        assertEquals(
          errorStub.calls[0].args[0],
          `ticket ${ticketId} is currently running`,
        );
      });
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "review: does not print running error for non-running ticket",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const ticketId = "github/test/repo/2";
      await writeTicket(
        stateDir,
        makeTicket({ id: ticketId, phase: "spec", status: "waiting" }),
      );
      await withReviewConfig(stateDir, async () => {
        const exitStub = stub(Deno, "exit", (_code?: number) => {
          throw new Error(`exit:${_code}`);
        });
        const errorStub = stub(console, "error");
        try {
          await review(ticketId);
        } catch {
          // expected: exitStub throws on "no phase output"
        } finally {
          exitStub.restore();
          errorStub.restore();
        }
        assertSpyCalls(errorStub, 1);
        assertStringIncludes(
          errorStub.calls[0].args[0] as string,
          `No output for phase "spec" on ticket ${ticketId}`,
        );
      });
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

// ── review (piped path) ───────────────────────────────────────────────────────

async function setupPipedReviewState(
  stateDir: string,
  ticketId: string,
): Promise<(cmd: string[]) => Promise<Deno.CommandOutput>> {
  await initGitRepo(stateDir);
  const run = (cmd: string[]) =>
    new Deno.Command(cmd[0], { args: cmd.slice(1), cwd: stateDir }).output();
  await writeTicket(
    stateDir,
    makeTicket({ id: ticketId, phase: "spec", status: "waiting" }),
  );
  await Deno.writeTextFile(
    join(stateDir, ticketId, "20260101T000000-spec.md"),
    "spec output",
  );
  await run(["git", "add", "-A"]);
  await run(["git", "commit", "-m", "initial"]);
  return run;
}

Deno.test(
  "review: piped path exits 1 and prints error when stdin is empty",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const ticketId = "github/test/repo/20";
      await setupPipedReviewState(stateDir, ticketId);
      await withReviewConfig(stateDir, async () => {
        const exitStub = stub(Deno, "exit", (_code?: number) => {
          throw new Error(`exit:${_code}`);
        });
        const errorStub = stub(console, "error");
        try {
          await review(ticketId, {
            isTerminal: () => false,
            readStdin: () => Promise.resolve(""),
          });
        } catch {
          // expected
        } finally {
          exitStub.restore();
          errorStub.restore();
        }
        assertSpyCalls(exitStub, 1);
        assertEquals(exitStub.calls[0].args[0], 1);
        assertSpyCalls(errorStub, 1);
        assertEquals(errorStub.calls[0].args[0], "review input is empty");
      });
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "review: piped path exits 1 and prints error when stdin is whitespace-only",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const ticketId = "github/test/repo/21";
      await setupPipedReviewState(stateDir, ticketId);
      await withReviewConfig(stateDir, async () => {
        const exitStub = stub(Deno, "exit", (_code?: number) => {
          throw new Error(`exit:${_code}`);
        });
        const errorStub = stub(console, "error");
        try {
          await review(ticketId, {
            isTerminal: () => false,
            readStdin: () => Promise.resolve("   \n  "),
          });
        } catch {
          // expected
        } finally {
          exitStub.restore();
          errorStub.restore();
        }
        assertSpyCalls(exitStub, 1);
        assertEquals(exitStub.calls[0].args[0], 1);
        assertSpyCalls(errorStub, 1);
        assertEquals(errorStub.calls[0].args[0], "review input is empty");
      });
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "review: piped path writes feedback file named {timestamp}-spec-feedback.md",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const ticketId = "github/test/repo/22";
      await setupPipedReviewState(stateDir, ticketId);
      await withReviewConfig(stateDir, async () => {
        const exitStub = stub(Deno, "exit", (_code?: number) => {
          throw new Error(`exit:${_code}`);
        });
        try {
          await review(ticketId, {
            isTerminal: () => false,
            readStdin: () => Promise.resolve("needs work on section 3"),
          });
        } catch {
          // expected
        } finally {
          exitStub.restore();
        }
        const entries: string[] = [];
        for await (const entry of Deno.readDir(join(stateDir, ticketId))) {
          entries.push(entry.name);
        }
        assert(entries.some((e) => /^\d{8}T\d{6}-spec-feedback\.md$/.test(e)));
      });
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "review: piped path sets ticket status to revising",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const ticketId = "github/test/repo/23";
      await setupPipedReviewState(stateDir, ticketId);
      await withReviewConfig(stateDir, async () => {
        const exitStub = stub(Deno, "exit", (_code?: number) => {
          throw new Error(`exit:${_code}`);
        });
        try {
          await review(ticketId, {
            isTerminal: () => false,
            readStdin: () => Promise.resolve("fix the tests"),
          });
        } catch {
          // expected
        } finally {
          exitStub.restore();
        }
        const ticket = await readTicket(stateDir, ticketId);
        assertEquals(ticket.status, "revising");
      });
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "review: piped path commits with message review: <id>",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const ticketId = "github/test/repo/24";
      const run = await setupPipedReviewState(stateDir, ticketId);
      await withReviewConfig(stateDir, async () => {
        const exitStub = stub(Deno, "exit", (_code?: number) => {
          throw new Error(`exit:${_code}`);
        });
        try {
          await review(ticketId, {
            isTerminal: () => false,
            readStdin: () => Promise.resolve("fix the tests"),
          });
        } catch {
          // expected
        } finally {
          exitStub.restore();
        }
        const log = await run(["git", "log", "--oneline", "-1"]);
        const message = new TextDecoder().decode(log.stdout).trim();
        assert(message.endsWith(`review: ${ticketId}`));
      });
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "review: piped path exits 0 on success",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const ticketId = "github/test/repo/25";
      await setupPipedReviewState(stateDir, ticketId);
      await withReviewConfig(stateDir, async () => {
        const exitStub = stub(Deno, "exit", (_code?: number) => {
          throw new Error(`exit:${_code}`);
        });
        try {
          await review(ticketId, {
            isTerminal: () => false,
            readStdin: () => Promise.resolve("fix the tests"),
          });
        } catch {
          // expected
        } finally {
          exitStub.restore();
        }
        assertSpyCalls(exitStub, 1);
        assertEquals(exitStub.calls[0].args[0], 0);
      });
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "review: piped path prints nothing to stdout on success",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const ticketId = "github/test/repo/26";
      await setupPipedReviewState(stateDir, ticketId);
      await withReviewConfig(stateDir, async () => {
        const exitStub = stub(Deno, "exit", (_code?: number) => {
          throw new Error(`exit:${_code}`);
        });
        const logStub = stub(console, "log");
        try {
          await review(ticketId, {
            isTerminal: () => false,
            readStdin: () => Promise.resolve("fix the tests"),
          });
        } catch {
          // expected
        } finally {
          exitStub.restore();
          logStub.restore();
        }
        assertSpyCalls(logStub, 0);
      });
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "review: piped path exits 1 with phase-specific error when ticket.phase has no output",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const ticketId = "github/test/repo/50";
      await initGitRepo(stateDir);
      const run = (cmd: string[]) =>
        new Deno.Command(cmd[0], { args: cmd.slice(1), cwd: stateDir })
          .output();
      await writeTicket(
        stateDir,
        makeTicket({
          id: ticketId,
          phase: "implementation",
          status: "needs-attention",
        }),
      );
      await Deno.writeTextFile(
        join(stateDir, ticketId, "20260101T000000-spec.md"),
        "spec output",
      );
      await run(["git", "add", "-A"]);
      await run(["git", "commit", "-m", "initial"]);
      await withReviewConfig(stateDir, async () => {
        const exitStub = stub(Deno, "exit", (_code?: number) => {
          throw new Error(`exit:${_code}`);
        });
        const errorStub = stub(console, "error");
        try {
          await review(ticketId, {
            isTerminal: () => false,
            readStdin: () => Promise.resolve("feedback text"),
          });
        } catch {
          // expected
        } finally {
          exitStub.restore();
          errorStub.restore();
        }
        assertSpyCalls(exitStub, 1);
        assertEquals(exitStub.calls[0].args[0], 1);
        assertSpyCalls(errorStub, 1);
        assertEquals(
          errorStub.calls[0].args[0],
          `No output for phase "implementation" on ticket ${ticketId}`,
        );
      });
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "review: piped path writes no feedback file when ticket.phase has no output",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const ticketId = "github/test/repo/51";
      await initGitRepo(stateDir);
      const run = (cmd: string[]) =>
        new Deno.Command(cmd[0], { args: cmd.slice(1), cwd: stateDir })
          .output();
      await writeTicket(
        stateDir,
        makeTicket({
          id: ticketId,
          phase: "implementation",
          status: "needs-attention",
        }),
      );
      await Deno.writeTextFile(
        join(stateDir, ticketId, "20260101T000000-spec.md"),
        "spec output",
      );
      await run(["git", "add", "-A"]);
      await run(["git", "commit", "-m", "initial"]);
      await withReviewConfig(stateDir, async () => {
        const exitStub = stub(Deno, "exit", (_code?: number) => {
          throw new Error(`exit:${_code}`);
        });
        const errorStub = stub(console, "error");
        try {
          await review(ticketId, {
            isTerminal: () => false,
            readStdin: () => Promise.resolve("feedback text"),
          });
        } catch {
          // expected
        } finally {
          exitStub.restore();
          errorStub.restore();
        }
        const entries: string[] = [];
        for await (const entry of Deno.readDir(join(stateDir, ticketId))) {
          entries.push(entry.name);
        }
        assertFalse(entries.some((e) => e.endsWith("-feedback.md")));
      });
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "review: piped path accepts feedback on a merge-phase ticket with only an implementation output",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const ticketId = "github/test/repo/52";
      await initGitRepo(stateDir);
      const run = (cmd: string[]) =>
        new Deno.Command(cmd[0], { args: cmd.slice(1), cwd: stateDir })
          .output();
      await writeTicket(
        stateDir,
        makeTicket({
          id: ticketId,
          phase: "merge",
          status: "waiting",
        }),
      );
      await Deno.writeTextFile(
        join(stateDir, ticketId, "20260101T000000-implementation.md"),
        "implementation output",
      );
      await run(["git", "add", "-A"]);
      await run(["git", "commit", "-m", "initial"]);
      await withReviewConfig(stateDir, async () => {
        const exitStub = stub(Deno, "exit", (_code?: number) => {
          throw new Error(`exit:${_code}`);
        });
        const errorStub = stub(console, "error");
        try {
          await review(ticketId, {
            isTerminal: () => false,
            readStdin: () => Promise.resolve("feedback text"),
          });
        } catch {
          // expected: exitStub throws
        } finally {
          exitStub.restore();
          errorStub.restore();
        }
        assertSpyCalls(errorStub, 0);
        assertSpyCalls(exitStub, 1);
        assertEquals(exitStub.calls[0].args[0], 0);
        const entries: string[] = [];
        for await (const entry of Deno.readDir(join(stateDir, ticketId))) {
          entries.push(entry.name);
        }
        assert(entries.some((e) => e.endsWith("-merge-feedback.md")));
        const updated = await readTicket(stateDir, ticketId);
        assertEquals(updated.status, "revising");
      });
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

// ── renderTicketTab ───────────────────────────────────────────────────────────

function makeBaseTicket(): TicketState {
  return {
    id: "github/test/repo/1",
    provider: "github",
    title: "Test Ticket",
    url: "https://github.com/test/repo/issues/1",
    phase: "spec",
    status: "waiting",
    approvals: [],
    scope: ["test/repo"],
    worktrees: {},
    body: "Body text.",
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
    artifacts: ["code"],
  };
}

Deno.test("renderTicketTab: includes title as H1 heading", () => {
  const ticket = { ...makeBaseTicket(), title: "My Feature" };
  assertStringIncludes(renderTicketTab(ticket), "# My Feature");
});

Deno.test("renderTicketTab: includes URL line", () => {
  const ticket = makeBaseTicket();
  assertStringIncludes(
    renderTicketTab(ticket),
    "**URL:** https://github.com/test/repo/issues/1",
  );
});

Deno.test("renderTicketTab: includes phase and status on same line", () => {
  const ticket = {
    ...makeBaseTicket(),
    phase: "spec" as const,
    status: "waiting" as const,
  };
  const result = renderTicketTab(ticket);
  assertStringIncludes(result, "**Phase:** spec");
  assertStringIncludes(result, "**Status:** waiting");
});

Deno.test("renderTicketTab: includes scope entries as bullets", () => {
  const ticket = {
    ...makeBaseTicket(),
    scope: ["test/repo", "another/repo"],
  };
  const result = renderTicketTab(ticket);
  assertStringIncludes(result, "- test/repo");
  assertStringIncludes(result, "- another/repo");
});

Deno.test("renderTicketTab: includes approvals formatted as compactTimestamp — actor (phase)", () => {
  const ticket: TicketState = {
    ...makeBaseTicket(),
    approvals: [{
      timestamp: "2026-08-25T00:38:44Z",
      actor: "human",
      phase: "spec",
    }],
  };
  assertStringIncludes(
    renderTicketTab(ticket),
    "20260825T003844 — human (spec)",
  );
});

Deno.test("renderTicketTab: includes worktree entry as key: path (branch)", () => {
  const ticket: TicketState = {
    ...makeBaseTicket(),
    worktrees: {
      "test/repo": { path: "/home/user/worktrees/1", branch: "feature/1" },
    },
  };
  assertStringIncludes(
    renderTicketTab(ticket),
    "test/repo: /home/user/worktrees/1 (feature/1)",
  );
});

Deno.test("renderTicketTab: includes body text after horizontal rule", () => {
  const ticket = { ...makeBaseTicket(), body: "The problem description." };
  const result = renderTicketTab(ticket);
  assertStringIncludes(result, "The problem description.");
  assertStringIncludes(result, "---");
});

Deno.test("renderTicketTab: includes PRs section with URL when prs is non-empty", () => {
  const ticket: TicketState = {
    ...makeBaseTicket(),
    prs: [{
      url: "https://github.com/test/repo/pull/42",
      title: "Fix something",
      dependsOn: [],
      merged: false,
    }],
  };
  const result = renderTicketTab(ticket);
  assertStringIncludes(result, "**PRs:**");
  assertStringIncludes(result, "https://github.com/test/repo/pull/42");
});

Deno.test("renderTicketTab: omits PRs section when prs is empty array", () => {
  const ticket: TicketState = { ...makeBaseTicket(), prs: [] };
  assertFalse(renderTicketTab(ticket).includes("**PRs:**"));
});

Deno.test("renderTicketTab: omits PRs section when prs is absent", () => {
  const ticket = makeBaseTicket();
  assertFalse(renderTicketTab(ticket).includes("**PRs:**"));
});

Deno.test(
  "review: exits with code 1 and prints error when ticket is done",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const ticketId = "github/test/repo/3";
      await writeTicket(
        stateDir,
        makeTicket({ id: ticketId, phase: "merge", status: "done" }),
      );
      await withReviewConfig(stateDir, async () => {
        const exitStub = stub(Deno, "exit", (_code?: number) => {
          throw new Error(`exit:${_code}`);
        });
        const errorStub = stub(console, "error");
        try {
          await review(ticketId);
        } catch {
          // expected: exitStub throws
        } finally {
          exitStub.restore();
          errorStub.restore();
        }
        assertSpyCalls(exitStub, 1);
        assertEquals(exitStub.calls[0].args[0], 1);
        assertSpyCalls(errorStub, 1);
        assertEquals(
          errorStub.calls[0].args[0],
          `ticket ${ticketId} is done`,
        );
      });
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);
