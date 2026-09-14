import {
  assertArrayIncludes,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import type { CommandRunner } from "./apfel.ts";
import { extractIntakeArtifacts } from "./extract-artifacts.ts";

function runner(
  handler: (args: string[]) => { code: number; stdout: string },
): CommandRunner {
  return spy((args: string[]) => Promise.resolve(handler(args)));
}

function apfelUnavailable(claudeResult: string) {
  return (args: string[]) =>
    args[0] === "apfel"
      ? { code: 1, stdout: "" }
      : { code: 0, stdout: JSON.stringify({ result: claudeResult }) };
}

function alwaysReturn(stdout: string) {
  return (_args: string[]) => ({ code: 0, stdout });
}

function callArgs(run: CommandRunner, index: number): string[] {
  return (run as ReturnType<typeof spy>).calls[index].args[0] as string[];
}

Deno.test(
  "extractIntakeArtifacts: returns [] when all LLM calls fail",
  async () => {
    const run: CommandRunner = spy(() =>
      Promise.resolve({ code: 1, stdout: "" })
    );
    assertEquals(await extractIntakeArtifacts("some intake content", run), []);
  },
);

Deno.test(
  "extractIntakeArtifacts: returns single artifact type from LLM response",
  async () => {
    const run = runner(
      alwaysReturn(JSON.stringify({ artifacts: ["document"] })),
    );
    assertEquals(
      await extractIntakeArtifacts("intake mentioning Notion page", run),
      ["document"],
    );
  },
);

Deno.test(
  "extractIntakeArtifacts: returns multiple artifact types from LLM response",
  async () => {
    const run = runner(
      alwaysReturn(JSON.stringify({ artifacts: ["code", "document"] })),
    );
    assertEquals(
      await extractIntakeArtifacts("intake mentioning code and document", run),
      ["code", "document"],
    );
  },
);

Deno.test(
  "extractIntakeArtifacts: returns [] when LLM returns invalid JSON",
  async () => {
    const run = runner(apfelUnavailable("not valid json"));
    assertEquals(await extractIntakeArtifacts("some content", run), []);
  },
);

Deno.test(
  "extractIntakeArtifacts: falls through to claude when apfel exits non-zero",
  async () => {
    const run = runner(
      apfelUnavailable(JSON.stringify({ artifacts: ["document"] })),
    );
    assertEquals(
      await extractIntakeArtifacts("intake content", run),
      ["document"],
    );
    assertSpyCalls(run as ReturnType<typeof spy>, 2);
    assertEquals(callArgs(run, 0)[0], "apfel");
    assertEquals(callArgs(run, 1)[0], "claude");
  },
);

Deno.test(
  "extractIntakeArtifacts: uses apfel first when available",
  async () => {
    const run = runner(alwaysReturn(JSON.stringify({ artifacts: ["work"] })));
    assertEquals(await extractIntakeArtifacts("intake content", run), ["work"]);
    assertSpyCalls(run as ReturnType<typeof spy>, 1);
    assertEquals(callArgs(run, 0)[0], "apfel");
  },
);

Deno.test(
  "extractIntakeArtifacts: filters out types not in ARTIFACT_DESCRIPTORS",
  async () => {
    const run = runner(
      alwaysReturn(JSON.stringify({ artifacts: ["document", "notion"] })),
    );
    assertEquals(
      await extractIntakeArtifacts("intake content", run),
      ["document"],
    );
  },
);

Deno.test(
  "extractIntakeArtifacts: passes intake content to LLM",
  async () => {
    const run = runner(alwaysReturn(JSON.stringify({ artifacts: ["code"] })));
    const content = "## Artifact type\n\nThis ticket produces a document.";
    await extractIntakeArtifacts(content, run);
    const args = callArgs(run, 0);
    assertStringIncludes(args[args.length - 1], content);
  },
);

Deno.test(
  "extractIntakeArtifacts: schema includes code, document, work as valid enum values",
  async () => {
    const run = runner(
      apfelUnavailable(JSON.stringify({ artifacts: ["code"] })),
    );
    await extractIntakeArtifacts("intake content", run);
    const args = callArgs(run, 1);
    const schemaIdx = args.indexOf("--json-schema");
    const schema = JSON.parse(args[schemaIdx + 1]);
    assertArrayIncludes(schema.properties.artifacts.items.enum, [
      "code",
      "document",
      "work",
    ]);
  },
);

Deno.test(
  "extractIntakeArtifacts: uses claude-haiku-4-5 as fallback model",
  async () => {
    const run = runner(
      apfelUnavailable(JSON.stringify({ artifacts: ["code"] })),
    );
    await extractIntakeArtifacts("intake content", run);
    const args = callArgs(run, 1);
    const modelIdx = args.indexOf("--model");
    assertNotEquals(modelIdx, -1);
    assertEquals(args[modelIdx + 1], "claude-haiku-4-5");
  },
);
