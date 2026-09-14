import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { applyLearning } from "./apply-learning.ts";
import type { CommandRunner } from "./apfel.ts";

function runnerReturning(text: string, code = 0): CommandRunner {
  return spy((_args: string[]) =>
    Promise.resolve({
      code,
      stdout: code === 0 ? JSON.stringify({ result: text }) : "",
    })
  );
}

const CURRENT = "# Implementation\n\nDo the thing.\n";
const INTENT =
  "Add an instruction to enumerate all call sites before renaming.";

Deno.test("applyLearning: returns document wrapped in updated-file tags", async () => {
  const placed =
    "# Implementation\n\nDo the thing.\n\nEnumerate all call sites first.\n";
  const result = await applyLearning(
    CURRENT,
    INTENT,
    runnerReturning(`<updated-file>${placed}</updated-file>`),
  );
  assertEquals(result, placed);
});

Deno.test("applyLearning: falls back to trimmed text when tags are absent", async () => {
  const placed =
    "# Implementation\n\nDo the thing.\n\nEnumerate all call sites first.";
  const result = await applyLearning(
    CURRENT,
    INTENT,
    runnerReturning(`\n${placed}\n`),
  );
  assertEquals(result, `${placed}\n`);
});

Deno.test("applyLearning: passes current document and intent after -- to claude", async () => {
  const run = runnerReturning("<updated-file>x</updated-file>");
  await applyLearning(CURRENT, INTENT, run);
  const args = (run as ReturnType<typeof spy>).calls[0].args[0] as string[];
  assertEquals(args[0], "claude");
  const prompt = args[args.length - 1];
  assertStringIncludes(prompt, INTENT);
  assertStringIncludes(prompt, "Do the thing.");
  assertSpyCalls(run as ReturnType<typeof spy>, 1);
});

Deno.test("applyLearning: returns null when claude CLI exits non-zero", async () => {
  const result = await applyLearning(CURRENT, INTENT, runnerReturning("", 1));
  assertEquals(result, null);
});

Deno.test("applyLearning: returns null when run throws", async () => {
  const run: CommandRunner = spy((_args: string[]) =>
    Promise.reject(new Error("not found"))
  );
  const result = await applyLearning(CURRENT, INTENT, run);
  assertEquals(result, null);
});

Deno.test("applyLearning: returns null when claude returns empty text", async () => {
  const result = await applyLearning(CURRENT, INTENT, runnerReturning("   "));
  assertEquals(result, null);
});

Deno.test("applyLearning: passes --model claude-sonnet-4-6 to claude", async () => {
  const run = runnerReturning("<updated-file>x</updated-file>");
  await applyLearning(CURRENT, INTENT, run);
  const args = (run as ReturnType<typeof spy>).calls[0].args[0] as string[];
  const modelIdx = args.indexOf("--model");
  assertNotEquals(modelIdx, -1);
  assertEquals(args[modelIdx + 1], "claude-sonnet-4-6");
});
