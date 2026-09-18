import { loadConfig } from "../config.ts";
import { runGit } from "../worktree.ts";
import type { Command } from "./types.ts";

const lazboyDir = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

export type Divergence = { ahead: number; behind: number };

export type UpdateOutcome =
  | { status: "pulled" }
  | { status: "current" }
  | { status: "dirty" }
  | { status: "diverged"; divergence: Divergence }
  | { status: "failed"; code: number };

async function readDivergence(
  dir: string,
  runGitFn: typeof runGit,
): Promise<Divergence | null> {
  const { code, stdout } = await runGitFn(
    ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
    dir,
  );
  if (code !== 0) return null;
  const [behind, ahead] = stdout.trim().split(/\s+/).map(Number);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) return null;
  if (ahead === 0 || behind === 0) return null;
  return { ahead, behind };
}

export async function runUpdate(
  dir: string,
  runGitFn: typeof runGit = runGit,
): Promise<UpdateOutcome> {
  const { stdout } = await runGitFn(["status", "--porcelain"], dir);
  if (stdout !== "") {
    return { status: "dirty" };
  }
  const { stdout: headBefore } = await runGitFn(["rev-parse", "HEAD"], dir);
  const { code } = await runGitFn(["pull"], dir);
  if (code !== 0) {
    const divergence = await readDivergence(dir, runGitFn);
    return divergence
      ? { status: "diverged", divergence }
      : { status: "failed", code };
  }
  const { stdout: headAfter } = await runGitFn(["rev-parse", "HEAD"], dir);
  return headBefore === headAfter
    ? { status: "current" }
    : { status: "pulled" };
}

export function outcomeExitCode(outcome: UpdateOutcome): number {
  if (outcome.status === "failed") return outcome.code;
  if (outcome.status === "pulled" || outcome.status === "current") return 0;
  return 1;
}

export async function updateExtensionsIfRemote(
  dir: string,
  runGitFn: typeof runGit = runGit,
): Promise<UpdateOutcome | null> {
  const { code } = await runGitFn(["remote", "get-url", "origin"], dir);
  if (code !== 0) return null;
  return runUpdate(dir, runGitFn);
}

export const update: Command = {
  name: "update",
  description: "pull latest urras source",
  async run(_args) {
    const selfOutcome = await runUpdate(lazboyDir);
    let extensionsDir: string | undefined;
    try {
      const config = await loadConfig();
      extensionsDir = config.extensions.dir;
    } catch {
      // No config file; skip extensions update.
    }
    if (extensionsDir !== undefined) {
      await updateExtensionsIfRemote(extensionsDir);
    }
    Deno.exit(outcomeExitCode(selfOutcome));
  },
};
