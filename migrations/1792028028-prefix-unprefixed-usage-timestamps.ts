import { join } from "@std/path";
import { compactTimestamp } from "../src/timestamp.ts";
import { runGit } from "../src/worktree.ts";
import type { StoreMigration } from "../src/migrations/types.ts";
import { exists, readDir, rename, stat } from "../src/filesystem.ts";

const TIMESTAMP_PREFIX = /^\d{8}T\d{6}-/;
const USAGE_SUFFIX = ".usage.json";

async function addedTimestamp(
  stateDir: string,
  directory: string,
  name: string,
): Promise<string> {
  const relativePath = join(directory, name).slice(stateDir.length + 1);
  const { stdout } = await runGit(
    ["log", "--diff-filter=A", "--format=%ct", "--", relativePath],
    stateDir,
  );
  const epochSeconds = parseInt(stdout.trim().split("\n").pop() ?? "");
  const epochMilliseconds = epochSeconds > 0
    ? epochSeconds * 1000
    : (await stat(join(directory, name))).mtime?.getTime() ?? 0;
  return compactTimestamp(
    Temporal.Instant.fromEpochMilliseconds(epochMilliseconds)
      .toZonedDateTimeISO("UTC"),
  );
}

async function prefixDirectory(
  stateDir: string,
  directory: string,
): Promise<void> {
  const entries: Deno.DirEntry[] = [];
  for await (const entry of readDir(directory)) entries.push(entry);

  for (const entry of entries) {
    if (entry.isDirectory) {
      await prefixDirectory(stateDir, join(directory, entry.name));
    }
  }

  const stems = entries
    .filter((entry) =>
      entry.isFile && entry.name.endsWith(USAGE_SUFFIX) &&
      !TIMESTAMP_PREFIX.test(entry.name)
    )
    .map((entry) => entry.name.slice(0, -USAGE_SUFFIX.length));

  for (const stem of stems) {
    const timestamp = await addedTimestamp(
      stateDir,
      directory,
      `${stem}${USAGE_SUFFIX}`,
    );
    const related = entries.filter((entry) =>
      entry.isFile &&
      (entry.name === `${stem}${USAGE_SUFFIX}` ||
        entry.name === `${stem}.md` ||
        entry.name.startsWith(`${stem}.md.`))
    );
    for (const entry of related) {
      const target = join(directory, `${timestamp}-${entry.name}`);
      if (await exists(target)) continue;
      await rename(join(directory, entry.name), target);
    }
  }
}

const migration: StoreMigration = {
  type: "store",
  run(stateDir: string): Promise<void> {
    return prefixDirectory(stateDir, stateDir);
  },
};

export default migration;
