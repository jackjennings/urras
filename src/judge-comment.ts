import type { LanguageModel } from "./models/types.ts";
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
  model: LanguageModel,
): Promise<boolean> {
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
