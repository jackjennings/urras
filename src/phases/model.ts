import type { Config, TicketState } from "../state/types.ts";
import type { ActivePhase } from "./types.ts";

export type ModelablePhase =
  | ActivePhase
  | "conflict-resolution"
  | "ci-fix"
  | "critique";

export const PHASE_MODEL_DEFAULTS: Record<
  ModelablePhase,
  { model: string; thinking: string }
> = {
  intake: { model: "claude-haiku-4-5", thinking: "off" },
  enrichment: { model: "claude-sonnet-4-6", thinking: "off" },
  spec: { model: "claude-sonnet-4-6", thinking: "high" },
  plan: { model: "claude-sonnet-4-6", thinking: "high" },
  implementation: { model: "claude-sonnet-4-6", thinking: "high" },
  "conflict-resolution": { model: "claude-opus-4-7", thinking: "high" },
  "ci-fix": { model: "claude-sonnet-4-6", thinking: "high" },
  critique: { model: "claude-sonnet-4-6", thinking: "off" },
};

export function resolvePhaseModel(
  config: Config,
  phase: ModelablePhase,
  ticket: TicketState,
): { model: string; thinking: string } {
  const ticketOverride = ticket.phases?.[phase];
  const configDefault = config.phases?.defaults?.[phase];
  const hardcoded = PHASE_MODEL_DEFAULTS[phase];
  return {
    model: ticketOverride?.model ?? configDefault?.model ?? hardcoded.model,
    thinking: ticketOverride?.thinking ?? configDefault?.thinking ??
      hardcoded.thinking,
  };
}
