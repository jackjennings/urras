import type { LanguageModel } from "./models/types.ts";
import { renderPrompt } from "./filesystem.ts";

const CONTEXT_CHAR_BUDGET = 12000;

export async function generateShortTitle(
  model: LanguageModel,
  title: string,
  context?: string,
): Promise<string | null> {
  const trimmedContext = context?.trim();
  const userPrompt = trimmedContext
    ? `Title: ${title}\n\nContext:\n${
      trimmedContext.slice(0, CONTEXT_CHAR_BUDGET)
    }`
    : title;
  return model.generateText({
    systemPrompt: await renderPrompt(
      new URL("./short-title.prompt.hbs", import.meta.url),
    ),
    prompt: userPrompt,
    maxTokens: 40,
  });
}
