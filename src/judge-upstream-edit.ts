import type { CommandRunner } from "./apfel.ts";
import { ApfelLanguageModel } from "./models/apfel.ts";
import { ClaudeLanguageModel } from "./models/claude.ts";
import { FallbackLanguageModel } from "./models/fallback.ts";
import { OllamaLanguageModel } from "./models/ollama.ts";

const SYSTEM_PROMPT =
  "You are evaluating whether an upstream change to a software ticket is substantive. A substantive change adds, removes, or modifies scope, requirements, acceptance criteria, or constraints. A non-substantive change only fixes typos, improves wording, or reformats without changing meaning. Reply with substantive true if the change is substantive, false otherwise.";

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
  const prompt =
    `Old title: ${oldTitle}\nNew title: ${newTitle}\n\nOld body:\n${oldBody}\n\nNew body:\n${newBody}`;
  const result = await model.generateObject<{ substantive: boolean }>({
    systemPrompt: SYSTEM_PROMPT,
    prompt,
    schema: SCHEMA,
    maxTokens: 64,
  });
  if (result === null) return null;
  return result.substantive;
}
