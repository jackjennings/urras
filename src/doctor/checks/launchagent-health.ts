import type {
  Check,
  CheckResult,
  CheckStatus,
  CommandRunner,
} from "./types.ts";

const LABEL = "com.jackjennings.urras";

function worstStatus(a: CheckStatus, b: CheckStatus): CheckStatus {
  if (a === "fail" || b === "fail") return "fail";
  if (a === "warn" || b === "warn") return "warn";
  return "pass";
}

export interface LaunchAgentHealthDeps {
  runCommand: CommandRunner;
  uid: number;
  readTextFile: (path: string) => Promise<string>;
  plistPath: string;
}

export function launchagentHealthCheck(deps: LaunchAgentHealthDeps): Check {
  return {
    id: "launchagent-health",
    description: "LaunchAgent loaded and configured correctly",
    async run(): Promise<CheckResult> {
      const domain = `gui/${deps.uid}`;
      const details: string[] = [];
      let status: CheckStatus = "pass";

      const printResult = await deps.runCommand([
        "launchctl",
        "print",
        `${domain}/${LABEL}`,
      ]);
      if (printResult.code !== 0) {
        status = worstStatus(status, "fail");
        details.push("plist not loaded");
      }

      const btmResult = await deps.runCommand(["sfltool", "dumpbtm"], 10_000);
      if (btmResult.code !== 0) {
        status = worstStatus(status, "warn");
        details.push("BTM disposition unknown (sfltool failed or timed out)");
      } else {
        const blocks = btmResult.stdout.split(/\n(?=\S)/);
        const block = blocks.find(
          (b) => b.includes("Identifier:") && b.includes(LABEL),
        );
        if (!block) {
          status = worstStatus(status, "warn");
          details.push("BTM entry not found for com.jackjennings.urras");
        } else {
          const dispositionLine = block
            .split("\n")
            .find((l) => l.trimStart().startsWith("Disposition:"));
          if (!dispositionLine || !dispositionLine.includes("allowed")) {
            status = worstStatus(status, "fail");
            details.push(
              `BTM disposition does not include "allowed": ${
                dispositionLine?.trim() ?? "not found"
              }`,
            );
          }
        }
      }

      try {
        const plistContent = await deps.readTextFile(deps.plistPath);
        const hasKeepAlive = /<key>KeepAlive<\/key>\s*<true\/>/.test(
          plistContent,
        );
        if (!hasKeepAlive) {
          status = worstStatus(status, "fail");
          details.push("KeepAlive not set in installed plist");
        }
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) {
          status = worstStatus(status, "fail");
          details.push("installed plist not found");
        } else {
          throw e;
        }
      }

      const disabledResult = await deps.runCommand([
        "launchctl",
        "print-disabled",
        domain,
      ]);
      if (disabledResult.code === 0) {
        const disabled = disabledResult.stdout
          .split("\n")
          .find((l) => l.includes(LABEL) && /\btrue\b/.test(l));
        if (disabled) {
          status = worstStatus(status, "fail");
          details.push("LaunchAgent is explicitly disabled");
        }
      }

      return {
        status,
        detail: details.join("; "),
        remedy: status !== "pass"
          ? "Run `ur enable` to reload the LaunchAgent"
          : undefined,
      };
    },
  };
}
