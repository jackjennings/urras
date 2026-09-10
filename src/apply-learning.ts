import type { CommandRunner } from "./apfel.ts";
import { ClaudeLanguageModel } from "./models/claude.ts";
import { renderPrompt } from "./filesystem.ts";

function extractDocument(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const open = trimmed.indexOf("<updated-file>");
  const close = trimmed.lastIndexOf("</updated-file>");
  const inner = open !== -1 && close !== -1 && close > open
    ? trimmed.slice(open + "<updated-file>".length, close).trim()
    : trimmed;
  return `${inner}\n`;
}

export async function applyLearning(
  currentContent: string,
  intent: string,
  run: CommandRunner,
): Promise<string | null> {
  const userMessage =
    `## Learning to integrate\n\n${intent}\n\n## Current document\n\n${currentContent}`;
  const model = new ClaudeLanguageModel(run, { model: "claude-sonnet-4-6" });
  const text = await model.generateText({
    systemPrompt: await renderPrompt(
      new URL("./apply-learning.prompt.hbs", import.meta.url),
    ),
    prompt: userMessage,
  });
  return text != null ? extractDocument(text) : null;
}
