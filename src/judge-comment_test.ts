import { assertEquals, assertFalse } from "@std/assert";
import { spy } from "@std/testing/mock";
import { OllamaLanguageModel } from "./models/ollama.ts";
import { judgeComment } from "./judge-comment.ts";

Deno.test("judgeComment: returns true when model returns KEEP", async () => {
  const run = (args: string[]) =>
    args[0] === "apfel"
      ? Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ verdict: "KEEP" }),
      })
      : Promise.resolve({ code: 1, stdout: "" });
  assertEquals(await judgeComment("Substantive technical info", run), true);
});

Deno.test("judgeComment: returns false when model returns SKIP", async () => {
  const run = (args: string[]) =>
    args[0] === "apfel"
      ? Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ verdict: "SKIP" }),
      })
      : Promise.resolve({ code: 1, stdout: "" });
  assertEquals(await judgeComment("Any update?", run), false);
});

Deno.test("judgeComment: defaults to KEEP when both models fail", async () => {
  const run = () => Promise.resolve({ code: 1, stdout: "" });
  assertEquals(await judgeComment("Some comment", run), true);
});

Deno.test("judgeComment: uses ollamaModels before Claude when apfel fails", async () => {
  const ollamaFetch = spy(
    (_url: unknown, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({ response: JSON.stringify({ verdict: "SKIP" }) }),
          { status: 200 },
        ),
      ),
  ) as unknown as typeof fetch;
  const ollama = new OllamaLanguageModel(ollamaFetch, { model: "test" });
  let claudeCalled = false;
  const run = spy((args: string[]) => {
    if (args[0] === "claude") claudeCalled = true;
    return Promise.resolve({ code: 1, stdout: "" });
  });
  const result = await judgeComment("Any update?", run, [ollama]);
  assertFalse(result);
  assertFalse(claudeCalled);
});
