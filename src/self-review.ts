import { join } from "@std/path";
import { findLatestPhaseOutput } from "./review.ts";
import type { CommandRunner } from "./apfel.ts";
import { readTextFile } from "./filesystem.ts";
import { ClaudeLanguageModel } from "./models/claude.ts";
import { FallbackLanguageModel } from "./models/fallback.ts";
import { OllamaLanguageModel } from "./models/ollama.ts";
import { runGit } from "./worktree.ts";

const PROMPT_DIR = new URL("./phases/prompts/", import.meta.url).pathname;

export async function selfReview({
  phase,
  ticketDir,
  run,
  worktreePath,
  ollamaModels,
}: {
  phase: string;
  ticketDir: string;
  run: CommandRunner;
  worktreePath?: string;
  ollamaModels?: OllamaLanguageModel[];
}): Promise<{ approved: boolean; reason: string | null }> {
  let systemPrompt: string;
  try {
    systemPrompt = await readTextFile(
      join(PROMPT_DIR, `${phase}-self-review.md`),
    );
  } catch {
    return { approved: false, reason: null };
  }

  const found = await findLatestPhaseOutput(ticketDir);
  if (!found) return { approved: false, reason: null };

  let outputContent = await readTextFile(
    join(ticketDir, found.filename),
  );

  if (worktreePath) {
    try {
      const { code, stdout } = await runGit(
        ["diff", "--name-only", "origin/main...HEAD"],
        worktreePath,
      );
      if (code === 0 && stdout) {
        outputContent += `\n\n## Changed Files\n${stdout.trim()}`;
      }
    } catch {
      // continue without diff
    }
  }

  const claude = new ClaudeLanguageModel(run, { model: "claude-haiku-4-5" });
  const model = ollamaModels && ollamaModels.length > 0
    ? new FallbackLanguageModel([...ollamaModels, claude])
    : claude;
  const text = await model.generateText({
    systemPrompt: systemPrompt,
    prompt: outputContent,
  });
  if (text == null) return { approved: false, reason: null };
  const firstLine = text.split("\n")[0].trim().toUpperCase();
  if (firstLine === "APPROVE") return { approved: true, reason: null };
  return { approved: false, reason: text.length > 0 ? text : null };
}
