import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { bootstrapGlossaryEntry, glossaryPath } from "./glossary.ts";

Deno.test("glossaryPath: returns stateDir/glossary/org/repo.md", () => {
  assertEquals(
    glossaryPath("/state", "jackjennings", "urras"),
    join("/state", "glossary", "jackjennings", "urras.md"),
  );
});

Deno.test("bootstrapGlossaryEntry: creates empty file when absent", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await bootstrapGlossaryEntry(dir, "org", "repo");
    const content = await Deno.readTextFile(
      join(dir, "glossary", "org", "repo.md"),
    );
    assertEquals(content, "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bootstrapGlossaryEntry: does not overwrite existing content", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "glossary", "org"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "glossary", "org", "repo.md"),
      "existing content",
    );
    await bootstrapGlossaryEntry(dir, "org", "repo");
    const content = await Deno.readTextFile(
      join(dir, "glossary", "org", "repo.md"),
    );
    assertEquals(content, "existing content");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bootstrapGlossaryEntry: is a no-op when file already exists with empty content", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await bootstrapGlossaryEntry(dir, "org", "repo");
    await bootstrapGlossaryEntry(dir, "org", "repo"); // second call — no-op
    const content = await Deno.readTextFile(
      join(dir, "glossary", "org", "repo.md"),
    );
    assertEquals(content, "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
