import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { join } from "@std/path";
import { DocumentationGapsCeremony } from "./documentation-gaps.ts";
import type { CommandRunner } from "../apfel.ts";
import { compactTimestamp } from "../timestamp.ts";

async function writeEnrichment(options: {
  stateDir: string;
  ticketNumber: number;
  timestamp: string;
  body: string;
}): Promise<void> {
  const ticketDir = join(
    options.stateDir,
    "github",
    "org",
    "repo",
    String(options.ticketNumber),
  );
  await Deno.mkdir(ticketDir, { recursive: true });
  await Deno.writeTextFile(
    join(ticketDir, `${options.timestamp}-enrichment.md`),
    `## Open Questions\n\n${options.body}\n`,
  );
}

async function writeRecentEnrichments(stateDir: string): Promise<void> {
  const timestamp = compactTimestamp(Temporal.Now.zonedDateTimeISO("UTC"));
  for (const ticketNumber of [1, 2, 3]) {
    await writeEnrichment({
      stateDir,
      ticketNumber,
      timestamp,
      body: "How does auth work?",
    });
  }
}

Deno.test("DocumentationGapsCeremony: calls run when open questions are present", async () => {
  const stateDir = await Deno.makeTempDir();
  const repoDir = await Deno.makeTempDir();
  const outputDir = await Deno.makeTempDir();
  try {
    await writeRecentEnrichments(stateDir);
    const run: CommandRunner = spy((_args: string[]) =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ result: "## Gap\n\n**Occurrences:** 1\n" }),
      })
    );
    const ceremony = new DocumentationGapsCeremony({
      stateDir,
      repoDir,
      run,
      commitState: () => Promise.resolve(),
    });
    await ceremony.run(Temporal.Now.zonedDateTimeISO("UTC"), outputDir);
    assertSpyCalls(run as ReturnType<typeof spy>, 1);
    let outputContent = "";
    for await (const entry of Deno.readDir(outputDir)) {
      outputContent = await Deno.readTextFile(join(outputDir, entry.name));
    }
    assertStringIncludes(outputContent, "## Gap");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(outputDir, { recursive: true });
  }
});

Deno.test("DocumentationGapsCeremony: writes error report when run exits non-zero", async () => {
  const stateDir = await Deno.makeTempDir();
  const repoDir = await Deno.makeTempDir();
  const outputDir = await Deno.makeTempDir();
  try {
    await writeRecentEnrichments(stateDir);
    const run: CommandRunner = spy((_args: string[]) =>
      Promise.resolve({ code: 1, stdout: "" })
    );
    const ceremony = new DocumentationGapsCeremony({
      stateDir,
      repoDir,
      run,
      commitState: () => Promise.resolve(),
    });
    await ceremony.run(Temporal.Now.zonedDateTimeISO("UTC"), outputDir);
    let outputContent = "";
    for await (const entry of Deno.readDir(outputDir)) {
      outputContent = await Deno.readTextFile(join(outputDir, entry.name));
    }
    assertStringIncludes(outputContent, "Error: LLM call failed.");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(outputDir, { recursive: true });
  }
});

Deno.test("DocumentationGapsCeremony: passes correct model and flags to claude", async () => {
  const stateDir = await Deno.makeTempDir();
  const repoDir = await Deno.makeTempDir();
  const outputDir = await Deno.makeTempDir();
  try {
    await writeRecentEnrichments(stateDir);
    let capturedArgs: string[] = [];
    const run: CommandRunner = spy((args: string[]) => {
      capturedArgs = args;
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ result: "NO_GAPS" }),
      });
    });
    const ceremony = new DocumentationGapsCeremony({
      stateDir,
      repoDir,
      run,
      commitState: () => Promise.resolve(),
    });
    await ceremony.run(Temporal.Now.zonedDateTimeISO("UTC"), outputDir);
    assertEquals(capturedArgs[0], "claude");
    const modelIdx = capturedArgs.indexOf("--model");
    assertNotEquals(modelIdx, -1);
    assertEquals(capturedArgs[modelIdx + 1], "claude-sonnet-4-6");
    const fmtIdx = capturedArgs.indexOf("--output-format");
    assertNotEquals(fmtIdx, -1);
    assertEquals(capturedArgs[fmtIdx + 1], "json");
    assertStringIncludes(capturedArgs.join("\0"), "--tools\0");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(outputDir, { recursive: true });
  }
});

