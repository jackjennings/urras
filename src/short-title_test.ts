import {
  assertEquals,
  assertFalse,
  assertLess,
  assertStringIncludes,
} from "@std/assert";
import type { LanguageModel, LanguageModelRequest } from "./models/types.ts";
import { generateShortTitle } from "./short-title.ts";

function makeModel(
  result: string | null,
): LanguageModel & { lastRequest: LanguageModelRequest | null } {
  const stub = {
    name: "stub",
    lastRequest: null as LanguageModelRequest | null,
    generateText(req: LanguageModelRequest): Promise<string | null> {
      stub.lastRequest = req;
      return Promise.resolve(result);
    },
    generateObject<T>(
      _req: LanguageModelRequest & { schema: object },
    ): Promise<T | null> {
      return Promise.resolve(null);
    },
  };
  return stub;
}

Deno.test("generateShortTitle: returns string from model", async () => {
  const model = makeModel("Short Title");
  assertEquals(
    await generateShortTitle(model, "A long full title for an issue"),
    "Short Title",
  );
});

Deno.test("generateShortTitle: returns null when model returns null", async () => {
  const model = makeModel(null);
  assertEquals(await generateShortTitle(model, "Title"), null);
});

Deno.test(
  "generateShortTitle: passes title as prompt when no context",
  async () => {
    const model = makeModel("Short");
    await generateShortTitle(model, "Add hud subcommand for live agent status");
    assertEquals(
      model.lastRequest?.prompt,
      "Add hud subcommand for live agent status",
    );
  },
);

Deno.test(
  "generateShortTitle: includes context in the prompt when provided",
  async () => {
    const model = makeModel("Short");
    await generateShortTitle(model, "Fix flaky login test", "Details here.");
    assertStringIncludes(
      model.lastRequest?.prompt ?? "",
      "Fix flaky login test",
    );
    assertStringIncludes(model.lastRequest?.prompt ?? "", "Details here.");
  },
);

Deno.test(
  "generateShortTitle: truncates oversized context",
  async () => {
    const model = makeModel("Short");
    await generateShortTitle(model, "Title", "x".repeat(50000));
    assertLess((model.lastRequest?.prompt ?? "").length, 50000);
    assertFalse(
      (model.lastRequest?.prompt ?? "").includes("x".repeat(20000)),
    );
  },
);
