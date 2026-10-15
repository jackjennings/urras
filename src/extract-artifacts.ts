import type { CommandRunner } from "./apfel.ts";
import { ARTIFACT_DESCRIPTORS, type ArtifactType } from "./state/types.ts";
import { buildAncillaryChain } from "./models/ancillary-chain.ts";
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
  const model = buildAncillaryChain({
    callSite: "extractIntakeArtifacts",
    run,
  });
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
