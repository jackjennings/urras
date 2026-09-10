import { join } from "@std/path";
import type { Check, CheckResult, CheckStatus } from "./types.ts";

export interface TickFreshnessDeps {
  readTextFile: (path: string) => Promise<string>;
  urrasDir: string;
  now: () => number;
}

function worstStatus(a: CheckStatus, b: CheckStatus): CheckStatus {
  if (a === "fail" || b === "fail") return "fail";
  if (a === "warn" || b === "warn") return "warn";
  return "pass";
}

export function tickFreshnessCheck(deps: TickFreshnessDeps): Check {
  return {
    id: "tick-freshness",
    description: "Tick log is recent and has no failures",
    async run(): Promise<CheckResult> {
      let content: string;
      try {
        content = await deps.readTextFile(
          join(deps.urrasDir, "tick.ndjson"),
        );
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) {
          return {
            status: "warn",
            detail: "tick.ndjson not found — tick may never have run",
          };
        }
        throw e;
      }

      const entries = content
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as { ts: string; event: string };
          } catch {
            return null;
          }
        })
        .filter((e): e is { ts: string; event: string } => e !== null);

      if (entries.length === 0) {
        return { status: "warn", detail: "tick.ndjson is empty" };
      }

      const now = deps.now();
      const details: string[] = [];
      let status: CheckStatus = "pass";

      const tickStarts = entries.filter((e) => e.event === "tick-start");
      if (tickStarts.length === 0) {
        status = worstStatus(status, "warn");
        details.push("no tick-start events found");
      } else {
        const lastStart = tickStarts[tickStarts.length - 1];
        const ageSeconds = now -
          Math.floor(
            Temporal.Instant.from(lastStart.ts).epochMilliseconds / 1000,
          );
        if (ageSeconds > 1800) {
          status = worstStatus(status, "fail");
          details.push(
            `last tick-start was ${ageSeconds}s ago (>1800s, expected ≤600s)`,
          );
        } else if (ageSeconds > 600) {
          status = worstStatus(status, "warn");
          details.push(`last tick-start was ${ageSeconds}s ago (>600s)`);
        }
      }

      const last3 = entries.slice(-3);
      if (last3.some((e) => e.event === "tick-failed")) {
        status = worstStatus(status, "warn");
        details.push("tick-failed in last 3 log entries");
      }

      const lastStaleLockIndex = entries.findLastIndex(
        (e) => e.event === "stale-lock",
      );
      if (lastStaleLockIndex !== -1) {
        const resolvedAfter = entries.slice(lastStaleLockIndex + 1).some(
          (e) => e.event === "tick-start" || e.event === "tick-end",
        );
        if (!resolvedAfter) {
          status = worstStatus(status, "fail");
          details.push("stale lock entry is unresolved");
        }
      }

      return {
        status,
        detail: details.join("; "),
        remedy: status !== "pass"
          ? "Check `~/.urras/tick.ndjson` for details; delete stale lock with `rm ~/.urras/tick.pid`"
          : undefined,
      };
    },
  };
}
