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

import { join } from "@std/path";
import { parse } from "@std/toml";
import { readDir, readTextFile } from "../filesystem.ts";

export type PipelineLoadFailureReason =
  | "template-not-found"
  | "template-parse-failed"
  | "template-invalid-shape"
  | "template-invalid-order";

export type PipelineLoadResult =
  | { ok: true; template: PipelineTemplate }
  | { ok: false; reason: PipelineLoadFailureReason };

function validateSteps(raw: unknown): PipelineStep[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const steps: PipelineStep[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const phase = (entry as Record<string, unknown>).phase;
    if (
      typeof phase !== "string" ||
      !(PHASE_SEQUENCE as readonly string[]).includes(phase)
    ) {
      return null;
    }
    steps.push({ phase: phase as ActivePhase });
  }
  return steps;
}

function isValidOrder(steps: PipelineStep[]): boolean {
  if (steps[0]?.phase !== "intake") return false;
  if (steps[steps.length - 1]?.phase !== "implementation") return false;
  const seen = new Set<ActivePhase>();
  let lastIndex = -1;
  for (const step of steps) {
    if (seen.has(step.phase)) return false;
    seen.add(step.phase);
    const index = PHASE_SEQUENCE.indexOf(step.phase);
    if (index <= lastIndex) return false;
    lastIndex = index;
  }
  return true;
}

export async function loadPipelineTemplate(
  extensionsDir: string,
  name: string,
): Promise<PipelineLoadResult> {
  const path = join(extensionsDir, "pipelines", name, "pipeline.toml");
  let raw: string;
  try {
    raw = await readTextFile(path);
  } catch {
    return { ok: false, reason: "template-not-found" };
  }
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch {
    return { ok: false, reason: "template-parse-failed" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.name !== name) {
    return { ok: false, reason: "template-invalid-shape" };
  }
  const steps = validateSteps(obj.steps);
  if (steps === null) {
    return { ok: false, reason: "template-invalid-shape" };
  }
  if (!isValidOrder(steps)) {
    return { ok: false, reason: "template-invalid-order" };
  }
  const template: PipelineTemplate = { name, steps };
  if (typeof obj.description === "string") {
    template.description = obj.description;
  }
  return { ok: true, template };
}

export async function listAvailablePipelines(
  extensionsDir: string,
): Promise<PipelineTemplate[]> {
  const pipelinesDir = join(extensionsDir, "pipelines");
  const names: string[] = [];
  try {
    for await (const entry of readDir(pipelinesDir)) {
      if (entry.isDirectory) names.push(entry.name);
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
  const templates: PipelineTemplate[] = [];
  for (const name of names) {
    const result = await loadPipelineTemplate(extensionsDir, name);
    if (result.ok) templates.push(result.template);
  }
  return templates;
}

export function formatAvailablePipelines(
  templates: PipelineTemplate[],
): string {
  if (templates.length === 0) return "";
  const lines = templates.map((t) =>
    t.description ? `- ${t.name}: ${t.description}` : `- ${t.name}`
  );
  return ["## Available Pipeline Templates", "", ...lines].join("\n") + "\n";
}
