import type { WorktreeInfo } from "./state/types.ts";
import { readTextFileSync, remove, writeTextFile } from "./filesystem.ts";
import { bootId } from "./paths.ts";

export interface ExecutorOptions {
  ticketDir: string;
  stateDir: string;
  prompt: string;
  scopeDirs: string[];
  outputFile: string;
  githubToken: string;
  anthropicApiKey: string;
  worktrees: Record<string, WorktreeInfo>;
  provider: string;
  model: string;
  thinking: string;
  critiqueModel?: string;
  critiqueThinking?: string;
  agent: "pi" | "claude-code";
  contextFiles?: string[];
  pidFile?: string;
  sessionId?: string;
  resume?: boolean;
  includePrinciples?: boolean;
  maxTurns?: number;
  ollamaModels?: Array<{ model: string; url?: string }>;
}

export function isProcessAlive(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
}

export function buildPhaseArgs(opts: ExecutorOptions): string[] {
  const runPhaseScript = new URL("./run-phase.ts", import.meta.url).pathname;
  const phase = opts.outputFile.replace(/\.md$/, "");
  const args = [
    "run",
    "--allow-all",
    runPhaseScript,
    "--ticket-dir",
    opts.ticketDir,
    "--output-file",
    opts.outputFile,
    "--phase",
    phase,
    "--scope",
    opts.scopeDirs.join(","),
    "--prompt",
    opts.prompt,
    "--worktrees",
    JSON.stringify(opts.worktrees),
  ];
  args.push(
    "--provider",
    opts.provider,
    "--model",
    opts.model,
    "--thinking",
    opts.thinking,
    "--agent",
    opts.agent,
  );
  if (opts.critiqueModel !== undefined) {
    args.push("--critique-model", opts.critiqueModel);
  }
  if (opts.critiqueThinking !== undefined) {
    args.push("--critique-thinking", opts.critiqueThinking);
  }
  args.push("--state-dir", opts.stateDir);
  if (opts.contextFiles) {
    args.push("--context-files", opts.contextFiles.join(","));
  }
  if (opts.sessionId) {
    args.push("--session-id", opts.sessionId);
  }
  if (opts.resume === true) {
    args.push("--resume");
  }
  if (opts.includePrinciples === false) {
    args.push("--skip-principles");
  }
  if (opts.ollamaModels && opts.ollamaModels.length > 0) {
    args.push("--ollama-models", JSON.stringify(opts.ollamaModels));
  }
  return args;
}

export function buildPhaseEnvOverrides(
  opts: ExecutorOptions,
): Record<string, string> {
  const binDir = new URL("../bin", import.meta.url).pathname;
  const existingPath = Deno.env.get("PATH");
  const overrides: Record<string, string> = {
    GITHUB_TOKEN: opts.githubToken,
    GH_TOKEN: opts.githubToken,
    ANTHROPIC_API_KEY: opts.anthropicApiKey,
    PATH: existingPath ? `${binDir}:${existingPath}` : binDir,
  };
  if (opts.maxTurns !== undefined) {
    if (opts.agent === "claude-code") {
      overrides["CLAUDE_MAX_TURNS"] = String(opts.maxTurns);
    } else {
      overrides["PI_MAX_TURNS"] = String(opts.maxTurns);
    }
  }
  return overrides;
}

export async function spawnPhase(opts: ExecutorOptions): Promise<void> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: buildPhaseArgs(opts),
    env: {
      ...Deno.env.toObject(),
      ...buildPhaseEnvOverrides(opts),
    },
    stdin: "null",
    stdout: "null",
    stderr: "null",
  });
  const child = cmd.spawn();
  child.unref();
  await writeTextFile(
    `${opts.ticketDir}/${opts.pidFile ?? "run.pid"}`,
    `${child.pid}\n${bootId()}`,
  );
}

export function isPhaseAlive(ticketDir: string): boolean {
  let content: string;
  try {
    content = readTextFileSync(`${ticketDir}/run.pid`);
  } catch {
    return false;
  }
  const lines = content.trim().split("\n");
  const pid = parseInt(lines[0], 10);
  if (isNaN(pid)) return false;
  if (lines[1] !== undefined && lines[1] !== bootId()) return false;
  return isProcessAlive(pid);
}

export async function deleteRunPid(ticketDir: string): Promise<void> {
  try {
    await remove(`${ticketDir}/run.pid`);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}
