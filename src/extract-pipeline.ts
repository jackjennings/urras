import type { CommandRunner } from "./apfel.ts";
import { ApfelLanguageModel } from "./models/apfel.ts";
import { ClaudeLanguageModel } from "./models/claude.ts";
import { FallbackLanguageModel } from "./models/fallback.ts";

export async function extractIntakePipeline(
  content: string,
  run: CommandRunner,
  availableNames: string[],
): Promise<string | null> {
  if (availableNames.length === 0) return null;
  const systemPrompt =
    "You are extracting the chosen pipeline template name from an intake " +
    "output written by an AI coding agent. Valid template names are: " +
    `${availableNames.join(", ")}. Return the name from the "## Pipeline" ` +
    "section of the intake output if present, or null if that section is " +
    "absent or the ticket should use the default pipeline.";
  const schema = {
    type: "object",
    properties: {
      pipeline: {
        anyOf: [
          { type: "string", enum: availableNames },
          { type: "null" },
        ],
      },
    },
    required: ["pipeline"],
    additionalProperties: false,
  };
  const model = new FallbackLanguageModel([
    new ApfelLanguageModel(run),
    new ClaudeLanguageModel(run, { model: "claude-haiku-4-5" }),
  ]);
  const result = await model.generateObject<{ pipeline: string | null }>({
    systemPrompt,
    prompt: content,
    schema,
    maxTokens: 32,
  });
  if (!result || typeof result.pipeline !== "string") return null;
  return availableNames.includes(result.pipeline) ? result.pipeline : null;
}
