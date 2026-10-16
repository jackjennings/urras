import type { CommandRunner } from "../apfel.ts";
import { appendAncillaryUsage } from "../ancillary-usage.ts";
import { HttpClient } from "../http-client.ts";
import { ApfelLanguageModel } from "./apfel.ts";
import { ClaudeLanguageModel } from "./claude.ts";
import { FallbackLanguageModel } from "./fallback.ts";
import { OllamaLanguageModel } from "./ollama.ts";
import type { LanguageModel } from "./types.ts";

export type OllamaModelConfig = { model: string; url?: string };

export function buildAncillaryChain(options: {
  callSite: string;
  run: CommandRunner;
  ollamaModels?: OllamaModelConfig[];
  ollamaFirst?: boolean;
}): LanguageModel {
  const recordUsage = appendAncillaryUsage(options.callSite);
  const ollama = (options.ollamaModels ?? []).map((entry) =>
    new OllamaLanguageModel(new HttpClient(), { ...entry, recordUsage })
  );
  const apfel = new ApfelLanguageModel(options.run, { recordUsage });
  const claude = new ClaudeLanguageModel(options.run, {
    model: "claude-haiku-4-5",
    recordUsage,
  });
  return new FallbackLanguageModel(
    options.ollamaFirst
      ? [...ollama, apfel, claude]
      : [apfel, ...ollama, claude],
  );
}
