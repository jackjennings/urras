import { assertEquals, assertStringIncludes } from "@std/assert";
import { spy } from "@std/testing/mock";
import type { CommandRunner } from "./apfel.ts";
import { extractIntakePipeline } from "./extract-pipeline.ts";

function runner(
  handler: (args: string[]) => { code: number; stdout: string },
): CommandRunner {
  return spy((args: string[]) => Promise.resolve(handler(args)));
}

function alwaysReturn(stdout: string) {
  return (_args: string[]) => ({ code: 0, stdout });
}

function callArgs(run: CommandRunner, index: number): string[] {
  return (run as ReturnType<typeof spy>).calls[index].args[0] as string[];
}

Deno.test("extractIntakePipeline: returns null when availableNames is empty, without calling the LLM", async () => {
  const run = runner(alwaysReturn(JSON.stringify({ pipeline: "fast" })));
  assertEquals(await extractIntakePipeline("some content", run, []), null);
  assertEquals((run as ReturnType<typeof spy>).calls.length, 0);
});

Deno.test("extractIntakePipeline: returns the requested name when it is in availableNames", async () => {
  const run = runner(alwaysReturn(JSON.stringify({ pipeline: "fast" })));
  assertEquals(
    await extractIntakePipeline("## Pipeline\n\npipeline: fast", run, [
      "fast",
    ]),
    "fast",
  );
});

Deno.test("extractIntakePipeline: returns null when the LLM's name is not in availableNames", async () => {
  const run = runner(alwaysReturn(JSON.stringify({ pipeline: "made-up" })));
  assertEquals(
    await extractIntakePipeline("intake content", run, ["fast"]),
    null,
  );
});

Deno.test("extractIntakePipeline: returns null when the LLM reports no pipeline requested", async () => {
  const run = runner(alwaysReturn(JSON.stringify({ pipeline: null })));
  assertEquals(
    await extractIntakePipeline(
      "intake content with no Pipeline section",
      run,
      [
        "fast",
      ],
    ),
    null,
  );
});

Deno.test("extractIntakePipeline: returns null when all LLM calls fail", async () => {
  const run: CommandRunner = spy(() =>
    Promise.resolve({ code: 1, stdout: "" })
  );
  assertEquals(
    await extractIntakePipeline("intake content", run, ["fast"]),
    null,
  );
});

Deno.test("extractIntakePipeline: passes intake content to the LLM", async () => {
  const run = runner(alwaysReturn(JSON.stringify({ pipeline: null })));
  const content = "## Pipeline\n\npipeline: fast\nreason: trivial change";
  await extractIntakePipeline(content, run, ["fast"]);
  const args = callArgs(run, 0);
  assertStringIncludes(args[args.length - 1], content);
});

Deno.test("extractIntakePipeline: uses claude-haiku-4-5 as fallback model", async () => {
  const run = runner((args) =>
    args[0] === "apfel"
      ? { code: 1, stdout: "" }
      : { code: 0, stdout: JSON.stringify({ pipeline: null }) }
  );
  await extractIntakePipeline("intake content", run, ["fast"]);
  const args = callArgs(run, 1);
  const modelIdx = args.indexOf("--model");
  assertEquals(args[modelIdx + 1], "claude-haiku-4-5");
});
