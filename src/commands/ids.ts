import { listTickets } from "../state/store.ts";
import { expandHome, loadConfig } from "../config.ts";
import type { Command } from "./types.ts";
import { join } from "@std/path";
import { readDir } from "../filesystem.ts";
import { BUILT_IN_CEREMONY_NAMES } from "../ceremonies/built-ins.ts";

export async function listCeremonyIds(stateDir: string): Promise<string[]> {
  const ids: string[] = [];
  try {
    for await (const entry of readDir(join(stateDir, "ceremonies"))) {
      if (!entry.isDirectory) continue;
      if (
        (BUILT_IN_CEREMONY_NAMES as ReadonlyArray<string>).includes(entry.name)
      ) continue;
      ids.push(`ceremony/${entry.name}`);
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return ids.sort();
}

export const ids: Command = {
  name: "_ids",
  async run(_args) {
    const config = await loadConfig();
    const stateDir = expandHome(config.state.dir);
    const ticketIds = await listTickets(stateDir);
    for (const id of ticketIds) {
      console.log(id);
    }
    for (const id of await listCeremonyIds(stateDir)) {
      console.log(id);
    }
  },
};
