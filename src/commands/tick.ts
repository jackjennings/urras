import { loadConfig } from "../config.ts";
import { composeTickDeps } from "../compose.ts";
import { TickService } from "../tick.ts";
import { appendTickLog } from "../logger.ts";
import { runUpdate, updateExtensionsIfRemote } from "./update.ts";
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
  update: (dir: string) => Promise<UpdateOutcome>;
  log: typeof appendTickLog;
  reexec: (indexPath: string) => Promise<void>;
  notifyDivergence: (divergence: Divergence | null) => Promise<void>;
  updateExtensions: () => Promise<UpdateOutcome | null>;
};

export async function performTickUpdate(
  deps: TickUpdateDeps,
): Promise<boolean> {
  const srcDir = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
  const outcome = await deps.update(srcDir);
  if (outcome.status === "pulled") {
    const indexPath = new URL("../../index.ts", import.meta.url).pathname;
    await deps.reexec(indexPath);
    return false;
  }
  if (outcome.status === "current") {
    await deps.notifyDivergence(null);
  } else if (outcome.status === "dirty") {
    await deps.log({ event: "update-skipped", reason: "dirty" });
  } else if (outcome.status === "diverged") {
    const { ahead, behind } = outcome.divergence;
    await deps.log({
      event: "update-skipped",
      reason: "diverged",
      ahead,
      behind,
    });
    await deps.notifyDivergence(outcome.divergence);
  } else {
    await deps.log({ event: "update-failed", code: outcome.code });
  }
  const extOutcome = await deps.updateExtensions();
  if (extOutcome?.status === "dirty") {
    await deps.log({
      event: "update-skipped",
      reason: "dirty",
      target: "extensions",
    });
  } else if (extOutcome?.status === "diverged") {
    const { ahead, behind } = extOutcome.divergence;
    await deps.log({
      event: "update-skipped",
      reason: "diverged",
      ahead,
      behind,
      target: "extensions",
    });
  } else if (extOutcome?.status === "failed") {
    await deps.log({
      event: "update-failed",
      code: extOutcome.code,
      target: "extensions",
    });
  }
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
    const config = await loadConfig();
    if (
      !(await performTickUpdate({
        update: runUpdate,
        log: appendTickLog,
        reexec: defaultReexec,
        notifyDivergence: makeDivergenceNotifier({
          notify: makeDesktopNotifier({ runCommand: defaultCommandRunner() }),
          readLast: readLastDivergence,
          writeLast: writeLastDivergence,
        }),
        updateExtensions: () => updateExtensionsIfRemote(config.extensions.dir),
      }))
    ) return;
    const deps = composeTickDeps(config);
    await new TickService(deps).run();
  },
};
