import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { join } from "@std/path";
import { AgentsMdConsolidationCeremony } from "./agents-md-consolidation.ts";
import type { CommandRunner } from "../apfel.ts";

Deno.test(
  "AgentsMdConsolidationCeremony: skips and writes notice when AGENTS.md not found",
  async () => {
    const repoDir = await Deno.makeTempDir();
    const outputDir = await Deno.makeTempDir();
    try {
      const run: CommandRunner = spy((_args: string[]) =>
        Promise.resolve({ code: 0, stdout: "" })
      );
      const commitState = spy(() => Promise.resolve());
      const ceremony = new AgentsMdConsolidationCeremony({
        repoDir,
        run,
        commitState,
      });
      await ceremony.run(Temporal.Now.zonedDateTimeISO("UTC"), outputDir);
      assertSpyCalls(run as ReturnType<typeof spy>, 0);
      assertSpyCalls(commitState, 1);
      let outputContent = "";
      for await (const entry of Deno.readDir(outputDir)) {
        outputContent = await Deno.readTextFile(join(outputDir, entry.name));
      }
      assertStringIncludes(outputContent, "skipped: AGENTS.md not found");
    } finally {
      await Deno.remove(repoDir, { recursive: true });
      await Deno.remove(outputDir, { recursive: true });
    }
  },
);

Deno.test(
  "AgentsMdConsolidationCeremony: skips when pending branch exists",
  async () => {
    const repoDir = await Deno.makeTempDir();
    const outputDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(repoDir, "AGENTS.md"), "# Content\n");
      const capturedArgs: string[][] = [];
      const run: CommandRunner = spy((args: string[]) => {
        capturedArgs.push(args);
        if (args[0] === "git" && args[3] === "rev-parse") {
          return Promise.resolve({ code: 0, stdout: "" });
        }
        return Promise.resolve({ code: 0, stdout: "" });
      });
      const commitState = spy(() => Promise.resolve());
      const ceremony = new AgentsMdConsolidationCeremony({
        repoDir,
        run,
        commitState,
      });
      await ceremony.run(Temporal.Now.zonedDateTimeISO("UTC"), outputDir);
      assertEquals(capturedArgs.length, 1);
      assertEquals(capturedArgs[0][3], "rev-parse");
      assertSpyCalls(commitState, 1);
      let outputContent = "";
      for await (const entry of Deno.readDir(outputDir)) {
        outputContent = await Deno.readTextFile(join(outputDir, entry.name));
      }
      assertStringIncludes(outputContent, "skipped: pending PR");
    } finally {
      await Deno.remove(repoDir, { recursive: true });
      await Deno.remove(outputDir, { recursive: true });
    }
  },
);

Deno.test(
  "AgentsMdConsolidationCeremony: writes no changes notice when LLM returns NO_CHANGES",
  async () => {
    const repoDir = await Deno.makeTempDir();
    const outputDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(repoDir, "AGENTS.md"), "# Content\n");
      const run: CommandRunner = spy((args: string[]) => {
        if (args[0] === "git" && args[3] === "rev-parse") {
          return Promise.resolve({ code: 1, stdout: "" });
        }
        if (args[0] === "claude") {
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify({ result: "NO_CHANGES" }),
          });
        }
        return Promise.resolve({ code: 0, stdout: "" });
      });
      const commitState = spy(() => Promise.resolve());
      const ceremony = new AgentsMdConsolidationCeremony({
        repoDir,
        run,
        commitState,
      });
      await ceremony.run(Temporal.Now.zonedDateTimeISO("UTC"), outputDir);
      assertSpyCalls(commitState, 1);
      let outputContent = "";
      for await (const entry of Deno.readDir(outputDir)) {
        outputContent = await Deno.readTextFile(join(outputDir, entry.name));
      }
      assertStringIncludes(outputContent, "no changes needed");
    } finally {
      await Deno.remove(repoDir, { recursive: true });
      await Deno.remove(outputDir, { recursive: true });
    }
  },
);

Deno.test(
  "AgentsMdConsolidationCeremony: creates branch, commits, and opens PR when changes needed",
  async () => {
    const repoDir = await Deno.makeTempDir();
    const outputDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(repoDir, "AGENTS.md"),
        "# Line 1\n# Line 2\n# Line 3\n",
      );
      const capturedArgs: string[][] = [];
      const run: CommandRunner = spy((args: string[]) => {
        capturedArgs.push(args);
        if (args[0] === "git" && args[3] === "rev-parse") {
          return Promise.resolve({ code: 1, stdout: "" });
        }
        if (args[0] === "claude") {
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify({ result: "# Line 1\n# Line 2\n" }),
          });
        }
        if (args[0] === "git" && args[3] === "remote") {
          return Promise.resolve({
            code: 0,
            stdout: "https://github.com/jackjennings/lazyboy.git\n",
          });
        }
        if (args[0] === "gh") {
          return Promise.resolve({
            code: 0,
            stdout: "https://github.com/jackjennings/lazyboy/pull/42\n",
          });
        }
        return Promise.resolve({ code: 0, stdout: "" });
      });
      const commitState = spy(() => Promise.resolve());
      const ceremony = new AgentsMdConsolidationCeremony({
        repoDir,
        run,
        commitState,
      });
      await ceremony.run(Temporal.Now.zonedDateTimeISO("UTC"), outputDir);
      assertSpyCalls(commitState, 1);
      let outputContent = "";
      for await (const entry of Deno.readDir(outputDir)) {
        outputContent = await Deno.readTextFile(join(outputDir, entry.name));
      }
      assertStringIncludes(
        outputContent,
        "PR: https://github.com/jackjennings/lazyboy/pull/42",
      );
      assertStringIncludes(outputContent, "Lines before:");
      assertStringIncludes(outputContent, "Lines after:");
      assertStringIncludes(outputContent, "Lines removed:");
      const ghCall = capturedArgs.find((a) => a[0] === "gh");
      assertExists(ghCall);
      assertStringIncludes(ghCall.join("\0"), "--draft");
      assertStringIncludes(ghCall.join("\0"), "--repo\0jackjennings/lazyboy");
    } finally {
      await Deno.remove(repoDir, { recursive: true });
      await Deno.remove(outputDir, { recursive: true });
    }
  },
);

