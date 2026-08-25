import {
  appendTicketLog,
  commitTicket,
  readTicketWithPatch,
} from "../state/store.ts";
import { expandHome, loadConfig } from "../config.ts";
import type { TicketPhase, TicketStatus } from "../state/types.ts";
import type { Command } from "./types.ts";

export async function performRetry(
  stateDir: string,
  id: string,
  {
    commitFn = commitTicket,
    readTicketFn = readTicketWithPatch,
  }: {
    commitFn?: typeof commitTicket;
    readTicketFn?: typeof readTicketWithPatch;
  } = {},
): Promise<{ phase: TicketPhase; targetStatus: TicketStatus }> {
  const { ticket, patchTicket } = await readTicketFn(stateDir, id);

  if (ticket.status !== "needs-attention") {
    throw new Error(
      `ticket ${id} is not in needs-attention status (current: ${ticket.phase}/${ticket.status})`,
    );
  }

  const targetStatus: TicketStatus = ticket.phase === "intake"
    ? "new"
    : "waiting";

  await patchTicket({
    status: targetStatus,
    updated: Temporal.Now.instant().toString(),
  });

  await appendTicketLog(stateDir, id, {
    event: "status-transition",
    phase: ticket.phase,
    from: "needs-attention",
    to: targetStatus,
  });

  await commitFn(stateDir, id, `retry: ${id}`);

  return { phase: ticket.phase, targetStatus };
}

export const retry: Command = {
  name: "retry",
  description: "reset a needs-attention ticket",
  usage: "ur retry <ticket-id>",
  completesWith: "_ids",
  async run(args) {
    const id = args[0];
    if (!id) {
      console.error("Usage: ur retry <ticket-id>");
      Deno.exit(1);
    }
    const config = await loadConfig();
    const stateDir = expandHome(config.state.dir);
    let result: { phase: TicketPhase; targetStatus: TicketStatus };
    try {
      result = await performRetry(stateDir, id);
    } catch (e) {
      if (e instanceof Error) {
        console.error(`Error: ${e.message}`);
      }
      Deno.exit(1);
    }
    console.log(
      `Retried ${id} (phase: ${result.phase}/${result.targetStatus})`,
    );
  },
};
