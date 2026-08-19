import type { CommandRunner } from "./apfel.ts";
import { ClaudeLanguageModel } from "./models/claude.ts";

const SYSTEM_PROMPT =
  `You are implementing a TickAction — a per-tick behavior that runs identically every time it fires.

A TickAction is a TypeScript module in src/tick-actions/ with this shape:

  export interface <Name>Deps { ... }
  export function <name>Action(deps: <Name>Deps): TickAction { ... }

The TickAction interface is:

  interface TickAction {
    label?: string;
    applies(ticket: TicketState): boolean;
    run(ticket: TicketState, stateDir: string): Promise<TicketState | null>;
  }

You are given:
- A learning intent describing the reusable procedure this TickAction must implement.
- The path where the new file should be created.
- The full current content of src/compose.ts, where TickActions are registered in the \`tickActions\` array inside \`composeTickDeps\`.

Generate the TypeScript source for the new TickAction and the complete updated compose.ts with the new action imported and appended to the \`tickActions\` array. The generated TickAction's \`applies\` predicate must exclude tickets where \`isPhaseAlive\` is true and must guard \`status === "needs-attention"\` if the action can park a ticket.

Return the TickAction source wrapped in <tick-action-source> and </tick-action-source> tags, then the complete updated compose.ts wrapped in <updated-compose> and </updated-compose> tags. No other commentary.`;

interface GeneratedTickAction {
  tickActionSource: string;
  updatedCompose: string;
}

function extractGeneratedTickAction(text: string): GeneratedTickAction | null {
  const trimmed = text.trim();
  const srcOpen = trimmed.indexOf("<tick-action-source>");
  const srcClose = trimmed.lastIndexOf("</tick-action-source>");
  const composeOpen = trimmed.indexOf("<updated-compose>");
  const composeClose = trimmed.lastIndexOf("</updated-compose>");
  if (
    srcOpen === -1 || srcClose === -1 || srcClose <= srcOpen ||
    composeOpen === -1 || composeClose === -1 || composeClose <= composeOpen
  ) {
    return null;
  }
  const tickActionSource = trimmed.slice(
    srcOpen + "<tick-action-source>".length,
    srcClose,
  );
  const updatedCompose = trimmed.slice(
    composeOpen + "<updated-compose>".length,
    composeClose,
  );
  if (!tickActionSource || !updatedCompose) return null;
  return { tickActionSource, updatedCompose };
}

export async function applyTickActionLearning(opts: {
  targetFile: string;
  composeContent: string;
  intent: string;
  run: CommandRunner;
}): Promise<GeneratedTickAction | null> {
  const { targetFile, composeContent, intent, run } = opts;
  const userMessage =
    `## Learning intent\n\n${intent}\n\n## Target file\n\n${targetFile}\n\n## Current compose.ts\n\n${composeContent}`;
  const model = new ClaudeLanguageModel(run, { model: "claude-sonnet-4-6" });
  const text = await model.generateText({
    systemPrompt: SYSTEM_PROMPT,
    prompt: userMessage,
  });
  return text != null ? extractGeneratedTickAction(text) : null;
}
