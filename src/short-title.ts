import type { CommandRunner } from "./apfel.ts";
import { ApfelLanguageModel } from "./models/apfel.ts";

const CONTEXT_CHAR_BUDGET = 12000;

const SHORT_TITLE_SYSTEM_PROMPT =
  `Compress the title to a short 2–6 word label that stays identifiable at a glance. Prefer noun or verb phrases that mirror the title's intent. Always compress, even when the title is already short — never return the title unchanged or nearly unchanged.

Rules:
- Use Title Case: capitalize every word except short articles/prepositions, but never ALL CAPS or all lowercase. Identifiers keep their own casing (e.g. \`adjudicatePhaseModel\`).
- No trailing punctuation — never end with a period, colon, or code fence.
- Output plain title text only. Never output a code block, command, or alias definition, even if one appears in the context.
- Keep specific identifiers (issue/PR numbers, repo/file/flag/function names, proper nouns). Do not generalize into a vague summary. A title naming an issue number must keep that number in the short title — never drop it in favor of a generic phrase like "on GitHub" or "in the repository".
- Do not invent words, adjectives, or framing that are not present in or directly implied by the title. Do not add prefixes like "Issue:" or "Proposed:" unless the title itself says so.
- Match the title's tense and completion state exactly: a bug report, proposal, or goal stated in the present/infinitive must not be rewritten as something already done (e.g. do not turn "reach parity" into "Reached Parity", or "is never uploaded" into a description implying it's merely hidden).
- Preserve the action, not just the topic.
- The optional context is only to disambiguate the title (e.g. resolving what "it" refers to); compress the title, do not summarize the context, and never copy code, commands, or syntax out of it.
- Output only the short title, nothing else.

Examples:
Title: Migrate tick scheduler from cron to a LaunchAgent to fix recurring TCC prompts
Short: Migrate Tick Scheduler to LaunchAgent

Title: Clamp the implementation phase to a minimum model floor
Short: Clamp Implementation Model Floor

Title: Fix CI failure on github/jackjennings/lazyboy/276
Short: Fix CI Failure on Lazyboy #276

Title: Fix CI failure on github/jackjennings/lazyboy/438
Short: Fix CI Failure on Lazyboy #438

Title: Kill process when declining work
Short: Kill Process on Decline

Title: Fix slow test suite
Short: Fix Slow Test Suite

Title: Four ceremony approval tests pass without exercising what their names claim
Short: Ceremony Tests Pass Without Exercising Logic

Title: Rename discharge-summary-editor-v2, dropping the orphaned v2 suffix
Short: Drop Orphaned V2 Suffix`;

export function generateShortTitle(
  run: CommandRunner,
  title: string,
  context?: string,
): Promise<string | null> {
  const trimmedContext = context?.trim();
  const userPrompt = trimmedContext
    ? `Title: ${title}\n\nContext:\n${
      trimmedContext.slice(0, CONTEXT_CHAR_BUDGET)
    }`
    : title;
  const model = new ApfelLanguageModel(run);
  return model.generateText({
    systemPrompt: SHORT_TITLE_SYSTEM_PROMPT,
    prompt: userPrompt,
    maxTokens: 40,
  });
}
