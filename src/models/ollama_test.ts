import { assert, assertEquals, assertFalse } from "@std/assert";
import { spy } from "@std/testing/mock";
import type { AncillaryUsageRecord } from "../ancillary-usage.ts";
import { checkOllamaAvailable, OllamaLanguageModel } from "./ollama.ts";

function makeFetch(
  handler: (
    url: string,
    init?: RequestInit,
  ) => { status: number; body?: string },
): typeof fetch {
  return spy(
    (url: unknown, init?: RequestInit) => {
      const { status, body = "" } = handler(String(url), init);
      return Promise.resolve(new Response(body, { status }));
    },
  ) as unknown as typeof fetch;
}

Deno.test("OllamaLanguageModel.generateObject: non-200 response returns null", async () => {
  const _fetch = makeFetch(() => ({ status: 500 }));
  const model = new OllamaLanguageModel(_fetch, { model: "qwen2.5:7b" });
  assertEquals(
    await model.generateObject({ systemPrompt: "s", prompt: "p", schema: {} }),
    null,
  );
});

Deno.test("OllamaLanguageModel.generateObject: network error returns null", async () => {
  const _fetch = spy(
    (_url: unknown) => Promise.reject(new Error("network error")),
  ) as unknown as typeof fetch;
  const model = new OllamaLanguageModel(_fetch, { model: "qwen2.5:7b" });
  assertEquals(
    await model.generateObject({ systemPrompt: "s", prompt: "p", schema: {} }),
    null,
  );
});

Deno.test("OllamaLanguageModel.generateObject: invalid JSON in response returns null", async () => {
  const _fetch = makeFetch(() => ({
    status: 200,
    body: JSON.stringify({ response: "not json" }),
  }));
  const model = new OllamaLanguageModel(_fetch, { model: "qwen2.5:7b" });
  assertEquals(
    await model.generateObject({ systemPrompt: "s", prompt: "p", schema: {} }),
    null,
  );
});

Deno.test("OllamaLanguageModel.generateObject: valid JSON returns typed result", async () => {
  const _fetch = makeFetch(() => ({
    status: 200,
    body: JSON.stringify({ response: '{"verdict":"KEEP"}' }),
  }));
  const model = new OllamaLanguageModel(_fetch, { model: "qwen2.5:7b" });
  assertEquals(
    await model.generateObject<{ verdict: string }>({
      systemPrompt: "s",
      prompt: "p",
      schema: {},
    }),
    { verdict: "KEEP" },
  );
});

Deno.test("OllamaLanguageModel.generateObject: request body contains format key equal to schema", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const _fetch = makeFetch((_, init) => {
    capturedBody = JSON.parse(init!.body as string) as Record<string, unknown>;
    return { status: 200, body: JSON.stringify({ response: '{"ok":true}' }) };
  });
  const schema = { type: "object", properties: { ok: { type: "boolean" } } };
  const model = new OllamaLanguageModel(_fetch, { model: "qwen2.5:7b" });
  await model.generateObject({ systemPrompt: "s", prompt: "p", schema });
  assertEquals(capturedBody?.format, schema);
});

Deno.test("OllamaLanguageModel.generateText: non-200 response returns null", async () => {
  const _fetch = makeFetch(() => ({ status: 404 }));
  const model = new OllamaLanguageModel(_fetch, { model: "qwen2.5:7b" });
  assertEquals(
    await model.generateText({ systemPrompt: "s", prompt: "p" }),
    null,
  );
});

Deno.test("OllamaLanguageModel.generateText: blank response after trim returns null", async () => {
  const _fetch = makeFetch(() => ({
    status: 200,
    body: JSON.stringify({ response: "   " }),
  }));
  const model = new OllamaLanguageModel(_fetch, { model: "qwen2.5:7b" });
  assertEquals(
    await model.generateText({ systemPrompt: "s", prompt: "p" }),
    null,
  );
});

Deno.test("OllamaLanguageModel.generateText: valid response returns trimmed string", async () => {
  const _fetch = makeFetch(() => ({
    status: 200,
    body: JSON.stringify({ response: "  Short Title  " }),
  }));
  const model = new OllamaLanguageModel(_fetch, { model: "qwen2.5:7b" });
  assertEquals(
    await model.generateText({ systemPrompt: "s", prompt: "p" }),
    "Short Title",
  );
});

