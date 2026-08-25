import { loadConfig as defaultLoadConfig } from "../config.ts";
import type { Config } from "../state/types.ts";
import type { Command } from "./types.ts";
import { collectScopes, inferProvider } from "./capture.ts";

export function buildSystemPrompt(opts: {
  scope: string;
  provider: "github" | "jira";
  initialIdea?: string;
}): string {
  const providerLabel = opts.provider === "github" ? "GitHub" : "Jira";
  const lines = [
    "You are a brainstorming assistant helping the user refine a software idea into a well-scoped ticket.",
    "",
    `The ticket will be filed to the ${providerLabel} scope: ${opts.scope}`,
    "",
    "Ask questions to understand the problem, the proposed solution, and any constraints.",
    "When the user is satisfied and ready to file the ticket, call the following command using the Bash tool:",
    "",
    "```",
    `ur capture --title "<concise title>" --scope ${opts.scope} --body "<markdown body>"`,
    "```",
    "",
    "Format the --body value as Markdown with exactly two sections:",
    "  ## Problem",
    "  ## Proposed Solution",
    "",
    "Do not call ur capture until the user explicitly confirms they are done refining.",
  ];
  if (opts.initialIdea) {
    lines.push("", `The user's initial idea: ${opts.initialIdea}`);
  }
  return lines.join("\n");
}

async function defaultPrompt(question: string): Promise<string | null> {
  await Deno.stdout.write(new TextEncoder().encode(`${question} `));
  const buf = new Uint8Array(256);
  const n = await Deno.stdin.read(buf);
  if (n === null) return null;
  return new TextDecoder().decode(buf.subarray(0, n)).trim();
}

function makeDefaultSpawn(config: Config): (prompt: string) => Promise<number> {
  if (config.agent.type === "pi") {
    return async (prompt) => {
      const child = new Deno.Command("pi", {
        args: [
          "--system-prompt",
          prompt,
          "--approve",
          "--provider",
          config.pi.provider,
        ],
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }).spawn();
      const status = await child.status;
      return status.code;
    };
  }
  return async (prompt) => {
    const child = new Deno.Command("claude", {
      args: [prompt, "--dangerously-skip-permissions"],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    const status = await child.status;
    return status.code;
  };
}

export async function performBrainstorm(
  opts: { initialIdea?: string },
  deps?: {
    loadConfig?: () => Promise<Config>;
    prompt?: (question: string) => Promise<string | null>;
    spawn?: (prompt: string) => Promise<number>;
  },
): Promise<number> {
  const config = await (deps?.loadConfig ?? defaultLoadConfig)();

  const scopes = collectScopes(config);
  if (scopes.length === 0) {
    throw new Error(
      "brainstorm: no scopes configured (add github.repos or [jira] to config.toml)",
    );
  }

  let scope: string;
  if (scopes.length === 1) {
    scope = scopes[0];
  } else {
    const promptFn = deps?.prompt ?? defaultPrompt;
    console.log("Select a scope:");
    scopes.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    let selection = -1;
    while (selection < 1 || selection > scopes.length) {
      const raw = await promptFn(`Enter a number (1-${scopes.length}):`);
      if (raw === null) throw new Error("brainstorm: no input (stdin closed)");
      const parsed = parseInt(raw, 10);
      if (!isNaN(parsed) && parsed >= 1 && parsed <= scopes.length) {
        selection = parsed;
      } else {
        console.log(`Please enter a number between 1 and ${scopes.length}.`);
      }
    }
    scope = scopes[selection - 1];
  }

  const provider = inferProvider(scope);
  const systemPrompt = buildSystemPrompt({
    scope,
    provider,
    initialIdea: opts.initialIdea,
  });
  const spawnFn = deps?.spawn ?? makeDefaultSpawn(config);
  return await spawnFn(systemPrompt);
}

export const brainstorm: Command = {
  name: "brainstorm",
  description: "start an interactive session to draft a ticket",
  usage: "ur brainstorm [initial idea]",
  async run(args) {
    const initialIdea = args.length > 0 ? args.join(" ") : undefined;
    try {
      const code = await performBrainstorm({ initialIdea });
      Deno.exit(code);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      Deno.exit(1);
    }
  },
};
