import type { Config } from "../../state/types.ts";
import type { Check, CheckResult } from "./types.ts";
import { checkOllamaAvailable } from "../../models/ollama.ts";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";

export interface OllamaAvailabilityDeps {
  config: Config;
  fetch: typeof fetch;
}

export function ollamaAvailabilityCheck(deps: OllamaAvailabilityDeps): Check {
  return {
    id: "ollama-availability",
    description: "Ollama is reachable (when configured)",
    async run(): Promise<CheckResult> {
      if (!deps.config.ollama) {
        return { status: "pass", detail: "" };
      }
      const url = deps.config.ollama.url ?? DEFAULT_OLLAMA_URL;
      const available = await checkOllamaAvailable(deps.fetch, url);
      if (available) {
        return { status: "pass", detail: "" };
      }
      return {
        status: "fail",
        detail: `Ollama is not reachable at ${url}`,
        remedy: "Ensure Ollama is running: `ollama serve`",
      };
    },
  };
}
