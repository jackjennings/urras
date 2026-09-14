import { estimateTokenCount } from "tokenx";
import type { CommandRunner } from "../apfel.ts";
import type { AncillaryUsageRecord } from "../ancillary-usage.ts";
import type { LanguageModel, LanguageModelRequest } from "./types.ts";

type ApfelOpts = {
  callSite?: string;
  recordUsage?: (record: AncillaryUsageRecord) => Promise<void>;
};

export class ApfelLanguageModel implements LanguageModel {
  readonly name = "apfel";

  constructor(
    private readonly run: CommandRunner,
    private readonly opts: ApfelOpts = {},
  ) {}

  async generateObject<T>(
    request: LanguageModelRequest & { schema: object },
  ): Promise<T | null> {
    const maxTokens = Math.max(64, request.maxTokens ?? 64);
    let schemaPath: string;
    try {
      schemaPath = await Deno.makeTempFile({ suffix: ".json" });
      await Deno.writeTextFile(schemaPath, JSON.stringify(request.schema));
    } catch {
      return null;
    }
    try {
      const { code, stdout } = await this.run([
        "apfel",
        "--quiet",
        "--max-tokens",
        String(maxTokens),
        "--schema",
        schemaPath,
        "-s",
        request.systemPrompt,
        "--",
        request.prompt,
      ]);
      if (code !== 0) return null;
      try {
        const parsed = JSON.parse(stdout) as T;
        if (parsed === null || parsed === undefined) return null;
        await this.fireRecordUsage(request, stdout);
        return parsed;
      } catch {
        return null;
      }
    } catch {
      return null;
    } finally {
      try {
        await Deno.remove(schemaPath);
      } catch {
        // temp file already gone
      }
    }
  }

  async generateText(request: LanguageModelRequest): Promise<string | null> {
    try {
      const { code, stdout } = await this.run([
        "apfel",
        "--quiet",
        "--max-tokens",
        String(request.maxTokens ?? 40),
        "-s",
        request.systemPrompt,
        "--",
        request.prompt,
      ]);
      if (code !== 0) return null;
      const trimmed = stdout.trim();
      if (trimmed.length === 0) return null;
      await this.fireRecordUsage(request, stdout);
      return trimmed;
    } catch {
      return null;
    }
  }

  private async fireRecordUsage(
    request: LanguageModelRequest,
    stdout: string,
  ): Promise<void> {
    if (!this.opts.recordUsage || !this.opts.callSite) return;
    try {
      const record: AncillaryUsageRecord = {
        ts: Temporal.Now.instant().toString(),
        callSite: this.opts.callSite,
        adapter: "apfel",
        model: "apfel",
        input: estimateTokenCount(request.systemPrompt + "\n" + request.prompt),
        output: estimateTokenCount(stdout),
        estimated: true,
      };
      await this.opts.recordUsage(record);
    } catch {
      // ignore recordUsage errors
    }
  }
}
