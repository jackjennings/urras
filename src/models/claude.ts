import type { CommandRunner } from "../apfel.ts";
import type { LanguageModel, LanguageModelRequest } from "./types.ts";

export class ClaudeLanguageModel implements LanguageModel {
  readonly name = "claude";

  constructor(
    private readonly run: CommandRunner,
    private readonly opts: { model: string },
  ) {}

  async generateObject<T>(
    request: LanguageModelRequest & { schema: object },
  ): Promise<T | null> {
    try {
      const { code, stdout } = await this.run([
        "claude",
        "--print",
        "--dangerously-skip-permissions",
        "--output-format",
        "text",
        "--system-prompt",
        request.systemPrompt,
        "--model",
        this.opts.model,
        "--tools",
        "",
        "--json-schema",
        JSON.stringify(request.schema),
        "--",
        request.prompt,
      ]);
      if (code !== 0) return null;
      try {
        const parsed = JSON.parse(stdout.trim()) as T;
        if (parsed === null || parsed === undefined) return null;
        return parsed;
      } catch {
        return null;
      }
    } catch {
      return null;
    }
  }

  async generateText(request: LanguageModelRequest): Promise<string | null> {
    try {
      const { code, stdout } = await this.run([
        "claude",
        "--print",
        "--dangerously-skip-permissions",
        "--output-format",
        "text",
        "--system-prompt",
        request.systemPrompt,
        "--model",
        this.opts.model,
        "--tools",
        "",
        "--",
        request.prompt,
      ]);
      if (code !== 0) return null;
      const trimmed = stdout.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }
}
