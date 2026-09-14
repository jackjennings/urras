import { assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import type { LanguageModel, LanguageModelRequest } from "./models/types.ts";
import { filterPrinciples, judgePrinciples } from "./judge-principles.ts";

function verdictModel(verdict: string | null): LanguageModel {
  return {
    name: "stub",
    generateText: (_req: LanguageModelRequest) => Promise.resolve(null),
    generateObject: <T>(_req: LanguageModelRequest & { schema: object }) =>
      Promise.resolve(verdict !== null ? { verdict } as T : null),
  };
}

function indicesModel(indices: number[] | null): LanguageModel {
  let capturedPrompt = "";
  return {
    name: "stub",
    generateText: (_req: LanguageModelRequest) => Promise.resolve(null),
    generateObject: <T>(req: LanguageModelRequest & { schema: object }) => {
      capturedPrompt = req.prompt;
      return Promise.resolve(indices !== null ? { indices } as T : null);
    },
    get lastPrompt() {
      return capturedPrompt;
    },
  } as LanguageModel & { lastPrompt: string };
}

// ── judgePrinciples ───────────────────────────────────────────────────────────

Deno.test("judgePrinciples: returns 'local' when model returns KEEP_LOCAL", async () => {
  assertEquals(
    await judgePrinciples("- prefer X over Y", verdictModel("KEEP_LOCAL")),
    "local",
  );
});

Deno.test("judgePrinciples: returns 'global' when model returns KEEP_GLOBAL", async () => {
  assertEquals(
    await judgePrinciples("- prefer X over Y", verdictModel("KEEP_GLOBAL")),
    "global",
  );
});

Deno.test("judgePrinciples: returns null when model returns SKIP", async () => {
  assertEquals(
    await judgePrinciples("_(nothing meets bar)_", verdictModel("SKIP")),
    null,
  );
});

Deno.test("judgePrinciples: returns null when model returns null", async () => {
  assertEquals(
    await judgePrinciples("- prefer X over Y", verdictModel(null)),
    null,
  );
});

// ── filterPrinciples ──────────────────────────────────────────────────────────

Deno.test("filterPrinciples: returns indices from model response", async () => {
  const result = await filterPrinciples(
    ["- A", "- B", "- C"],
    "context",
    5,
    indicesModel([2, 0]),
  );
  assertEquals(result, [2, 0]);
});

Deno.test("filterPrinciples: returns null when model returns null", async () => {
  assertEquals(
    await filterPrinciples(["- A"], "ctx", 5, indicesModel(null)),
    null,
  );
});

Deno.test("filterPrinciples: returns null when response indices is not an array", async () => {
  const model: LanguageModel = {
    name: "stub",
    generateText: () => Promise.resolve(null),
    generateObject: <T>(_req: LanguageModelRequest & { schema: object }) =>
      Promise.resolve({ indices: "wrong" } as unknown as T),
  };
  assertEquals(await filterPrinciples(["- A"], "ctx", 5, model), null);
});

Deno.test("filterPrinciples: returns null when result object has no indices field", async () => {
  const model: LanguageModel = {
    name: "stub",
    generateText: () => Promise.resolve(null),
    generateObject: <T>(_req: LanguageModelRequest & { schema: object }) =>
      Promise.resolve({ verdict: "KEEP" } as unknown as T),
  };
  assertEquals(await filterPrinciples(["- A"], "ctx", 5, model), null);
});

Deno.test("filterPrinciples: filters out-of-bounds indices from response", async () => {
  const result = await filterPrinciples(
    ["- A", "- B", "- C"],
    "ctx",
    5,
    indicesModel([0, 5, -1]),
  );
  assertEquals(result, [0]);
});

Deno.test("filterPrinciples: returns empty array when all returned indices are out of bounds", async () => {
  assertEquals(
    await filterPrinciples(["- A"], "ctx", 5, indicesModel([99])),
    [],
  );
});

Deno.test("filterPrinciples: deduplicates repeated indices", async () => {
  const result = await filterPrinciples(
    ["- A", "- B"],
    "ctx",
    5,
    indicesModel([0, 0, 1]),
  );
  assertEquals(result?.length, 2);
});

Deno.test("filterPrinciples: caps results to topK", async () => {
  const entries = Array.from({ length: 10 }, (_, i) => `- e${i}`);
  const result = await filterPrinciples(
    entries,
    "ctx",
    3,
    indicesModel([0, 1, 2, 3, 4, 5, 6]),
  );
  assertEquals(result?.length, 3);
});

Deno.test("filterPrinciples: includes context and numbered entries in prompt", async () => {
  let capturedPrompt = "";
  const model: LanguageModel = {
    name: "stub",
    generateText: () => Promise.resolve(null),
    generateObject: <T>(req: LanguageModelRequest & { schema: object }) => {
      capturedPrompt = req.prompt;
      return Promise.resolve({ indices: [] } as unknown as T);
    },
  };
  await filterPrinciples(
    ["- entry A", "- entry B"],
    "ticket context",
    5,
    model,
  );
  assertStringIncludes(capturedPrompt, "ticket context");
  assertStringIncludes(capturedPrompt, "0: - entry A");
  assertStringIncludes(capturedPrompt, "1: - entry B");
});

Deno.test("filterPrinciples: does not include non-integer indices", async () => {
  const result = await filterPrinciples(
    ["- A", "- B"],
    "ctx",
    5,
    indicesModel([0.5, 1]),
  );
  assertEquals(result, [1]);
});

Deno.test("filterPrinciples: assertFalse indices includes non-integer", async () => {
  const result = await filterPrinciples(
    ["- A", "- B"],
    "ctx",
    5,
    indicesModel([0, 1]),
  );
  assertFalse(result === null);
});
