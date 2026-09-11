import { join } from "@std/path";
import { parse } from "@std/toml";
import { compactTimestamp } from "../timestamp.ts";
import type { Ceremony } from "./types.ts";
import { renderPrompt } from "../filesystem.ts";

const EFFORT_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export interface PromptCeremonyDeps {
  name: string;
  ceremonyDir: string;
  appendTickLog(entry: object): Promise<void>;
  runClaude?: (args: string[]) => Promise<{ stdout: string; code: number }>;
}

export class PromptCeremony implements Ceremony {
  readonly name: string;
  readonly #deps: PromptCeremonyDeps;

  constructor(deps: PromptCeremonyDeps) {
    this.name = deps.name;
    this.#deps = deps;
  }

  async run(now: Temporal.ZonedDateTime, outputDir: string): Promise<void> {
    const ceremonyDir = this.#deps.ceremonyDir;

    let model = "claude-sonnet-4-6";
    let thinking = "off";
    try {
      const raw = await Deno.readTextFile(join(ceremonyDir, "config.toml"));
      const config = parse(raw) as Record<string, unknown>;
      if (typeof config.model === "string") model = config.model;
      if (
        typeof config.thinking === "string" &&
        EFFORT_LEVELS.has(config.thinking)
      ) {
        thinking = config.thinking;
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }

    let promptContent: string;
    try {
      promptContent = await Deno.readTextFile(join(ceremonyDir, "prompt.md"));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        await this.#deps.appendTickLog({
          event: "ceremony-warning",
          ceremony: this.name,
          reason: "prompt.md missing",
        });
        return;
      }
      throw e;
    }

    const d = now.toPlainDate();
    const isoDate = `${d.year}-${String(d.month).padStart(2, "0")}-${
      String(d.day).padStart(2, "0")
    }`;
    const prompt = await renderPrompt(
      new URL("./prompt.prompt.hbs", import.meta.url),
      { isoDate, promptContent },
    );

    const args = [
      prompt,
      "--print",
      "--dangerously-skip-permissions",
      "--model",
      model,
    ];

    if (thinking !== "off" && thinking !== "minimal") {
      args.push("--effort", thinking);
    }

    const runClaude = this.#deps.runClaude ?? defaultRunClaude;
    const result = await runClaude(args);

    if (result.code !== 0) {
      await this.#deps.appendTickLog({
        event: "ceremony-warning",
        ceremony: this.name,
        reason: "claude-failed",
      });
      return;
    }

    const text = result.stdout.trim();

    if (!text) {
      await this.#deps.appendTickLog({
        event: "ceremony-warning",
        ceremony: this.name,
        reason: "empty-response",
      });
      return;
    }

    await Deno.mkdir(outputDir, { recursive: true });
    await Deno.writeTextFile(
      join(outputDir, `${compactTimestamp(now)}-${this.name}.md`),
      text,
    );
  }
}

async function defaultRunClaude(
  args: string[],
): Promise<{ stdout: string; code: number }> {
  const result = await new Deno.Command("claude", {
    args,
    stdout: "piped",
    stderr: "null",
  }).output();
  return {
    stdout: new TextDecoder().decode(result.stdout),
    code: result.code,
  };
}
