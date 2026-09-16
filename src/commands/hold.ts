import {
  appendTicketLog,
  commitTicket,
  readTicketWithPatch,
} from "../state/store.ts";
import { expandHome, loadConfig } from "../config.ts";
import type { Command } from "./types.ts";

export async function performHold(
  stateDir: string,
  id: string,
  {
    commit = commitTicket,
    readTicket = readTicketWithPatch,
  }: {
    commit?: typeof commitTicket;
    readTicket?: typeof readTicketWithPatch;
  } = {},
): Promise<void> {
  const { ticket, patchTicket } = await readTicket(stateDir, id);

  if (ticket.phase === "wont-do") {
    throw new Error("Cannot hold a terminal ticket.");
  }

  if (ticket.held === true) return;

  await patchTicket({
    held: true,
    updated: Temporal.Now.instant().toString(),
  });

  await appendTicketLog(stateDir, id, { event: "held" });
  await commit(stateDir, id, `hold: ${id}`);
}

export const hold: Command = {
  name: "hold",
  description: "pause a ticket indefinitely without losing its place",
  usage: "ur hold <ticket-id>",
  completesWith: "_ids",
  async run(args) {
    const id = args[0];
    if (!id) {
      console.error("Usage: ur hold <ticket-id>");
      Deno.exit(1);
    }
    const config = await loadConfig();
    const stateDir = expandHome(config.state.dir);
    try {
      await performHold(stateDir, id);
    } catch (e) {
      if (e instanceof Error) {
        console.error(`Error: ${e.message}`);
      }
      Deno.exit(1);
    }
    console.log(`Held ${id}`);
  },
};
