import type { AncillaryUsageRecord } from "../ancillary-usage.ts";
import type { LanguageModel, LanguageModelRequest } from "./types.ts";

const DEFAULT_URL = "http://localhost:11434";

type OllamaResponse = {
  response: string;
  prompt_eval_count?: number;
  eval_count?: number;
};

export class OllamaLanguageModel implements LanguageModel {
  readonly name = "ollama";
  private readonly url: string;

  constructor(
    private readonly _fetch: typeof fetch,
    private readonly opts: {
      model: string;
      url?: string;
      callSite?: string;
      recordUsage?: (record: AncillaryUsageRecord) => Promise<void>;
    },
  ) {
    this.url = opts.url ?? DEFAULT_URL;
  }

  async generateObject<T>(
    request: LanguageModelRequest & { schema: object },
  ): Promise<T | null> {
    try {
      const response = await this._fetch(`${this.url}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.opts.model,
          system: request.systemPrompt,
          prompt: request.prompt,
          stream: false,
          format: request.schema,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return null;
      const data = await response.json() as OllamaResponse;
      try {
        const parsed = JSON.parse(data.response) as T;
        if (parsed === null || parsed === undefined) return null;
        await this.fireRecordUsage(data);
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
      const response = await this._fetch(`${this.url}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.opts.model,
          system: request.systemPrompt,
          prompt: request.prompt,
          stream: false,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return null;
      const data = await response.json() as OllamaResponse;
      const trimmed = data.response.trim();
      if (trimmed.length === 0) return null;
      await this.fireRecordUsage(data);
      return trimmed;
    } catch {
      return null;
    }
  }

  private async fireRecordUsage(data: OllamaResponse): Promise<void> {
    if (!this.opts.recordUsage || !this.opts.callSite) return;
    try {
      const record: AncillaryUsageRecord = {
        ts: Temporal.Now.instant().toString(),
        callSite: this.opts.callSite,
        adapter: "ollama",
        model: this.opts.model,
        ...(data.prompt_eval_count !== undefined &&
            data.eval_count !== undefined
          ? { input: data.prompt_eval_count, output: data.eval_count }
          : {}),
      };
      await this.opts.recordUsage(record);
    } catch {
      // ignore recordUsage errors
    }
  }
}

export async function checkOllamaAvailable(
  _fetch: typeof fetch,
  url: string,
): Promise<boolean> {
  try {
    const response = await _fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(30_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
