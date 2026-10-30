import type { Check, CheckResult } from "./types.ts";
import type { CircuitBreaker } from "../../circuit-breaker.ts";

export interface UsageLimitBreakerDeps {
  breaker: CircuitBreaker;
  maxTrips?: number;
}

export function usageLimitBreakerCheck(deps: UsageLimitBreakerDeps): Check {
  return {
    id: "usage-limit-breaker",
    description: "Claude usage limit circuit breaker state",
    async run(): Promise<CheckResult> {
      const status = await deps.breaker.status(Temporal.Now.instant());
      if (status.state === "closed") {
        return { status: "pass", detail: "closed" };
      }
      const maxTrips = deps.maxTrips ?? 24;
      const detail =
        `state=${status.state}, retryAt=${status.retryAt}, trips=${status.trips}`;
      if (status.state === "open" && status.trips >= maxTrips) {
        return {
          status: "fail",
          detail,
          remedy: "Run `ur resume` to reset the breaker.",
        };
      }
      return {
        status: "warn",
        detail,
        remedy:
          `Paused until ${status.retryAt}. Run \`ur resume\` to reset early.`,
      };
    },
  };
}
