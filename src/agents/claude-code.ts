import type { CodeAgent } from "./types.ts";

const EFFORT_LEVELS: Record<string, string | undefined> = {
  off: undefined,
  minimal: undefined,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

function stripAtPrefix(f: string): string {
  return f.startsWith("@") ? f.slice(1) : f;
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "" : path.slice(0, idx);
}

export function deriveAddDirs(
  contextFiles: string[],
  cwd: string,
): string[] {
  const dirs = new Set<string>();
  for (const f of contextFiles) {
    const dir = parentDir(stripAtPrefix(f));
    if (dir === "" || dir === cwd || dir.startsWith(cwd + "/")) continue;
    dirs.add(dir);
  }
  return [...dirs].sort();
}

export function buildClaudeCodeArgs(opts: {
  prompt: string;
  model: string;
  thinking: string;
  contextFiles: string[];
  cwd: string;
  settingsPath: string;
  sessionId?: string;
  resume?: boolean;
  mcpConfigPath?: string;
}): string[] {
  const fileList = opts.contextFiles.length > 0
    ? "\n\nRead these files first:\n" +
      opts.contextFiles.map((f) => `- ${stripAtPrefix(f)}`).join("\n")
    : "";
  const fullPrompt = opts.prompt + fileList;

  const args = [
    fullPrompt,
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--setting-sources",
    "project,local",
    "--settings",
    opts.settingsPath,
    "--model",
    opts.model,
  ];

  const effort = EFFORT_LEVELS[opts.thinking];
  if (effort !== undefined) {
    args.push("--effort", effort);
  }

  if (opts.sessionId !== undefined) {
    if (opts.resume) {
      args.push("--resume", opts.sessionId);
    } else {
      args.push("--session-id", opts.sessionId);
    }
  }

  if (opts.mcpConfigPath !== undefined) {
    args.push("--mcp-config", opts.mcpConfigPath, "--strict-mcp-config");
  }

  const addDirs = deriveAddDirs(opts.contextFiles, opts.cwd);
  if (addDirs.length > 0) {
    args.push("--add-dir", ...addDirs);
  }

  return args;
}

export class ClaudeCodeAgent implements CodeAgent {
  constructor(private settingsPath: string) {}

  async runPhase(opts: {
    prompt: string;
    contextFiles: string[];
    cwd: string;
    env: Record<string, string>;
    provider: string;
    model: string;
    thinking: string;
    sessionId?: string;
    resume?: boolean;
    mcpConfigPath?: string;
  }): Promise<{ stdout: string; stderr: string; code: number }> {
    const result = await new Deno.Command("claude", {
      args: buildClaudeCodeArgs({
        prompt: opts.prompt,
        model: opts.model,
        thinking: opts.thinking,
        contextFiles: opts.contextFiles,
        cwd: opts.cwd,
        settingsPath: this.settingsPath,
        sessionId: opts.sessionId,
        resume: opts.resume,
        mcpConfigPath: opts.mcpConfigPath,
      }),
      cwd: opts.cwd,
      env: opts.env,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const decode = (b: Uint8Array) => new TextDecoder().decode(b);
    return {
      stdout: decode(result.stdout),
      stderr: decode(result.stderr),
      code: result.code,
    };
  }
}
