import {
  appendTicketLog,
  commitTicket,
  readTicketWithPatch,
} from "../state/store.ts";
import { expandHome, loadConfig } from "../config.ts";
import type { Command } from "./types.ts";

export async function performDeprioritize(
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

  if (ticket.prioritized !== true) return;

  await patchTicket({
    prioritized: undefined,
    updated: Temporal.Now.instant().toString(),
  });

  await appendTicketLog(stateDir, id, { event: "deprioritized" });
  await commit(stateDir, id, `deprioritize: ${id}`);
}

export const deprioritize: Command = {
  name: "deprioritize",
  description: "return a prioritized ticket to normal rotation",
  usage: "ur deprioritize <ticket-id>",
  completesWith: "_ids",
  async run(args) {
    const id = args[0];
    if (!id) {
      console.error("Usage: ur deprioritize <ticket-id>");
      Deno.exit(1);
    }
    const config = await loadConfig();
    const stateDir = expandHome(config.state.dir);
    try {
      await performDeprioritize(stateDir, id);
    } catch (e) {
      if (e instanceof Error) {
        console.error(`Error: ${e.message}`);
      }
      Deno.exit(1);
    }
    console.log(`Deprioritized ${id}`);
  },
};
