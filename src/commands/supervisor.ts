import { join } from "@std/path";
import { expandHome, loadConfig as defaultLoadConfig } from "../config.ts";
import { isProcessAlive } from "../executor.ts";
import { mkdir, readTextFile, remove, writeTextFile } from "../filesystem.ts";
import { urrasDir } from "../paths.ts";
import { loadPromptFile, loadStatePrompt } from "../phases/runners.ts";
import type { Config } from "../state/types.ts";
import { makeDefaultSpawn } from "./brainstorm.ts";
import type { Command } from "./types.ts";

export function supervisorPidPath(): string {
  return join(urrasDir(), "supervisor.pid");
}

export async function readRunningSupervisorPid(
  deps: { isPidAlive?: (pid: number) => boolean } = {},
): Promise<number | null> {
  const isPidAlive = deps.isPidAlive ?? isProcessAlive;
  let raw: string;
  try {
    raw = await readTextFile(supervisorPidPath());
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
  const pid = parseInt(raw.trim(), 10);
  return Number.isInteger(pid) && isPidAlive(pid) ? pid : null;
}

export async function buildSupervisorPrompt(stateDir: string): Promise<string> {
  const builtIn = await loadPromptFile("supervisor.md");
  const overlay = await loadStatePrompt("supervisor", stateDir);
  return overlay ? `${builtIn}\n\n${overlay}` : builtIn;
}

export async function performSupervisor(deps?: {
  loadConfig?: () => Promise<Config>;
  spawn?: (prompt: string) => Promise<number>;
  isPidAlive?: (pid: number) => boolean;
  pid?: number;
}): Promise<number> {
  const existing = await readRunningSupervisorPid(deps);
  if (existing !== null) {
    console.error(`supervisor: already running (pid ${existing})`);
    return 1;
  }
  const config = await (deps?.loadConfig ?? defaultLoadConfig)();
  const prompt = await buildSupervisorPrompt(expandHome(config.state.dir));
  const spawnFn = deps?.spawn ?? makeDefaultSpawn(config);
  await mkdir(urrasDir(), { recursive: true });
  await writeTextFile(supervisorPidPath(), String(deps?.pid ?? Deno.pid));
  try {
    return await spawnFn(prompt);
  } finally {
    await remove(supervisorPidPath()).catch(() => {});
  }
}

export function buildRexSupervisorArgs(
  env: { session?: string; block?: string },
): string[] {
  if (!env.session) return ["run", "--", "ur", "supervisor"];
  return [
    "split",
    "-s",
    env.session,
    ...(env.block ? ["-b", env.block] : []),
    "--split=right",
    "--",
    "ur",
    "supervisor",
  ];
}

export type SupervisorPaneResult = "started" | "already-running" | "no-rex";

export async function launchSupervisorPane(deps?: {
  isPidAlive?: (pid: number) => boolean;
  env?: { session?: string; block?: string };
  runRex?: (args: string[]) => Promise<void>;
}): Promise<SupervisorPaneResult> {
  if (await readRunningSupervisorPid(deps) !== null) return "already-running";
  const env = deps?.env ?? {
    session: Deno.env.get("REX_SESSION"),
    block: Deno.env.get("REX_BLOCK"),
  };
  const runRex = deps?.runRex ?? (async (args) => {
    await new Deno.Command("rex", {
      args,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
  });
  try {
    await runRex(buildRexSupervisorArgs(env));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return "no-rex";
    throw e;
  }
  return "started";
}

export const supervisor: Command = {
  name: "supervisor",
  description: "start a supervisor agent that shepherds tickets",
  usage: "ur supervisor",
  async run() {
    try {
      Deno.exit(await performSupervisor());
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      Deno.exit(1);
    }
  },
};
