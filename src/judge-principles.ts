import type { CommandRunner } from "./apfel.ts";
import { ApfelLanguageModel } from "./models/apfel.ts";
import { ClaudeLanguageModel } from "./models/claude.ts";
import { FallbackLanguageModel } from "./models/fallback.ts";
import { OllamaLanguageModel } from "./models/ollama.ts";

const JUDGE_SYSTEM_PROMPT =
  "You are evaluating whether content from an AI coding agent's Principles section contains substantive engineering guidance worth preserving. Reply with verdict KEEP_LOCAL, KEEP_GLOBAL, or SKIP. Default to KEEP_LOCAL unless the principle is about the urras pipeline or tooling itself — not about the specific codebase being modified — in which case use KEEP_GLOBAL. Reply SKIP if the content is meta-commentary explaining why no principles were added, a placeholder, or otherwise lacks actionable engineering guidance.";

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
    systemPrompt: JUDGE_SYSTEM_PROMPT,
    prompt: body,
    schema: VERDICT_SCHEMA,
    maxTokens: 64,
  });
  if (result?.verdict === "KEEP_LOCAL") return "local";
  if (result?.verdict === "KEEP_GLOBAL") return "global";
  return null;
}

const FILTER_SYSTEM_PROMPT =
  "You are selecting the most relevant engineering principles for a coding task. Given a numbered list of principles and a task description, return the indices of the principles most relevant to this task. Return fewer than the requested count if fewer are genuinely relevant.";

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
    systemPrompt: FILTER_SYSTEM_PROMPT,
    prompt:
      `${context}\n\n${numbered}\n\nReturn the indices of the top ${topK} most relevant principles.`,
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