Deno.test("DocumentationGapsCeremony: writes no-gaps report when run returns NO_GAPS", async () => {
  const stateDir = await Deno.makeTempDir();
  const repoDir = await Deno.makeTempDir();
  const outputDir = await Deno.makeTempDir();
  try {
    await writeRecentEnrichments(stateDir);
    const run: CommandRunner = spy((_args: string[]) =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ result: "NO_GAPS" }),
      })
    );
    const ceremony = new DocumentationGapsCeremony({
      stateDir,
      repoDir,
      run,
      commitState: () => Promise.resolve(),
    });
    await ceremony.run(Temporal.Now.zonedDateTimeISO("UTC"), outputDir);
    let outputContent = "";
    for await (const entry of Deno.readDir(outputDir)) {
      outputContent = await Deno.readTextFile(join(outputDir, entry.name));
    }
    assertStringIncludes(outputContent, "No uncovered gaps found.");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(outputDir, { recursive: true });
  }
});

Deno.test("DocumentationGapsCeremony: does not call run when no open questions exist", async () => {
  const stateDir = await Deno.makeTempDir();
  const repoDir = await Deno.makeTempDir();
  const outputDir = await Deno.makeTempDir();
  try {
    const run: CommandRunner = spy((_args: string[]) =>
      Promise.resolve({ code: 0, stdout: "" })
    );
    const ceremony = new DocumentationGapsCeremony({
      stateDir,
      repoDir,
      run,
      commitState: () => Promise.resolve(),
    });
    await ceremony.run(Temporal.Now.zonedDateTimeISO("UTC"), outputDir);
    assertSpyCalls(run as ReturnType<typeof spy>, 0);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(outputDir, { recursive: true });
  }
});

Deno.test("DocumentationGapsCeremony: ignores open questions older than the window", async () => {
  const stateDir = await Deno.makeTempDir();
  const repoDir = await Deno.makeTempDir();
  const outputDir = await Deno.makeTempDir();
  try {
    const stale = compactTimestamp(
      Temporal.Now.zonedDateTimeISO("UTC").subtract({ days: 60 }),
    );
    for (const ticketNumber of [1, 2, 3]) {
      await writeEnrichment({
        stateDir,
        ticketNumber,
        timestamp: stale,
        body: "Old question?",
      });
    }
    const run: CommandRunner = spy((_args: string[]) =>
      Promise.resolve({ code: 0, stdout: "" })
    );
    const ceremony = new DocumentationGapsCeremony({
      stateDir,
      repoDir,
      run,
      commitState: () => Promise.resolve(),
    });
    await ceremony.run(Temporal.Now.zonedDateTimeISO("UTC"), outputDir);
    assertSpyCalls(run as ReturnType<typeof spy>, 0);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(outputDir, { recursive: true });
  }
});

Deno.test("DocumentationGapsCeremony: does not call run for fewer than three tickets", async () => {
  const stateDir = await Deno.makeTempDir();
  const repoDir = await Deno.makeTempDir();
  const outputDir = await Deno.makeTempDir();
  try {
    const timestamp = compactTimestamp(Temporal.Now.zonedDateTimeISO("UTC"));
    for (const ticketNumber of [1, 2]) {
      await writeEnrichment({
        stateDir,
        ticketNumber,
        timestamp,
        body: "Why?",
      });
    }
    const run: CommandRunner = spy((_args: string[]) =>
      Promise.resolve({ code: 0, stdout: "" })
    );
    const ceremony = new DocumentationGapsCeremony({
      stateDir,
      repoDir,
      run,
      commitState: () => Promise.resolve(),
    });
    await ceremony.run(Temporal.Now.zonedDateTimeISO("UTC"), outputDir);
    assertSpyCalls(run as ReturnType<typeof spy>, 0);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(outputDir, { recursive: true });
  }
});
