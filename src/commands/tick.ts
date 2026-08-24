import { loadConfig } from "../config.ts";
import { composeTickDeps } from "../compose.ts";
import { TickService } from "../tick.ts";
import { appendTickLog } from "../logger.ts";
import { runUpdate } from "./update.ts";
import type { Divergence, UpdateOutcome } from "./update.ts";
import {
  makeDivergenceNotifier,
  readLastDivergence,
  writeLastDivergence,
} from "../update-divergence.ts";
import { makeDesktopNotifier } from "../notify.ts";
import { defaultCommandRunner } from "../apfel.ts";
import type { Command } from "./types.ts";

export type TickUpdateDeps = {
  updateFn: (dir: string) => Promise<UpdateOutcome>;
  logFn: typeof appendTickLog;
  reexecFn: (indexPath: string) => Promise<void>;
  notifyDivergenceFn: (divergence: Divergence | null) => Promise<void>;
};

export async function performTickUpdate(
  deps: TickUpdateDeps,
): Promise<boolean> {
  const srcDir = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
  const outcome = await deps.updateFn(srcDir);
  if (outcome.status === "pulled") {
    const indexPath = new URL("../../index.ts", import.meta.url).pathname;
    await deps.reexecFn(indexPath);
    return false;
  }
  if (outcome.status === "current") {
    await deps.notifyDivergenceFn(null);
    return true;
  }
  if (outcome.status === "dirty") {
    await deps.logFn({ event: "update-skipped", reason: "dirty" });
    return true;
  }
  if (outcome.status === "diverged") {
    const { ahead, behind } = outcome.divergence;
    await deps.logFn({
      event: "update-skipped",
      reason: "diverged",
      ahead,
      behind,
    });
    await deps.notifyDivergenceFn(outcome.divergence);
    return true;
  }
  await deps.logFn({ event: "update-failed", code: outcome.code });
  return true;
}

async function defaultReexec(indexPath: string): Promise<void> {
  const p = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", indexPath, "tick", ...Deno.args],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const { code } = await p.status;
  Deno.exit(code);
}

export const tick: Command = {
  name: "tick",
  description: "advance all active tickets",
  async run(_args) {
    if (
      !(await performTickUpdate({
        updateFn: runUpdate,
        logFn: appendTickLog,
        reexecFn: defaultReexec,
        notifyDivergenceFn: makeDivergenceNotifier({
          notify: makeDesktopNotifier({ runCommand: defaultCommandRunner() }),
          readLast: readLastDivergence,
          writeLast: writeLastDivergence,
        }),
      }))
    ) return;
    const config = await loadConfig();
    const deps = composeTickDeps(config);
    await new TickService(deps).run();
  },
};
