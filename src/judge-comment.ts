import { captureCommandRunner, type CommandRunner } from "./apfel.ts";
import { ApfelLanguageModel } from "./models/apfel.ts";
import { ClaudeLanguageModel } from "./models/claude.ts";
import { FallbackLanguageModel } from "./models/fallback.ts";
import { OllamaLanguageModel } from "./models/ollama.ts";

const COMMENT_JUDGE_SYSTEM_PROMPT =
  'You are evaluating whether a Jira comment contains information useful for understanding or implementing a software ticket. Reply with exactly KEEP if the comment contains substantive technical context, requirements clarification, decisions, constraints, repro steps, or relevant background. Reply with exactly SKIP if the comment is a status update request ("any update?", "when will this be done?"), a simple acknowledgement (+1, thanks, LGTM), a bot-generated notification, or an @-mention ping with no technical content.';

const COMMENT_JUDGE_JSON_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["KEEP", "SKIP"] },
  },
  required: ["verdict"],
};

export async function judgeComment(
  body: string,
  run: CommandRunner = captureCommandRunner(),
  ollamaModels?: OllamaLanguageModel[],
): Promise<boolean> {
  const model = new FallbackLanguageModel([
    new ApfelLanguageModel(run),
    ...(ollamaModels ?? []),
    new ClaudeLanguageModel(run, { model: "claude-haiku-4-5" }),
  ]);
  const result = await model.generateObject<{ verdict: "KEEP" | "SKIP" }>({
    systemPrompt: COMMENT_JUDGE_SYSTEM_PROMPT,
    prompt: body,
    schema: COMMENT_JUDGE_JSON_SCHEMA,
    maxTokens: 64,
  });
  return (result?.verdict ?? "KEEP") === "KEEP";
}
