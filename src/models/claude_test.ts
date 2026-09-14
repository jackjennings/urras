import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
} from "@std/assert";
import { spy } from "@std/testing/mock";
import type { CommandRunner } from "../apfel.ts";
import type { AncillaryUsageRecord } from "../ancillary-usage.ts";
import { ClaudeLanguageModel } from "./claude.ts";

function makeRunner(
  handler: (args: string[]) => { code: number; stdout: string },
): CommandRunner {
  return spy((args: string[]) => Promise.resolve(handler(args)));
}

function envelope(
  result: string,
  opts?: { total_cost_usd?: number; input_tokens?: number; output_tokens?: number },
): string {
  return JSON.stringify({
    result,
    ...(opts?.total_cost_usd !== undefined
      ? { total_cost_usd: opts.total_cost_usd }
      : {}),
    ...(opts?.input_tokens !== undefined && opts?.output_tokens !== undefined
      ? {
        usage: {
          input_tokens: opts.input_tokens,
          output_tokens: opts.output_tokens,
        },
      }
      : {}),
  });
}

const MODEL = "claude-haiku-4-5";

// ── generateObject ─────────────────────────────────────────────────────────────

Deno.test("ClaudeLanguageModel.generateObject: non-zero exit returns null", async () => {
  const run = makeRunner(() => ({ code: 1, stdout: "" }));
  const model = new ClaudeLanguageModel(run, { model: MODEL });
  const result = await model.generateObject({
    systemPrompt: "sys",
    prompt: "body",
    schema: {},
  });
  assertEquals(result, null);
});

Deno.test("ClaudeLanguageModel.generateObject: invalid envelope returns null", async () => {
  const run = makeRunner(() => ({ code: 0, stdout: "not json" }));
  const model = new ClaudeLanguageModel(run, { model: MODEL });
  const result = await model.generateObject({
    systemPrompt: "sys",
    prompt: "body",
    schema: {},
  });
  assertEquals(result, null);
});

Deno.test("ClaudeLanguageModel.generateObject: invalid result in envelope returns null", async () => {
  const run = makeRunner(() => ({
    code: 0,
    stdout: envelope("not json"),
  }));
  const model = new ClaudeLanguageModel(run, { model: MODEL });
  const result = await model.generateObject({
    systemPrompt: "sys",
    prompt: "body",
    schema: {},
  });
  assertEquals(result, null);
});

Deno.test("ClaudeLanguageModel.generateObject: valid JSON result returns typed object", async () => {
  const run = makeRunner(() => ({
    code: 0,
    stdout: envelope('{"verdict":"KEEP"}'),
  }));
  const model = new ClaudeLanguageModel(run, { model: MODEL });
  const result = await model.generateObject<{ verdict: string }>({
    systemPrompt: "sys",
    prompt: "body",
    schema: {},
  });
  assertEquals(result, { verdict: "KEEP" });
});

Deno.test("ClaudeLanguageModel.generateObject: -- separator present before prompt", async () => {
  let capturedArgs: string[] = [];
  const run = makeRunner((args) => {
    capturedArgs = args;
    return { code: 0, stdout: envelope('{"ok":true}') };
  });
  const model = new ClaudeLanguageModel(run, { model: MODEL });
  await model.generateObject({
    systemPrompt: "sys",
    prompt: "my prompt",
    schema: {},
  });
  assertEquals(capturedArgs[capturedArgs.length - 2], "--");
  assertEquals(capturedArgs[capturedArgs.length - 1], "my prompt");
});

Deno.test("ClaudeLanguageModel.generateObject: no --bare flag in args", async () => {
  let capturedArgs: string[] = [];
  const run = makeRunner((args) => {
    capturedArgs = args;
    return { code: 0, stdout: envelope('{"ok":true}') };
  });
  const model = new ClaudeLanguageModel(run, { model: MODEL });
  await model.generateObject({
    systemPrompt: "sys",
    prompt: "body",
    schema: {},
  });
  assertFalse(capturedArgs.includes("--bare"));
});

Deno.test("ClaudeLanguageModel.generateObject: passes --output-format json", async () => {
  let capturedArgs: string[] = [];
  const run = makeRunner((args) => {
    capturedArgs = args;
    return { code: 0, stdout: envelope('{"ok":true}') };
  });
  const model = new ClaudeLanguageModel(run, { model: MODEL });
  await model.generateObject({
    systemPrompt: "sys",
    prompt: "body",
    schema: {},
  });
  const idx = capturedArgs.indexOf("--output-format");
  assertNotEquals(idx, -1);
  assertEquals(capturedArgs[idx + 1], "json");
});

Deno.test("ClaudeLanguageModel.generateObject: recordUsage fires on non-null return", async () => {
  const records: AncillaryUsageRecord[] = [];
  const recordUsage = (r: AncillaryUsageRecord) => {
    records.push(r);
    return Promise.resolve();
  };
  const run = makeRunner(() => ({
    code: 0,
    stdout: envelope('{"verdict":"KEEP"}', {
      total_cost_usd: 0.01,
      input_tokens: 10,
      output_tokens: 5,
    }),
  }));
  const model = new ClaudeLanguageModel(run, {
    model: MODEL,
    callSite: "test",
    recordUsage,
  });
  await model.generateObject({ systemPrompt: "sys", prompt: "body", schema: {} });
  assertEquals(records.length, 1);
  assertEquals(records[0].callSite, "test");
  assertEquals(records[0].adapter, "claude");
  assertEquals(records[0].model, MODEL);
  assertEquals(records[0].input, 10);
  assertEquals(records[0].output, 5);
  assertEquals(records[0].cost, 0.01);
  assert(records[0].estimated === undefined);
});

