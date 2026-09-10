import type { CommandRunner } from "./apfel.ts";
import { ApfelLanguageModel } from "./models/apfel.ts";
import { renderPrompt } from "./filesystem.ts";

const CONTEXT_CHAR_BUDGET = 12000;

export async function generateShortTitle(
  run: CommandRunner,
  title: string,
  context?: string,
): Promise<string | null> {
  const trimmedContext = context?.trim();
  const userPrompt = trimmedContext
    ? `Title: ${title}\n\nContext:\n${
      trimmedContext.slice(0, CONTEXT_CHAR_BUDGET)
    }`
    : title;
  const model = new ApfelLanguageModel(run);
  return model.generateText({
    systemPrompt: await renderPrompt(
      new URL("./short-title.prompt.hbs", import.meta.url),
    ),
    prompt: userPrompt,
    maxTokens: 40,
  });
}
