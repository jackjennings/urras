import { join } from "@std/path";
import type { Check, CheckResult } from "./types.ts";

export interface UnappliedMigrationsDeps {
  readDir: (path: string) => AsyncIterable<{ name: string; isFile: boolean }>;
  readTextFile: (path: string) => Promise<string>;
  stateDir: string;
  migrationsDir: string;
}

export function unappliedMigrationsCheck(
  deps: UnappliedMigrationsDeps,
): Check {
  return {
    id: "unapplied-migrations",
    description: "No unapplied migrations",
    async run(): Promise<CheckResult> {
      const discovered: string[] = [];
      for await (const entry of deps.readDir(deps.migrationsDir)) {
        if (entry.isFile && /^\d+-[a-z0-9-]+\.ts$/.test(entry.name)) {
          discovered.push(entry.name);
        }
      }

      let applied: string[] = [];
      try {
        const content = await deps.readTextFile(
          join(deps.stateDir, ".migrations"),
        );
        applied = content.split("\n").filter((l) => l.length > 0);
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }

      const appliedSet = new Set(applied);
      const unapplied = discovered.filter((id) => !appliedSet.has(id));

      if (unapplied.length === 0) {
        return { status: "pass", detail: "" };
      }
      return {
        status: "fail",
        detail: `Unapplied: ${unapplied.join(", ")}`,
        remedy: "Run `ur tick` to apply pending migrations",
      };
    },
  };
}
