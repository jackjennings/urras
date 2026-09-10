import type { CommandRunner } from "./apfel.ts";
import { ApfelLanguageModel } from "./models/apfel.ts";
import { ClaudeLanguageModel } from "./models/claude.ts";
import { FallbackLanguageModel } from "./models/fallback.ts";
import { OllamaLanguageModel } from "./models/ollama.ts";
import { renderPrompt } from "./filesystem.ts";

const SCHEMA = {
  type: "object",
  properties: {
    substantive: { type: "boolean" },
  },
  required: ["substantive"],
  additionalProperties: false,
};

export async function judgeUpstreamEdit(
  oldTitle: string,
  newTitle: string,
  oldBody: string,
  newBody: string,
  run: CommandRunner,
  ollamaModels?: OllamaLanguageModel[],
): Promise<boolean | null> {
  const model = new FallbackLanguageModel([
    new ApfelLanguageModel(run),
    ...(ollamaModels ?? []),
    new ClaudeLanguageModel(run, { model: "claude-haiku-4-5" }),
  ]);
  const prompt = await renderPrompt(
    new URL("./judge-upstream-edit-user.prompt.hbs", import.meta.url),
    { oldTitle, newTitle, oldBody, newBody },
  );
  const result = await model.generateObject<{ substantive: boolean }>({
    systemPrompt: await renderPrompt(
      new URL("./judge-upstream-edit.prompt.hbs", import.meta.url),
    ),
    prompt,
    schema: SCHEMA,
    maxTokens: 64,
  });
  if (result === null) return null;
  return result.substantive;
}
