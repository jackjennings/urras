import type { CommandRunner } from "./apfel.ts";
import { ARTIFACT_DESCRIPTORS, type ArtifactType } from "./state/types.ts";
import { ApfelLanguageModel } from "./models/apfel.ts";
import { ClaudeLanguageModel } from "./models/claude.ts";
import { FallbackLanguageModel } from "./models/fallback.ts";
import { renderPrompt } from "./filesystem.ts";

const ARTIFACT_SCHEMA = {
  type: "object",
  properties: {
    artifacts: {
      type: "array",
      items: {
        type: "string",
        enum: Object.keys(ARTIFACT_DESCRIPTORS),
      },
      minItems: 1,
    },
  },
  required: ["artifacts"],
  additionalProperties: false,
};

export async function extractIntakeArtifacts(
  content: string,
  run: CommandRunner,
): Promise<ArtifactType[]> {
  const model = new FallbackLanguageModel([
    new ApfelLanguageModel(run),
    new ClaudeLanguageModel(run, { model: "claude-haiku-4-5" }),
  ]);
  const result = await model.generateObject<{ artifacts: ArtifactType[] }>({
    systemPrompt: await renderPrompt(
      new URL("./extract-artifacts.prompt.hbs", import.meta.url),
    ),
    prompt: content,
    schema: ARTIFACT_SCHEMA,
    maxTokens: 64,
  });
  if (!result || !Array.isArray(result.artifacts)) return [];
  return result.artifacts.filter((v) => v in ARTIFACT_DESCRIPTORS);
}
