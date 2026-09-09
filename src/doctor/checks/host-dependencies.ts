import type { Check, CheckResult, CommandRunner } from "./types.ts";

const REQUIRED_BINARIES = [
  "git",
  "pi",
  "launchctl",
  "apfel",
  "git-worktreeinclude",
];

const OPTIONAL_BINARIES = ["git-absorb"];

export interface HostDependenciesDeps {
  runCommand: CommandRunner;
}

export function hostDependenciesCheck(deps: HostDependenciesDeps): Check {
  return {
    id: "host-dependencies",
    description: "Required host binaries are on PATH",
    async run(): Promise<CheckResult> {
      const missingRequired: string[] = [];
      for (const bin of REQUIRED_BINARIES) {
        const result = await deps.runCommand(["which", bin]);
        if (result.code !== 0) missingRequired.push(bin);
      }

      const missingOptional: string[] = [];
      for (const bin of OPTIONAL_BINARIES) {
        const result = await deps.runCommand(["which", bin]);
        if (result.code !== 0) missingOptional.push(bin);
      }

      if (missingRequired.length > 0) {
        return {
          status: "fail",
          detail: `Missing binaries: ${missingRequired.join(", ")}`,
          remedy: "Install missing tools and ensure they are on PATH",
        };
      }

      if (missingOptional.length > 0) {
        return {
          status: "warn",
          detail: `Optional binaries not found: ${missingOptional.join(", ")}`,
          remedy: "brew install git-absorb",
        };
      }

      return { status: "pass", detail: "" };
    },
  };
}