Deno.test("ClaudeLanguageModel.generateObject: recordUsage does not fire on null return", async () => {
  const records: AncillaryUsageRecord[] = [];
  const recordUsage = (r: AncillaryUsageRecord) => {
    records.push(r);
    return Promise.resolve();
  };
  const run = makeRunner(() => ({ code: 1, stdout: "" }));
  const model = new ClaudeLanguageModel(run, {
    model: MODEL,
    callSite: "test",
    recordUsage,
  });
  await model.generateObject({ systemPrompt: "sys", prompt: "body", schema: {} });
  assertEquals(records.length, 0);
});

// ── generateText ──────────────────────────────────────────────────────────────

Deno.test("ClaudeLanguageModel.generateText: non-zero exit returns null", async () => {
  const run = makeRunner(() => ({ code: 1, stdout: "" }));
  const model = new ClaudeLanguageModel(run, { model: MODEL });
  const result = await model.generateText({ systemPrompt: "sys", prompt: "p" });
  assertEquals(result, null);
});

Deno.test("ClaudeLanguageModel.generateText: invalid envelope returns null", async () => {
  const run = makeRunner(() => ({ code: 0, stdout: "   " }));
  const model = new ClaudeLanguageModel(run, { model: MODEL });
  const result = await model.generateText({ systemPrompt: "sys", prompt: "p" });
  assertEquals(result, null);
});

Deno.test("ClaudeLanguageModel.generateText: empty result after trim returns null", async () => {
  const run = makeRunner(() => ({
    code: 0,
    stdout: envelope("   "),
  }));
  const model = new ClaudeLanguageModel(run, { model: MODEL });
  const result = await model.generateText({ systemPrompt: "sys", prompt: "p" });
  assertEquals(result, null);
});

Deno.test("ClaudeLanguageModel.generateText: returns trimmed result on success", async () => {
  const run = makeRunner(() => ({
    code: 0,
    stdout: envelope("  APPROVE  "),
  }));
  const model = new ClaudeLanguageModel(run, { model: MODEL });
  const result = await model.generateText({ systemPrompt: "sys", prompt: "p" });
  assertEquals(result, "APPROVE");
});

Deno.test("ClaudeLanguageModel.generateText: exception returns null", async () => {
  const run: CommandRunner = spy((_args: string[]) =>
    Promise.reject(new Error("not found"))
  );
  const model = new ClaudeLanguageModel(run, { model: MODEL });
  const result = await model.generateText({ systemPrompt: "sys", prompt: "p" });
  assertEquals(result, null);
});

Deno.test("ClaudeLanguageModel.generateText: -- separator present before prompt", async () => {
  let capturedArgs: string[] = [];
  const run = makeRunner((args) => {
    capturedArgs = args;
    return { code: 0, stdout: envelope("ok") };
  });
  const model = new ClaudeLanguageModel(run, { model: MODEL });
  await model.generateText({ systemPrompt: "sys", prompt: "my prompt" });
  assertEquals(capturedArgs[capturedArgs.length - 2], "--");
  assertEquals(capturedArgs[capturedArgs.length - 1], "my prompt");
});

Deno.test("ClaudeLanguageModel.generateText: passes --output-format json", async () => {
  let capturedArgs: string[] = [];
  const run = makeRunner((args) => {
    capturedArgs = args;
    return { code: 0, stdout: envelope("ok") };
  });
  const model = new ClaudeLanguageModel(run, { model: MODEL });
  await model.generateText({ systemPrompt: "sys", prompt: "p" });
  const idx = capturedArgs.indexOf("--output-format");
  assertNotEquals(idx, -1);
  assertEquals(capturedArgs[idx + 1], "json");
});

Deno.test("ClaudeLanguageModel.generateText: recordUsage fires on non-null return", async () => {
  const records: AncillaryUsageRecord[] = [];
  const recordUsage = (r: AncillaryUsageRecord) => {
    records.push(r);
    return Promise.resolve();
  };
  const run = makeRunner(() => ({
    code: 0,
    stdout: envelope("APPROVE", {
      total_cost_usd: 0.02,
      input_tokens: 20,
      output_tokens: 3,
    }),
  }));
  const model = new ClaudeLanguageModel(run, {
    model: MODEL,
    callSite: "executeReview",
    recordUsage,
  });
  const result = await model.generateText({
    systemPrompt: "sys",
    prompt: "p",
  });
  assertEquals(result, "APPROVE");
  assertEquals(records.length, 1);
  assertEquals(records[0].callSite, "executeReview");
  assertEquals(records[0].adapter, "claude");
  assertEquals(records[0].input, 20);
  assertEquals(records[0].output, 3);
  assertEquals(records[0].cost, 0.02);
});

Deno.test("ClaudeLanguageModel.generateText: recordUsage does not fire on null return", async () => {
  const records: AncillaryUsageRecord[] = [];
  const recordUsage = (r: AncillaryUsageRecord) => {
    records.push(r);
    return Promise.resolve();
  };
  const run = makeRunner(() => ({ code: 1, stdout: "" }));
  const model = new ClaudeLanguageModel(run, {
    model: MODEL,
    callSite: "test",
    recordUsage,
  });
  await model.generateText({ systemPrompt: "sys", prompt: "p" });
  assertEquals(records.length, 0);
});