Deno.test("checkOllamaAvailable: 200 from /api/tags returns true", async () => {
  const _fetch = makeFetch(() => ({ status: 200 }));
  assert(await checkOllamaAvailable(_fetch, "http://localhost:11434"));
});

Deno.test("checkOllamaAvailable: non-200 from /api/tags returns false", async () => {
  const _fetch = makeFetch(() => ({ status: 503 }));
  assertFalse(await checkOllamaAvailable(_fetch, "http://localhost:11434"));
});

Deno.test("checkOllamaAvailable: fetch throws returns false", async () => {
  const _fetch = spy(
    (_url: unknown) => Promise.reject(new Error("refused")),
  ) as unknown as typeof fetch;
  assertFalse(await checkOllamaAvailable(_fetch, "http://localhost:11434"));
});

Deno.test("OllamaLanguageModel.generateText: recordUsage fires with token counts when present", async () => {
  const records: AncillaryUsageRecord[] = [];
  const recordUsage = (r: AncillaryUsageRecord) => {
    records.push(r);
    return Promise.resolve();
  };
  const _fetch = makeFetch(() => ({
    status: 200,
    body: JSON.stringify({
      response: "Short Title",
      prompt_eval_count: 42,
      eval_count: 18,
    }),
  }));
  const model = new OllamaLanguageModel(_fetch, {
    model: "qwen2.5:7b",
    callSite: "generateShortTitle",
    recordUsage,
  });
  const result = await model.generateText({ systemPrompt: "s", prompt: "p" });
  assertEquals(result, "Short Title");
  assertEquals(records.length, 1);
  assertEquals(records[0].callSite, "generateShortTitle");
  assertEquals(records[0].adapter, "ollama");
  assertEquals(records[0].model, "qwen2.5:7b");
  assertEquals(records[0].input, 42);
  assertEquals(records[0].output, 18);
  assert(records[0].estimated === undefined);
});

Deno.test("OllamaLanguageModel.generateText: recordUsage omits token fields when absent", async () => {
  const records: AncillaryUsageRecord[] = [];
  const recordUsage = (r: AncillaryUsageRecord) => {
    records.push(r);
    return Promise.resolve();
  };
  const _fetch = makeFetch(() => ({
    status: 200,
    body: JSON.stringify({ response: "ok" }),
  }));
  const model = new OllamaLanguageModel(_fetch, {
    model: "qwen2.5:7b",
    callSite: "test",
    recordUsage,
  });
  await model.generateText({ systemPrompt: "s", prompt: "p" });
  assertEquals(records.length, 1);
  assert(records[0].input === undefined);
  assert(records[0].output === undefined);
});

Deno.test("OllamaLanguageModel.generateText: recordUsage does not fire on null return", async () => {
  const records: AncillaryUsageRecord[] = [];
  const recordUsage = (r: AncillaryUsageRecord) => {
    records.push(r);
    return Promise.resolve();
  };
  const _fetch = makeFetch(() => ({ status: 500 }));
  const model = new OllamaLanguageModel(_fetch, {
    model: "qwen2.5:7b",
    callSite: "test",
    recordUsage,
  });
  await model.generateText({ systemPrompt: "s", prompt: "p" });
  assertEquals(records.length, 0);
});

Deno.test("OllamaLanguageModel.generateObject: recordUsage fires with token counts when present", async () => {
  const records: AncillaryUsageRecord[] = [];
  const recordUsage = (r: AncillaryUsageRecord) => {
    records.push(r);
    return Promise.resolve();
  };
  const _fetch = makeFetch(() => ({
    status: 200,
    body: JSON.stringify({
      response: '{"verdict":"KEEP"}',
      prompt_eval_count: 15,
      eval_count: 8,
    }),
  }));
  const model = new OllamaLanguageModel(_fetch, {
    model: "qwen2.5:7b",
    callSite: "judgePrinciples",
    recordUsage,
  });
  await model.generateObject<{ verdict: string }>({
    systemPrompt: "s",
    prompt: "p",
    schema: {},
  });
  assertEquals(records.length, 1);
  assertEquals(records[0].input, 15);
  assertEquals(records[0].output, 8);
});
