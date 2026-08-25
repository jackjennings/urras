import type { ActivePhase } from "./types.ts";
import { PHASE_SEQUENCE } from "./types.ts";

export interface PipelineStep {
  phase: ActivePhase;
}

export interface PipelineTemplate {
  name: string;
  description?: string;
  steps: PipelineStep[];
}

export const DEFAULT_PIPELINE_STEPS: PipelineStep[] = PHASE_SEQUENCE.map(
  (phase) => ({ phase }),
);

export function nextPipelinePhase(
  steps: PipelineStep[],
  current: ActivePhase,
): ActivePhase | "done" {
  const idx = steps.findIndex((s) => s.phase === current);
  if (idx === -1 || idx === steps.length - 1) return "done";
  return steps[idx + 1].phase;
}
