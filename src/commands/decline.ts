import {
  appendTicketLog,
  commitTicket,
  readTicket,
  StaleTicketWriteError,
  writeTicket,
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
    readTicketFn = readTicket,
    writeTicketFn = writeTicket,
  }: {
    commitFn?: typeof commitTicket;
    killFn?: (pid: number) => void;
    readTicketFn?: typeof readTicket;
    writeTicketFn?: typeof writeTicket;
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

  let ticket = await readTicketFn(stateDir, id);
  const from = ticket.phase;

  const buildMutation = (t: typeof ticket) => ({
    ...t,
    phase: "wont-do" as const,
    status: "done" as const,
    updated: Temporal.Now.instant().toString(),
    body: reason ? `${t.body}\n\n---\nDeclined: ${reason}` : t.body,
  });

  try {
    await writeTicketFn(stateDir, buildMutation(ticket));
  } catch (e) {
    if (!(e instanceof StaleTicketWriteError)) throw e;
    ticket = await readTicketFn(stateDir, id);
    await writeTicketFn(stateDir, buildMutation(ticket));
  }

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
