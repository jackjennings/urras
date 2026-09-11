import { assertEquals } from "@std/assert";
import { adjudicatePhaseModel } from "./pre-phase-adjudication.ts";
import type { LanguageModel } from "./models/types.ts";

function makeModel(result: unknown): LanguageModel {
  return {
    name: "stub",
    generateText: () => Promise.resolve(null),
    generateObject: () => Promise.resolve(result),
  } as unknown as LanguageModel;
}

Deno.test(
  "adjudicatePhaseModel: returns model and thinking from LLM response",
  async () => {
    const result = await adjudicatePhaseModel(
      "Complex multi-file refactor",
      makeModel({ model: "claude-sonnet-4-6", thinking: "high" }),
    );
    assertEquals(result, { model: "claude-sonnet-4-6", thinking: "high" });
  },
);

Deno.test(
  "adjudicatePhaseModel: returns null when model id is not in valid set",
  async () => {
    assertEquals(
      await adjudicatePhaseModel(
        "prompt",
        makeModel({ model: "gpt-4", thinking: "high" }),
      ),
      null,
    );
  },
);

Deno.test(
  "adjudicatePhaseModel: returns null when thinking level is not in valid set",
  async () => {
    assertEquals(
      await adjudicatePhaseModel(
        "prompt",
        makeModel({ model: "claude-sonnet-4-6", thinking: "extreme" }),
      ),
      null,
    );
  },
);

Deno.test("adjudicatePhaseModel: returns null when LLM throws", async () => {
  const model = {
    name: "stub",
    generateText: () => Promise.resolve(null),
    generateObject: () => Promise.reject(new Error("fail")),
  } as unknown as LanguageModel;
  assertEquals(await adjudicatePhaseModel("prompt", model), null);
});
