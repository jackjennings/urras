import type { LanguageModel } from "./models/types.ts";
import { renderPrompt } from "./filesystem.ts";

const VALID_MODEL_IDS = new Set([
  "claude-sonnet-4-6",
  "claude-opus-4-5",
  "claude-opus-4-6",
]);

const VALID_THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const JSON_SCHEMA = {
  type: "object",
  properties: {
    model: { type: "string", enum: [...VALID_MODEL_IDS] },
    thinking: { type: "string", enum: [...VALID_THINKING_LEVELS] },
  },
  required: ["model", "thinking"],
};

export async function adjudicatePhaseModel(
  prompt: string,
  model: LanguageModel,
): Promise<{ model: string; thinking: string } | null> {
  try {
    const systemPrompt = await renderPrompt(
      new URL("./pre-phase-adjudication.prompt.hbs", import.meta.url),
      {
        validModels: [...VALID_MODEL_IDS],
        validThinkingLevels: [...VALID_THINKING_LEVELS],
      },
    );
    const result = await model.generateObject<
      { model: string; thinking: string }
    >({
      systemPrompt,
      prompt,
      schema: JSON_SCHEMA,
      maxTokens: 64,
    });
    if (
      typeof result?.model !== "string" ||
      typeof result?.thinking !== "string" ||
      !VALID_MODEL_IDS.has(result.model) ||
      !VALID_THINKING_LEVELS.has(result.thinking)
    ) {
      return null;
    }
    return { model: result.model, thinking: result.thinking };
  } catch {
    return null;
  }
}
