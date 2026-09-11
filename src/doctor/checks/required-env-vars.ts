import type { Config } from "../../state/types.ts";
import type { Check, CheckResult } from "./types.ts";

export interface RequiredEnvVarsDeps {
  getEnv: (name: string) => string | undefined;
  config: Config;
}

export function requiredEnvVarsCheck(deps: RequiredEnvVarsDeps): Check {
  return {
    id: "required-env-vars",
    description: "Required environment variables are set",
    run(): Promise<CheckResult> {
      const missing: string[] = [];

      if (
        deps.config.agent.type !== "claude-code" &&
        !deps.getEnv("ANTHROPIC_API_KEY")
      ) {
        missing.push("ANTHROPIC_API_KEY");
      }

      if (deps.config.github.accounts) {
        for (const account of Object.values(deps.config.github.accounts)) {
          if (!deps.getEnv(account.tokenEnv)) {
            missing.push(account.tokenEnv);
          }
        }
      }

      if (missing.length === 0) {
        return Promise.resolve({ status: "pass", detail: "" });
      }
      return Promise.resolve({
        status: "fail" as const,
        detail: `Unset variables: ${missing.join(", ")}`,
        remedy: "Set the listed environment variables before running urras",
      });
    },
  };
}
