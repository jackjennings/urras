import type { LanguageModel, LanguageModelRequest } from "./types.ts";

const DEFAULT_URL = "http://localhost:11434";

export class OllamaLanguageModel implements LanguageModel {
  readonly name = "ollama";
  private readonly url: string;

  constructor(
    private readonly _fetch: typeof fetch,
    private readonly opts: { model: string; url?: string },
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
      const data = await response.json() as { response: string };
      try {
        const parsed = JSON.parse(data.response) as T;
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
      const data = await response.json() as { response: string };
      const trimmed = data.response.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
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
