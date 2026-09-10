import type { CommandRunner } from "./apfel.ts";
import { ApfelLanguageModel } from "./models/apfel.ts";
import { ClaudeLanguageModel } from "./models/claude.ts";
import { FallbackLanguageModel } from "./models/fallback.ts";
import { OllamaLanguageModel } from "./models/ollama.ts";
import { renderPrompt } from "./filesystem.ts";

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["KEEP_LOCAL", "KEEP_GLOBAL", "SKIP"] },
  },
  required: ["verdict"],
  additionalProperties: false,
};

type Scope = "local" | "global";

export async function judgePrinciples(
  body: string,
  run: CommandRunner,
  ollamaModels?: OllamaLanguageModel[],
): Promise<Scope | null> {
  const model = new FallbackLanguageModel([
    new ApfelLanguageModel(run),
    ...(ollamaModels ?? []),
    new ClaudeLanguageModel(run, { model: "claude-haiku-4-5" }),
  ]);
  const result = await model.generateObject<
    { verdict: "KEEP_LOCAL" | "KEEP_GLOBAL" | "SKIP" }
  >({
    systemPrompt: await renderPrompt(
      new URL("./judge.prompt.hbs", import.meta.url),
    ),
    prompt: body,
    schema: VERDICT_SCHEMA,
    maxTokens: 64,
  });
  if (result?.verdict === "KEEP_LOCAL") return "local";
  if (result?.verdict === "KEEP_GLOBAL") return "global";
  return null;
}

const FILTER_SCHEMA = {
  type: "object",
  properties: {
    indices: { type: "array", items: { type: "integer" } },
  },
  required: ["indices"],
  additionalProperties: false,
};

export async function filterPrinciples(
  entries: string[],
  context: string,
  topK: number,
  run: CommandRunner,
  ollamaModels?: OllamaLanguageModel[],
): Promise<number[] | null> {
  const model = new FallbackLanguageModel([
    new ApfelLanguageModel(run),
    ...(ollamaModels ?? []),
    new ClaudeLanguageModel(run, { model: "claude-haiku-4-5" }),
  ]);
  const numbered = entries.map((e, i) => `${i}: ${e}`).join("\n\n");
  const result = await model.generateObject<{ indices: number[] }>({
    systemPrompt: await renderPrompt(
      new URL("./judge-filter.prompt.hbs", import.meta.url),
    ),
    prompt: await renderPrompt(
      new URL("./judge-filter-user.prompt.hbs", import.meta.url),
      { context, numbered, topK },
    ),
    schema: FILTER_SCHEMA,
    maxTokens: 128,
  });
  if (!result || !Array.isArray(result.indices)) return null;
  return [
    ...new Set(
      result.indices.filter(
        (i) =>
          typeof i === "number" &&
          Number.isInteger(i) &&
          i >= 0 &&
          i < entries.length,
      ),
    ),
  ].slice(0, topK);
}
