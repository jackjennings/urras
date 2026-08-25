import {
  assertArrayIncludes,
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { OllamaLanguageModel } from "./models/ollama.ts";
import { filterPrinciples, judgePrinciples } from "./judge-principles.ts";
import type { CommandRunner } from "./apfel.ts";

const KEEP_LOCAL = JSON.stringify({ verdict: "KEEP_LOCAL" });
const KEEP_GLOBAL = JSON.stringify({ verdict: "KEEP_GLOBAL" });
const SKIP = JSON.stringify({ verdict: "SKIP" });

function runner(
  handler: (args: string[]) => { code: number; stdout: string },
): CommandRunner {
  return spy((args: string[]) => Promise.resolve(handler(args)));
}

function apfelUnavailable(claudeStdout: string) {
  return (args: string[]) =>
    args[0] === "apfel"
      ? { code: 1, stdout: "" }
      : { code: 0, stdout: claudeStdout };
}

function alwaysReturn(stdout: string) {
  return (_args: string[]) => ({ code: 0, stdout });
}

function callArgs(run: CommandRunner, index: number): string[] {
  return (run as ReturnType<typeof spy>).calls[index].args[0] as string[];
}

Deno.test("judgePrinciples: calls claude CLI when apfel exits non-zero, returns 'local' on KEEP_LOCAL", async () => {
  const run = runner(apfelUnavailable(KEEP_LOCAL));
  assertEquals(await judgePrinciples("- prefer X over Y", run), "local");
  assertSpyCalls(run as ReturnType<typeof spy>, 2);
});

Deno.test("judgePrinciples: returns null when claude CLI returns SKIP", async () => {
  const run = runner(apfelUnavailable(SKIP));
  assertEquals(await judgePrinciples("_(nothing meets bar)_", run), null);
});

Deno.test("judgePrinciples: returns null when claude CLI exits non-zero", async () => {
  const run = runner(() => ({ code: 1, stdout: "" }));
  assertEquals(await judgePrinciples("- prefer X over Y", run), null);
});

Deno.test("judgePrinciples: returns null when claude CLI throws", async () => {
  const run: CommandRunner = spy((_args: string[]) =>
    Promise.reject(new Error("not found"))
  );
  assertEquals(await judgePrinciples("- prefer X over Y", run), null);
});

Deno.test("judgePrinciples: returns null when claude CLI output is not valid verdict JSON", async () => {
  const run = runner(apfelUnavailable("KEEP, definitely"));
  assertEquals(await judgePrinciples("- prefer X over Y", run), null);
});

Deno.test("judgePrinciples: passes body to claude CLI after a -- separator", async () => {
  const run = runner(apfelUnavailable(KEEP_LOCAL));
  await judgePrinciples("- prefer X over Y", run);
  const args = callArgs(run, 1);
  assertEquals(args[0], "claude");
  assertEquals(args[args.length - 2], "--");
  assertEquals(args[args.length - 1], "- prefer X over Y");
});

Deno.test("judgePrinciples: passes --model claude-haiku-4-5 to claude CLI", async () => {
  const run = runner(apfelUnavailable(KEEP_LOCAL));
  await judgePrinciples("- prefer X over Y", run);
  const args = callArgs(run, 1);
  const modelIndex = args.indexOf("--model");
  assertNotEquals(modelIndex, -1);
  assertEquals(args[modelIndex + 1], "claude-haiku-4-5");
});

Deno.test("judgePrinciples: passes the verdict schema inline to claude CLI", async () => {
  const run = runner(apfelUnavailable(KEEP_LOCAL));
  await judgePrinciples("- prefer X over Y", run);
  const args = callArgs(run, 1);
  const schemaIndex = args.indexOf("--json-schema");
  assertNotEquals(schemaIndex, -1);
  const schema = JSON.parse(args[schemaIndex + 1]);
  assertArrayIncludes(schema.required, ["verdict"]);
  assertArrayIncludes(schema.properties.verdict.enum, [
    "KEEP_LOCAL",
    "KEEP_GLOBAL",
    "SKIP",
  ]);
});

Deno.test("judgePrinciples: uses apfel first, returns 'local' on KEEP_LOCAL without calling claude", async () => {
  const run = runner(alwaysReturn(KEEP_LOCAL));
  assertEquals(await judgePrinciples("- prefer X over Y", run), "local");
  assertSpyCalls(run as ReturnType<typeof spy>, 1);
  assertEquals(callArgs(run, 0)[0], "apfel");
});

Deno.test("judgePrinciples: uses apfel first, returns null on SKIP without calling claude", async () => {
  const run = runner(alwaysReturn(SKIP));
  assertEquals(await judgePrinciples("_(nothing)_", run), null);
  assertSpyCalls(run as ReturnType<typeof spy>, 1);
});

Deno.test("judgePrinciples: returns 'global' on KEEP_GLOBAL from apfel", async () => {
  const run = runner(alwaysReturn(KEEP_GLOBAL));
  assertEquals(await judgePrinciples("- prefer X over Y", run), "global");
  assertSpyCalls(run as ReturnType<typeof spy>, 1);
});

Deno.test("judgePrinciples: passes body to apfel after a -- separator", async () => {
  const run = runner(alwaysReturn(KEEP_LOCAL));
  await judgePrinciples("- prefer X over Y", run);
  const args = callArgs(run, 0);
  assertEquals(args[args.length - 2], "--");
  assertEquals(args[args.length - 1], "- prefer X over Y");
});

Deno.test("judgePrinciples: tolerates surrounding whitespace in apfel JSON output", async () => {
  const run = runner(alwaysReturn(`\n${KEEP_LOCAL}\n`));
  assertEquals(await judgePrinciples("- prefer X over Y", run), "local");
});

Deno.test("judgePrinciples: falls through to claude when apfel output is not valid verdict JSON", async () => {
  const run = runner((args) =>
    args[0] === "apfel"
      ? { code: 0, stdout: "**KEEP**" }
      : { code: 0, stdout: KEEP_LOCAL }
  );
  assertEquals(await judgePrinciples("- prefer X over Y", run), "local");
  assertSpyCalls(run as ReturnType<typeof spy>, 2);
});

Deno.test("judgePrinciples: passes apfel a schema file holding the verdict schema", async () => {
  let schemaPath = "";
  let schemaContent = "";
  const run = runner((args) => {
    if (args[0] === "apfel") {
      schemaPath = args[args.indexOf("--schema") + 1];
      schemaContent = Deno.readTextFileSync(schemaPath);
    }
    return { code: 0, stdout: KEEP_LOCAL };
  });
  await judgePrinciples("- prefer X over Y", run);

  const schema = JSON.parse(schemaContent);
  assertArrayIncludes(schema.required, ["verdict"]);
  assertArrayIncludes(schema.properties.verdict.enum, [
    "KEEP_LOCAL",
    "KEEP_GLOBAL",
    "SKIP",
  ]);
  await assertRejects(() => Deno.stat(schemaPath), Deno.errors.NotFound);
});

// ── filterPrinciples ──────────────────────────────────────────────────────────

Deno.test("filterPrinciples: returns indices from LLM response", async () => {
  const run = runner(alwaysReturn(JSON.stringify({ indices: [2, 0] })));
  const result = await filterPrinciples(
    ["- A", "- B", "- C"],
    "context",
    5,
    run,
  );
  assertEquals(result, [2, 0]);
});

Deno.test("filterPrinciples: returns null when all LLM calls fail", async () => {
  const run: CommandRunner = spy(() =>
    Promise.resolve({ code: 1, stdout: "" })
  );
  assertEquals(await filterPrinciples(["- A"], "ctx", 5, run), null);
});

Deno.test("filterPrinciples: returns null when response indices is not an array", async () => {
  const run = runner(alwaysReturn(JSON.stringify({ indices: "wrong" })));
  assertEquals(await filterPrinciples(["- A"], "ctx", 5, run), null);
});

Deno.test("filterPrinciples: returns null when result object has no indices field", async () => {
  const run = runner(alwaysReturn(JSON.stringify({ verdict: "KEEP" })));
  assertEquals(await filterPrinciples(["- A"], "ctx", 5, run), null);
});

Deno.test("filterPrinciples: filters out-of-bounds indices from response", async () => {
  const run = runner(alwaysReturn(JSON.stringify({ indices: [0, 5, -1] })));
  const result = await filterPrinciples(["- A", "- B", "- C"], "ctx", 5, run);
  assertEquals(result, [0]);
});

Deno.test("filterPrinciples: returns empty array when all returned indices are out of bounds", async () => {
  const run = runner(alwaysReturn(JSON.stringify({ indices: [99] })));
  assertEquals(await filterPrinciples(["- A"], "ctx", 5, run), []);
});

Deno.test("filterPrinciples: deduplicates repeated indices", async () => {
  const run = runner(alwaysReturn(JSON.stringify({ indices: [0, 0, 1] })));
  const result = await filterPrinciples(["- A", "- B"], "ctx", 5, run);
  assertEquals(result?.length, 2);
});

Deno.test("filterPrinciples: caps results to topK", async () => {
  const entries = Array.from({ length: 10 }, (_, i) => `- e${i}`);
  const run = runner(
    alwaysReturn(JSON.stringify({ indices: [0, 1, 2, 3, 4, 5, 6] })),
  );
  const result = await filterPrinciples(entries, "ctx", 3, run);
  assertEquals(result?.length, 3);
});

Deno.test("filterPrinciples: uses FallbackLanguageModel, tries apfel first then claude", async () => {
  const run = runner(apfelUnavailable(JSON.stringify({ indices: [0] })));
  assertNotEquals(await filterPrinciples(["- A"], "ctx", 5, run), null);
  assertSpyCalls(run as ReturnType<typeof spy>, 2);
  assertEquals(callArgs(run, 0)[0], "apfel");
  assertEquals(callArgs(run, 1)[0], "claude");
});

Deno.test("filterPrinciples: includes context and numbered entries in prompt", async () => {
  const run = runner(alwaysReturn(JSON.stringify({ indices: [] })));
  await filterPrinciples(["- entry A", "- entry B"], "ticket context", 5, run);
  const args = callArgs(run, 0);
  const promptArg = args[args.length - 1];
  assertStringIncludes(promptArg, "ticket context");
  assertStringIncludes(promptArg, "0: - entry A");
  assertStringIncludes(promptArg, "1: - entry B");
});

Deno.test("filterPrinciples: returns null when LLM throws", async () => {
  const run: CommandRunner = spy(() =>
    Promise.reject(new Error("spawn failed"))
  );
  assertEquals(await filterPrinciples(["- A"], "ctx", 5, run), null);
});

Deno.test("filterPrinciples: does not include non-integer indices", async () => {
  const run = runner(alwaysReturn(JSON.stringify({ indices: [0.5, 1] })));
  const result = await filterPrinciples(["- A", "- B"], "ctx", 5, run);
  assertEquals(result, [1]);
});

Deno.test("filterPrinciples: assertFalse indices includes non-integer", async () => {
  const run = runner(alwaysReturn(JSON.stringify({ indices: [0, 1] })));
  const result = await filterPrinciples(["- A", "- B"], "ctx", 5, run);
  assertFalse(result === null);
});

function makeOllama(responseBody: string): OllamaLanguageModel {
  const _fetch = spy(
    (_url: unknown, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ response: responseBody }), {
          status: 200,
        }),
      ),
  ) as unknown as typeof fetch;
  return new OllamaLanguageModel(_fetch, { model: "test" });
}

Deno.test("judgePrinciples: uses ollamaModels before Claude when apfel fails", async () => {
  const ollama = makeOllama(JSON.stringify({ verdict: "KEEP_GLOBAL" }));
  let claudeCalled = false;
  const run = spy((args: string[]) => {
    if (args[0] === "claude") claudeCalled = true;
    return Promise.resolve({ code: 1, stdout: "" });
  });
  const result = await judgePrinciples("some principle", run, [ollama]);
  assertEquals(result, "global");
  assertFalse(claudeCalled);
});

Deno.test("filterPrinciples: uses ollamaModels before Claude when apfel fails", async () => {
  const ollama = makeOllama(JSON.stringify({ indices: [1] }));
  const run = spy((_args: string[]) =>
    Promise.resolve({ code: 1, stdout: "" })
  );
  const result = await filterPrinciples(
    ["first", "second", "third"],
    "context",
    1,
    run,
    [ollama],
  );
  assertEquals(result, [1]);
});
