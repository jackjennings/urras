import { join } from "@std/path";
import { readDir } from "../src/filesystem.ts";
import type { Migration } from "../src/migrations/types.ts";

const migration: Migration = {
  async run(ticket, stateDir) {
    if (ticket.consumedContextFiles !== undefined) return ticket;

    const ticketDir = join(stateDir, ticket.id);
    const contextFiles: string[] = [];

    try {
      for await (const entry of readDir(ticketDir)) {
        if (
          entry.isFile &&
          (entry.name.endsWith("-comment-context.md") ||
            entry.name.endsWith("-upstream-edit-context.md"))
        ) {
          contextFiles.push(entry.name);
        }
      }
    } catch {
      return { ...ticket, consumedContextFiles: [] };
    }

    contextFiles.sort();

    // Mark all but the newest as consumed. The newest is the only file the
    // prior behavior would have injected, so it stays pending for the next
    // revising cycle.
    const consumed = contextFiles.slice(0, -1);

    return { ...ticket, consumedContextFiles: consumed };
  },
};

export default migration;
