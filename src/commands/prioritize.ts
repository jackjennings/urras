import {
  appendTicketLog,
  commitTicket,
  readTicketWithPatch,
} from "../state/store.ts";
import { expandHome, loadConfig } from "../config.ts";
import type { Command } from "./types.ts";

export async function performPrioritize(
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

  if (ticket.prioritized === true) return;

  await patchTicket({
    prioritized: true,
    updated: Temporal.Now.instant().toString(),
  });

  await appendTicketLog(stateDir, id, { event: "prioritized" });
  await commit(stateDir, id, `prioritize: ${id}`);
}

export const prioritize: Command = {
  name: "prioritize",
  description: "advance a ticket before normal candidates each tick",
  usage: "ur prioritize <ticket-id>",
  completesWith: "_ids",
  async run(args) {
    const id = args[0];
    if (!id) {
      console.error("Usage: ur prioritize <ticket-id>");
      Deno.exit(1);
    }
    const config = await loadConfig();
    const stateDir = expandHome(config.state.dir);
    try {
      await performPrioritize(stateDir, id);
    } catch (e) {
      if (e instanceof Error) {
        console.error(`Error: ${e.message}`);
      }
      Deno.exit(1);
    }
    console.log(`Prioritized ${id}`);
  },
};
