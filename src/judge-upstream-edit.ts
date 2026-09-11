import type { LanguageModel } from "./models/types.ts";
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
  model: LanguageModel,
): Promise<boolean | null> {
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
