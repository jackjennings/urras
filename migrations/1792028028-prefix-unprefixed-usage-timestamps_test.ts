import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import migration from "./1792028028-prefix-unprefixed-usage-timestamps.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("migration prefix-unprefixed-usage-timestamps: prefixes the usage file and its output with the file's timestamp", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const ticketDir = join(stateDir, "github", "org", "repo", "1");
    await Deno.mkdir(ticketDir, { recursive: true });
    await Deno.writeTextFile(
      join(ticketDir, "conflict-resolution.usage.json"),
      '{"durationMs":1,"models":[]}',
    );
    await Deno.writeTextFile(
      join(ticketDir, "conflict-resolution.md"),
      "resolved",
    );
    const modified = new Date("2026-08-19T10:30:00Z");
    await Deno.utime(
      join(ticketDir, "conflict-resolution.usage.json"),
      modified,
      modified,
    );

    await migration.run(stateDir);

    const usagePath = join(
      ticketDir,
      "20260819T103000-conflict-resolution.usage.json",
    );
    const outputPath = join(
      ticketDir,
      "20260819T103000-conflict-resolution.md",
    );
    assertEquals(
      await Deno.readTextFile(usagePath),
      '{"durationMs":1,"models":[]}',
    );
    assertEquals(await Deno.readTextFile(outputPath), "resolved");
    assertFalse(
      await exists(join(ticketDir, "conflict-resolution.usage.json")),
    );
    assertFalse(await exists(join(ticketDir, "conflict-resolution.md")));
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("migration prefix-unprefixed-usage-timestamps: leaves timestamped files unchanged", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const ticketDir = join(stateDir, "jira", "PROJ-1");
    await Deno.mkdir(ticketDir, { recursive: true });
    const name = "20260920T120000-spec.usage.json";
    await Deno.writeTextFile(join(ticketDir, name), "{}");

    await migration.run(stateDir);

    assert(await exists(join(ticketDir, name)));
    const names: string[] = [];
    for await (const entry of Deno.readDir(ticketDir)) names.push(entry.name);
    assertEquals(names, [name]);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("migration prefix-unprefixed-usage-timestamps: does not overwrite an existing prefixed file", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const ticketDir = join(stateDir, "jira", "PROJ-2");
    await Deno.mkdir(ticketDir, { recursive: true });
    const modified = new Date("2026-08-19T10:30:00Z");
    await Deno.writeTextFile(
      join(ticketDir, "conflict-resolution.usage.json"),
      "legacy",
    );
    await Deno.utime(
      join(ticketDir, "conflict-resolution.usage.json"),
      modified,
      modified,
    );
    const target = join(
      ticketDir,
      "20260819T103000-conflict-resolution.usage.json",
    );
    await Deno.writeTextFile(target, "existing");

    await migration.run(stateDir);

    assertEquals(await Deno.readTextFile(target), "existing");
    assertStringIncludes(
      await Deno.readTextFile(
        join(ticketDir, "conflict-resolution.usage.json"),
      ),
      "legacy",
    );
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});