Deno.test(
  "AgentsMdConsolidationCeremony: cleans up branch and propagates error when push fails",
  async () => {
    const repoDir = await Deno.makeTempDir();
    const outputDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(repoDir, "AGENTS.md"), "# Content\n");
      const capturedArgs: string[][] = [];
      const run: CommandRunner = spy((args: string[]) => {
        capturedArgs.push(args);
        if (args[0] === "git" && args[3] === "rev-parse") {
          return Promise.resolve({ code: 1, stdout: "" });
        }
        if (args[0] === "claude") {
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify({ result: "# Consolidated\n" }),
          });
        }
        if (args[0] === "git" && args[3] === "push") {
          return Promise.resolve({ code: 1, stdout: "" });
        }
        return Promise.resolve({ code: 0, stdout: "" });
      });
      const commitState = spy(() => Promise.resolve());
      const ceremony = new AgentsMdConsolidationCeremony({
        repoDir,
        run,
        commitState,
      });
      await assertRejects(
        () => ceremony.run(Temporal.Now.zonedDateTimeISO("UTC"), outputDir),
        Error,
      );
      const checkoutMinus = capturedArgs.find(
        (a) => a[0] === "git" && a[3] === "checkout" && a[4] === "-",
      );
      assertExists(checkoutMinus);
      const branchDelete = capturedArgs.find(
        (a) => a[0] === "git" && a[3] === "branch" && a[4] === "-D",
      );
      assertExists(branchDelete);
      assertSpyCalls(commitState, 1);
      let outputContent = "";
      for await (const entry of Deno.readDir(outputDir)) {
        outputContent = await Deno.readTextFile(join(outputDir, entry.name));
      }
      assertStringIncludes(outputContent, "error:");
    } finally {
      await Deno.remove(repoDir, { recursive: true });
      await Deno.remove(outputDir, { recursive: true });
    }
  },
);

Deno.test(
  "AgentsMdConsolidationCeremony: writes error and does not throw when LLM call fails",
  async () => {
    const repoDir = await Deno.makeTempDir();
    const outputDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(repoDir, "AGENTS.md"), "# Content\n");
      const run: CommandRunner = spy((args: string[]) => {
        if (args[0] === "git" && args[3] === "rev-parse") {
          return Promise.resolve({ code: 1, stdout: "" });
        }
        if (args[0] === "claude") {
          return Promise.resolve({ code: 1, stdout: "" });
        }
        return Promise.resolve({ code: 0, stdout: "" });
      });
      const commitState = spy(() => Promise.resolve());
      const ceremony = new AgentsMdConsolidationCeremony({
        repoDir,
        run,
        commitState,
      });
      await ceremony.run(Temporal.Now.zonedDateTimeISO("UTC"), outputDir);
      assertSpyCalls(commitState, 1);
      let outputContent = "";
      for await (const entry of Deno.readDir(outputDir)) {
        outputContent = await Deno.readTextFile(join(outputDir, entry.name));
      }
      assertStringIncludes(outputContent, "error: LLM call failed");
    } finally {
      await Deno.remove(repoDir, { recursive: true });
      await Deno.remove(outputDir, { recursive: true });
    }
  },
);

Deno.test(
  "AgentsMdConsolidationCeremony: passes claude-sonnet-4-6 model to LLM",
  async () => {
    const repoDir = await Deno.makeTempDir();
    const outputDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(repoDir, "AGENTS.md"), "# Content\n");
      const capturedArgs: string[][] = [];
      const run: CommandRunner = spy((args: string[]) => {
        capturedArgs.push(args);
        if (args[0] === "git" && args[3] === "rev-parse") {
          return Promise.resolve({ code: 1, stdout: "" });
        }
        return Promise.resolve({ code: 0, stdout: "NO_CHANGES" });
      });
      const ceremony = new AgentsMdConsolidationCeremony({
        repoDir,
        run,
        commitState: () => Promise.resolve(),
      });
      await ceremony.run(Temporal.Now.zonedDateTimeISO("UTC"), outputDir);
      const claudeCall = capturedArgs.find((a) => a[0] === "claude");
      assertExists(claudeCall);
      const modelIdx = claudeCall.indexOf("--model");
      assertEquals(claudeCall[modelIdx + 1], "claude-sonnet-4-6");
    } finally {
      await Deno.remove(repoDir, { recursive: true });
      await Deno.remove(outputDir, { recursive: true });
    }
  },
);
