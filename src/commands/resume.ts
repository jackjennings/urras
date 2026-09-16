import {
  appendTicketLog,
  commitTicket,
  readTicketWithPatch,
} from "../state/store.ts";
import { expandHome, loadConfig } from "../config.ts";
import type { Command } from "./types.ts";

export async function performResume(
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

  if (ticket.held !== true) return;

  await patchTicket({
    held: undefined,
    updated: Temporal.Now.instant().toString(),
  });

  await appendTicketLog(stateDir, id, { event: "resumed" });
  await commit(stateDir, id, `resume: ${id}`);
}

export const resume: Command = {
  name: "resume",
  description: "release a held ticket back into the queue",
  usage: "ur resume <ticket-id>",
  completesWith: "_ids",
  async run(args) {
    const id = args[0];
    if (!id) {
      console.error("Usage: ur resume <ticket-id>");
      Deno.exit(1);
    }
    const config = await loadConfig();
    const stateDir = expandHome(config.state.dir);
    try {
      await performResume(stateDir, id);
    } catch (e) {
      if (e instanceof Error) {
        console.error(`Error: ${e.message}`);
      }
      Deno.exit(1);
    }
    console.log(`Resumed ${id}`);
  },
};
