import { assertEquals } from "@std/assert";
import type { LanguageModel, LanguageModelRequest } from "./models/types.ts";
import { judgeComment } from "./judge-comment.ts";

function stubModel(
  verdict: "KEEP" | "SKIP" | null,
): LanguageModel {
  return {
    name: "stub",
    generateText: (_req: LanguageModelRequest) => Promise.resolve(null),
    generateObject: <T>(_req: LanguageModelRequest & { schema: object }) =>
      Promise.resolve(
        verdict !== null ? { verdict } as T : null,
      ),
  };
}

Deno.test("judgeComment: returns true when model returns KEEP", async () => {
  assertEquals(
    await judgeComment("Substantive technical info", stubModel("KEEP")),
    true,
  );
});

Deno.test("judgeComment: returns false when model returns SKIP", async () => {
  assertEquals(await judgeComment("Any update?", stubModel("SKIP")), false);
});

Deno.test("judgeComment: defaults to KEEP when model returns null", async () => {
  assertEquals(await judgeComment("Some comment", stubModel(null)), true);
});
