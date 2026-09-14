import { assertEquals, assertStringIncludes } from "@std/assert";
import type { LanguageModel, LanguageModelRequest } from "./models/types.ts";
import { judgeUpstreamEdit } from "./judge-upstream-edit.ts";

function substantiveModel(
  value: boolean | null,
  onCall?: (req: LanguageModelRequest) => void,
): LanguageModel {
  return {
    name: "stub",
    generateText: () => Promise.resolve(null),
    generateObject: <T>(req: LanguageModelRequest & { schema: object }) => {
      onCall?.(req);
      return Promise.resolve(
        value !== null ? { substantive: value } as T : null,
      );
    },
  };
}

Deno.test("judgeUpstreamEdit: returns true when model returns substantive: true", async () => {
  assertEquals(
    await judgeUpstreamEdit(
      "old",
      "new",
      "old body",
      "new body",
      substantiveModel(true),
    ),
    true,
  );
});

Deno.test("judgeUpstreamEdit: returns false when model returns substantive: false", async () => {
  assertEquals(
    await judgeUpstreamEdit(
      "old",
      "new",
      "old body",
      "new body",
      substantiveModel(false),
    ),
    false,
  );
});

Deno.test("judgeUpstreamEdit: returns null when model returns null", async () => {
  assertEquals(
    await judgeUpstreamEdit(
      "old",
      "new",
      "old body",
      "new body",
      substantiveModel(null),
    ),
    null,
  );
});

Deno.test("judgeUpstreamEdit: passes titles and bodies to model prompt", async () => {
  let capturedPrompt = "";
  await judgeUpstreamEdit(
    "Original title",
    "Revised title",
    "Original body text",
    "Revised body text",
    substantiveModel(true, (req) => {
      capturedPrompt = req.prompt;
    }),
  );
  assertStringIncludes(capturedPrompt, "Original title");
  assertStringIncludes(capturedPrompt, "Revised title");
  assertStringIncludes(capturedPrompt, "Original body text");
  assertStringIncludes(capturedPrompt, "Revised body text");
});
