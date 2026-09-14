import type { CommandRunner } from "../apfel.ts";
import type { AncillaryUsageRecord } from "../ancillary-usage.ts";
import type { LanguageModel, LanguageModelRequest } from "./types.ts";

type ClaudeEnvelope = {
  result: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
};

export class ClaudeLanguageModel implements LanguageModel {
  readonly name = "claude";

  constructor(
    private readonly run: CommandRunner,
    private readonly opts: {
      model: string;
      callSite?: string;
      recordUsage?: (record: AncillaryUsageRecord) => Promise<void>;
    },
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
        "json",
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
        const envelope = JSON.parse(stdout) as ClaudeEnvelope;
        try {
          const parsed = JSON.parse(envelope.result) as T;
          if (parsed === null || parsed === undefined) return null;
          await this.fireRecordUsage(envelope);
          return parsed;
        } catch {
          return null;
        }
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
        "json",
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
      try {
        const envelope = JSON.parse(stdout) as ClaudeEnvelope;
        const trimmed = envelope.result.trim();
        if (trimmed.length === 0) return null;
        await this.fireRecordUsage(envelope);
        return trimmed;
      } catch {
        return null;
      }
    } catch {
      return null;
    }
  }

  private async fireRecordUsage(envelope: ClaudeEnvelope): Promise<void> {
    if (!this.opts.recordUsage || !this.opts.callSite) return;
    try {
      const record: AncillaryUsageRecord = {
        ts: Temporal.Now.instant().toString(),
        callSite: this.opts.callSite,
        adapter: "claude",
        model: this.opts.model,
        ...(envelope.usage !== undefined
          ? {
            input: envelope.usage.input_tokens,
            output: envelope.usage.output_tokens,
          }
          : {}),
        ...(envelope.total_cost_usd !== undefined
          ? { cost: envelope.total_cost_usd }
          : {}),
      };
      await this.opts.recordUsage(record);
    } catch {
      // ignore recordUsage errors
    }
  }
}
