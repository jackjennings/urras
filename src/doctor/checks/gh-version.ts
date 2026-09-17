import type { Check, CheckResult, CommandRunner } from "./types.ts";

const MIN_MAJOR = 2;
const MIN_MINOR = 99;
const MIN_PATCH = 0;

function parseVersion(
  output: string,
): { major: number; minor: number; patch: number } | null {
  const match = output.match(/^gh version (\d+)\.(\d+)\.(\d+)/m);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

function meetsMinimum(v: {
  major: number;
  minor: number;
  patch: number;
}): boolean {
  if (v.major !== MIN_MAJOR) return v.major > MIN_MAJOR;
  if (v.minor !== MIN_MINOR) return v.minor > MIN_MINOR;
  return v.patch >= MIN_PATCH;
}

export interface GhVersionDeps {
  runCommand: CommandRunner;
}

export function ghVersionCheck(deps: GhVersionDeps): Check {
  return {
    id: "gh-version",
    description: "gh CLI is at least 2.99.0 (required for --attach flag)",
    async run(): Promise<CheckResult> {
      let result: { code: number; stdout: string };
      try {
        result = await deps.runCommand(["gh", "--version"]);
      } catch {
        return {
          status: "fail",
          detail: "gh not found",
          remedy: "brew install gh",
        };
      }
      if (result.code !== 0) {
        return {
          status: "fail",
          detail: "gh not found",
          remedy: "brew install gh",
        };
      }
      const version = parseVersion(result.stdout);
      if (!version) {
        return {
          status: "fail",
          detail: "could not parse gh version",
          remedy: "brew upgrade gh",
        };
      }
      if (!meetsMinimum(version)) {
        return {
          status: "fail",
          detail:
            `gh 2.99.0 or later required, found ${version.major}.${version.minor}.${version.patch}`,
          remedy: "brew upgrade gh",
        };
      }
      return { status: "pass", detail: "" };
    },
  };
}
