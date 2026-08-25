import { join } from "@std/path";
import type { TickAction } from "./types.ts";
import { isApproved, type TicketState } from "../state/types.ts";
import type { CommandRunner } from "../apfel.ts";
import {
  DEFAULT_PIPELINE_STEPS,
  listAvailablePipelines,
  loadPipelineTemplate,
  type PipelineStep,
} from "../phases/pipeline.ts";
import { extractIntakePipeline } from "../extract-pipeline.ts";

export interface ResolvePipelineDeps {
  readIntakeOutput: (ticketDir: string) => Promise<string | null>;
  run: CommandRunner;
  extensionsDir: string;
  defaultPipelineName?: string;
  writeTicket: (stateDir: string, t: TicketState) => Promise<void>;
  appendLog: (stateDir: string, id: string, entry: object) => Promise<void>;
}

interface Resolved {
  name: string;
  steps: PipelineStep[];
  invalid?: { requestedName: string; reason: string };
}

async function resolveByName(
  deps: ResolvePipelineDeps,
  name: string,
): Promise<Resolved> {
  if (name === "default") {
    return { name: "default", steps: DEFAULT_PIPELINE_STEPS };
  }
  const result = await loadPipelineTemplate(deps.extensionsDir, name);
  if (result.ok) return { name, steps: result.template.steps };
  return {
    name: "default",
    steps: DEFAULT_PIPELINE_STEPS,
    invalid: { requestedName: name, reason: result.reason },
  };
}

export function resolvePipelineAction(
  deps: ResolvePipelineDeps,
): TickAction {
  return {
    label: "Resolving pipeline",
    applies(ticket: TicketState): boolean {
      return (
        ticket.phase === "intake" &&
        ticket.status === "waiting" &&
        isApproved(ticket) &&
        ticket.pipelineSteps === undefined
      );
    },
    async run(
      ticket: TicketState,
      stateDir: string,
    ): Promise<TicketState | null> {
      const now = Temporal.Now.instant().toString();
      const ticketDir = join(stateDir, ticket.id);

      const available = await listAvailablePipelines(deps.extensionsDir);
      const availableNames = available.map((t) => t.name);

      const intakeContent = await deps.readIntakeOutput(ticketDir);
      const requestedName = intakeContent !== null
        ? await extractIntakePipeline(intakeContent, deps.run, availableNames)
        : null;

      const nameToResolve = requestedName ?? deps.defaultPipelineName ??
        "default";
      const resolved = await resolveByName(deps, nameToResolve);

      const updated: TicketState = {
        ...ticket,
        pipeline: resolved.name,
        pipelineSteps: resolved.steps,
        updated: now,
      };
      await deps.writeTicket(stateDir, updated);

      if (resolved.invalid) {
        await deps.appendLog(stateDir, ticket.id, {
          event: "pipeline-invalid",
          requestedName: resolved.invalid.requestedName,
          reason: resolved.invalid.reason,
        });
      } else if (requestedName === null) {
        await deps.appendLog(stateDir, ticket.id, {
          event: "pipeline-defaulted",
          pipeline: resolved.name,
        });
      } else {
        await deps.appendLog(stateDir, ticket.id, {
          event: "pipeline-corrected",
          pipeline: resolved.name,
        });
      }
      return updated;
    },
  };
}
