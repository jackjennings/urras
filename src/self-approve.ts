import { join } from "@std/path";
import { Data, Effect } from "effect";
import { findLatestPhaseOutput } from "./review.ts";
import { readTextFile } from "./filesystem.ts";
import type { LanguageModel } from "./models/types.ts";
import { runGit } from "./worktree.ts";
import { loadStatePrompt } from "./phases/runners.ts";

const PROMPT_DIR = new URL("./phases/prompts/", import.meta.url).pathname;

export class SelfReviewModelError
  extends Data.TaggedError("SelfReviewModelError")<Record<never, never>> {}

export type SelfReviewOutcome = {
  approved: boolean;
  reason: string | null;
};

async function executeReview({
  phase,
  ticketDir,
  model,
  worktreePath,
  stateDir,
  ticketId,
}: {
  phase: string;
  ticketDir: string;
  model: LanguageModel;
  worktreePath?: string;
  stateDir?: string;
  ticketId?: string;
}): Promise<SelfReviewOutcome> {
  let systemPrompt: string;
  try {
    systemPrompt = await readTextFile(
      join(PROMPT_DIR, `${phase}-self-approve.md`),
    );
  } catch {
    return { approved: false, reason: null };
  }

  if (stateDir) {
    const ticketProvider = ticketId?.split("/")[0];
    const supplement = await loadStatePrompt(
      `${phase}-self-approve`,
      stateDir,
      ticketProvider,
      ticketId,
    );
    if (supplement) systemPrompt += `\n\n${supplement}`;
  }

  const found = await findLatestPhaseOutput(ticketDir);
  if (!found) return { approved: false, reason: null };

  let outputContent = await readTextFile(
    join(ticketDir, found.filename),
  );

  if (ticketId) {
    outputContent = `## Ticket\n\n${ticketId}\n\n${outputContent}`;
  }

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

  const text = await model.generateText({
    systemPrompt: systemPrompt,
    prompt: outputContent,
  });
  if (text == null) throw new SelfReviewModelError();
  const firstLine = text.split("\n")[0].trim().toUpperCase();
  if (firstLine === "APPROVE") return { approved: true, reason: null };
  return { approved: false, reason: text.length > 0 ? text : null };
}

export function selfApprove(opts: {
  phase: string;
  ticketDir: string;
  model: LanguageModel;
  worktreePath?: string;
  stateDir?: string;
  ticketId?: string;
}): Effect.Effect<SelfReviewOutcome, SelfReviewModelError> {
  return Effect.tryPromise({
    try: () => executeReview(opts),
    catch: () => new SelfReviewModelError(),
  });
}
