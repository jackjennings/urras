import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { join } from "@std/path";
import { DocumentationGapsCeremony } from "./documentation-gaps.ts";
import type { CommandRunner } from "../apfel.ts";

Deno.test("DocumentationGapsCeremony: calls run when open questions are present", async () => {
  const stateDir = await Deno.makeTempDir();
  const repoDir = await Deno.makeTempDir();
  const outputDir = await Deno.makeTempDir();
  try {
    const ticketDir = join(stateDir, "github", "org", "repo", "1");
    await Deno.mkdir(ticketDir, { recursive: true });
    await Deno.writeTextFile(
      join(ticketDir, "20260101T000000-enrichment.md"),
      "## Open Questions\n\nWhy does X work this way?\n",
    );
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
    const ticketDir = join(stateDir, "github", "org", "repo", "2");
    await Deno.mkdir(ticketDir, { recursive: true });
    await Deno.writeTextFile(
      join(ticketDir, "20260101T000000-enrichment.md"),
      "## Open Questions\n\nWhat is the purpose?\n",
    );
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
    const ticketDir = join(stateDir, "github", "org", "repo", "3");
    await Deno.mkdir(ticketDir, { recursive: true });
    await Deno.writeTextFile(
      join(ticketDir, "20260101T000000-enrichment.md"),
      "## Open Questions\n\nHow does auth work?\n",
    );
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
    const ticketDir = join(stateDir, "github", "org", "repo", "4");
    await Deno.mkdir(ticketDir, { recursive: true });
    await Deno.writeTextFile(
      join(ticketDir, "20260101T000000-enrichment.md"),
      "## Open Questions\n\nAny gaps?\n",
    );
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
