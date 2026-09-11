import { captureCommandRunner, type CommandRunner } from "./apfel.ts";
import { ApfelLanguageModel } from "./models/apfel.ts";
import { ClaudeLanguageModel } from "./models/claude.ts";
import { FallbackLanguageModel } from "./models/fallback.ts";
import { OllamaLanguageModel } from "./models/ollama.ts";
import { renderPrompt } from "./filesystem.ts";

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
    systemPrompt: await renderPrompt(
      new URL("./judge-comment.prompt.hbs", import.meta.url),
    ),
    prompt: body,
    schema: COMMENT_JUDGE_JSON_SCHEMA,
    maxTokens: 64,
  });
  return (result?.verdict ?? "KEEP") === "KEEP";
}
