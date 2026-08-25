import { assertEquals } from "@std/assert";
import {
  DEFAULT_PIPELINE_STEPS,
  nextPipelinePhase,
  type PipelineStep,
} from "./pipeline.ts";

Deno.test("DEFAULT_PIPELINE_STEPS matches the five runner phases in order", () => {
  assertEquals(DEFAULT_PIPELINE_STEPS, [
    { phase: "intake" },
    { phase: "enrichment" },
    { phase: "spec" },
    { phase: "plan" },
    { phase: "implementation" },
  ]);
});

Deno.test("nextPipelinePhase: walks the default steps in order", () => {
  assertEquals(
    nextPipelinePhase(DEFAULT_PIPELINE_STEPS, "intake"),
    "enrichment",
  );
  assertEquals(nextPipelinePhase(DEFAULT_PIPELINE_STEPS, "enrichment"), "spec");
  assertEquals(nextPipelinePhase(DEFAULT_PIPELINE_STEPS, "spec"), "plan");
  assertEquals(
    nextPipelinePhase(DEFAULT_PIPELINE_STEPS, "plan"),
    "implementation",
  );
});

Deno.test("nextPipelinePhase: returns 'done' after the last step", () => {
  assertEquals(
    nextPipelinePhase(DEFAULT_PIPELINE_STEPS, "implementation"),
    "done",
  );
});

Deno.test("nextPipelinePhase: walks a short two-step template directly from intake to implementation", () => {
  const steps = [{ phase: "intake" }, { phase: "implementation" }] as const;
  assertEquals(nextPipelinePhase([...steps], "intake"), "implementation");
});

Deno.test("nextPipelinePhase: returns 'done' for a phase not present in steps", () => {
  const steps: PipelineStep[] = [
    { phase: "intake" },
    { phase: "implementation" },
  ];
  assertEquals(nextPipelinePhase(steps, "spec"), "done");
});
