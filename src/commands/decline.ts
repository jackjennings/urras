import {
  appendTicketLog,
  commitTicket,
  readTicketWithPatch,
} from "../state/store.ts";
import { join } from "@std/path";
import { deleteRunPid, isPhaseAlive } from "../executor.ts";
import { expandHome, loadConfig } from "../config.ts";
import type { TicketPhase } from "../state/types.ts";
import type { Command } from "./types.ts";
import { readTextFileSync } from "../filesystem.ts";

function defaultKillFn(pid: number): void {
  try {
    Deno.kill(pid, "SIGTERM");
  } catch {
    // process died between liveness check and kill
  }
}

export async function performDecline(
  stateDir: string,
  id: string,
  reason?: string,
  {
    commitFn = commitTicket,
    killFn = defaultKillFn,
    readTicketFn = readTicketWithPatch,
  }: {
    commitFn?: typeof commitTicket;
    killFn?: (pid: number) => void;
    readTicketFn?: typeof readTicketWithPatch;
  } = {},
): Promise<{ from: TicketPhase }> {
  const ticketDir = join(stateDir, id);

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

  const { ticket, patchTicket } = await readTicketFn(stateDir, id);
  const from = ticket.phase;

  await patchTicket({
    phase: "wont-do",
    status: "done",
    updated: Temporal.Now.instant().toString(),
    body: reason ? `${ticket.body}\n\n---\nDeclined: ${reason}` : ticket.body,
  });

  await appendTicketLog(stateDir, id, {
    event: "phase-transition",
    from,
    to: "wont-do",
  });

  await commitFn(stateDir, id, `decline: ${id}`);

  return { from };
}

export const decline: Command = {
  name: "decline",
  description: "permanently exclude a ticket from the queue",
  usage: "ur decline <ticket-id> [reason]",
  completesWith: "_ids",
  async run(args) {
    const id = args[0];
    if (!id) {
      console.error("Usage: ur decline <ticket-id> [reason]");
      Deno.exit(1);
    }
    const config = await loadConfig();
    const stateDir = expandHome(config.state.dir);
    try {
      await performDecline(stateDir, id, args[1]);
    } catch (e) {
      if (e instanceof Error) {
        console.error(`Error: ${e.message}`);
      }
      Deno.exit(1);
    }
    console.log(`Declined ${id}`);
  },
};
