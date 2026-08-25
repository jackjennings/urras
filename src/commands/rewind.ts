import {
  appendTicketLog,
  commitTicket,
  readTicket,
  writeTicket,
} from "../state/store.ts";
import { join } from "@std/path";
import { deleteRunPid, isPhaseAlive } from "../executor.ts";
import { expandHome, loadConfig } from "../config.ts";
import { readDir, readTextFileSync, rename } from "../filesystem.ts";
import { PHASE_SEQUENCE } from "../phases/types.ts";
import { DEFAULT_PIPELINE_STEPS } from "../phases/pipeline.ts";
import type { ActivePhase } from "../phases/types.ts";
import type { TicketPhase } from "../state/types.ts";
import type { Command } from "./types.ts";

function defaultKillFn(pid: number): void {
  try {
    Deno.kill(pid, "SIGTERM");
  } catch {
    // process died between liveness check and kill
  }
}

async function archivePhaseFiles(
  ticketDir: string,
  phases: ReadonlyArray<string>,
): Promise<void> {
  const patterns = phases.flatMap((phase) => [
    new RegExp(`^\\d{8}T\\d{6}-${phase}\\.md$`),
    new RegExp(`^\\d{8}T\\d{6}-${phase}\\.md\\.exit$`),
    new RegExp(`^\\d{8}T\\d{6}-${phase}\\.md\\.session$`),
    new RegExp(`^\\d{8}T\\d{6}-${phase}\\.usage\\.json$`),
    new RegExp(`^\\d{8}T\\d{6}-${phase}-self-review\\.md$`),
    new RegExp(`^\\d{8}T\\d{6}-${phase}-feedback\\.md$`),
  ]);

  for await (const entry of readDir(ticketDir)) {
    if (!entry.isFile) continue;
    for (const pattern of patterns) {
      if (pattern.test(entry.name)) {
        await rename(
          join(ticketDir, entry.name),
          join(ticketDir, `${entry.name}.rewound`),
        );
        break;
      }
    }
  }
}

export async function performRewind(
  stateDir: string,
  id: string,
  targetPhase: ActivePhase,
  {
    commitFn = commitTicket,
    killFn = defaultKillFn,
  }: {
    commitFn?: typeof commitTicket;
    killFn?: (pid: number) => void;
  } = {},
): Promise<{ from: TicketPhase; to: ActivePhase }> {
  const ticketDir = join(stateDir, id);
  const ticket = await readTicket(stateDir, id);
  const from = ticket.phase;

  const allowedPhases = (ticket.pipelineSteps ?? DEFAULT_PIPELINE_STEPS).map(
    (s) => s.phase,
  );
  if (
    targetPhase !== "intake" &&
    !(allowedPhases as string[]).includes(targetPhase)
  ) {
    throw new Error(
      `Cannot rewind: target phase ${targetPhase} is not part of this ticket's pipeline (${
        allowedPhases.join(", ")
      }).`,
    );
  }

  const targetIdx = PHASE_SEQUENCE.indexOf(targetPhase);
  const rawCurrentIdx = PHASE_SEQUENCE.indexOf(ticket.phase as ActivePhase);
  const currentIdx = rawCurrentIdx === -1
    ? PHASE_SEQUENCE.length
    : rawCurrentIdx;

  if (targetIdx > currentIdx) {
    throw new Error(
      `Cannot rewind: target phase ${targetPhase} is after current phase ${ticket.phase}`,
    );
  }

  if (ticket.prs !== undefined && ticket.prs.length > 0) {
    throw new Error(
      `Cannot rewind: ticket has ${ticket.prs.length} PR(s). Close PRs before rewinding.`,
    );
  }

  if (isPhaseAlive(ticketDir)) {
    const content = readTextFileSync(`${ticketDir}/run.pid`);
    const pid = parseInt(content.trim(), 10);
    if (!isNaN(pid)) {
      try {
        killFn(pid);
      } catch {
        // TOCTOU: process died between isPhaseAlive and kill
      }
    }
  }

  await deleteRunPid(ticketDir);

  const phasesToArchive = PHASE_SEQUENCE.slice(targetIdx);
  await archivePhaseFiles(ticketDir, phasesToArchive);

  const newApprovals = ticket.approvals.filter(
    (entry) => PHASE_SEQUENCE.indexOf(entry.phase as ActivePhase) < targetIdx,
  );

  let newPhaseSessionIds: Partial<Record<string, string>> | undefined;
  if (ticket.phaseSessionIds) {
    const filtered = Object.fromEntries(
      Object.entries(ticket.phaseSessionIds).filter(
        ([phase]) => PHASE_SEQUENCE.indexOf(phase as ActivePhase) < targetIdx,
      ),
    );
    newPhaseSessionIds = Object.keys(filtered).length > 0
      ? filtered
      : undefined;
  }

  await writeTicket(stateDir, {
    ...ticket,
    phase: targetPhase,
    status: targetPhase === "intake" ? "new" : "waiting",
    approvals: newApprovals,
    phaseSessionIds: newPhaseSessionIds,
    outputRetries: undefined,
    notifiedNeedsAttention: undefined,
    pipeline: targetPhase === "intake" ? undefined : ticket.pipeline,
    pipelineSteps: targetPhase === "intake" ? undefined : ticket.pipelineSteps,
    updated: Temporal.Now.instant().toString(),
  });

  await appendTicketLog(stateDir, id, {
    event: "phase-transition",
    from,
    to: targetPhase,
  });

  await commitFn(stateDir, id, `rewind: ${id}`);

  return { from, to: targetPhase };
}

export const rewind: Command = {
  name: "rewind",
  description: "send a ticket back to an earlier phase",
  usage: "ur rewind <ticket-id> <target-phase>",
  completesWith: "_ids",
  async run(args) {
    const id = args[0];
    const targetPhaseArg = args[1];
    if (!id || !targetPhaseArg) {
      console.error("Usage: ur rewind <ticket-id> <target-phase>");
      Deno.exit(1);
    }
    if (!(PHASE_SEQUENCE as ReadonlyArray<string>).includes(targetPhaseArg)) {
      console.error(
        `Invalid target phase: ${targetPhaseArg}. Must be one of: ${
          PHASE_SEQUENCE.join(", ")
        }`,
      );
      Deno.exit(1);
    }
    const targetPhase = targetPhaseArg as ActivePhase;
    const config = await loadConfig();
    const stateDir = expandHome(config.state.dir);
    try {
      await performRewind(stateDir, id, targetPhase);
    } catch (e) {
      if (e instanceof Error) {
        console.error(`Error: ${e.message}`);
      }
      Deno.exit(1);
    }
    console.log(`Rewound ${id} to ${targetPhase}`);
  },
};
