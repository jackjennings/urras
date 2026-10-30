import {
  appendTicketLog,
  commitTicket,
  readTicketWithPatch,
} from "../state/store.ts";
import { expandHome, loadConfig } from "../config.ts";
import type { Command } from "./types.ts";
import {
  type CircuitBreaker,
  JsonFileBreaker,
  NoOpBreaker,
} from "../circuit-breaker.ts";
import { join } from "@std/path";
import { urrasDir } from "../paths.ts";
import { appendTickLog } from "../logger.ts";

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

export async function performBreakerReset(
  breaker: CircuitBreaker,
  deps: { appendTickLog: (entry: object) => Promise<void> },
): Promise<void> {
  await breaker.reset();
  await deps.appendTickLog({ event: "usage-limit-cleared" });
}

export const resume: Command = {
  name: "resume",
  description: "release a held ticket or reset the usage-limit breaker",
  usage: "ur resume [ticket-id]",
  completesWith: "_ids",
  async run(args) {
    const id = args[0];
    const config = await loadConfig();
    if (!id) {
      const breaker = config.limits?.pauseOnUsageLimit !== false
        ? new JsonFileBreaker("claude-usage", join(urrasDir(), "breakers"), {
          defaultPauseMinutes: config.limits?.defaultPauseMinutes ?? 60,
          appendTickLog,
        })
        : new NoOpBreaker("claude-usage");
      await performBreakerReset(breaker, { appendTickLog });
      console.log("Breaker reset.");
      return;
    }
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
