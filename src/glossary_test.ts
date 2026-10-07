import { assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import {
  bootstrapGlossaryEntry,
  glossaryDir,
  glossaryPath,
  validateGlossaryRequirement,
} from "./glossary.ts";

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

Deno.test("glossaryDir: returns stateDir/glossary", () => {
  assertEquals(glossaryDir("/state"), join("/state", "glossary"));
});

const VALID_OUTPUT = `## Proposed Scope

\`\`\`yaml
scope:
  - jackjennings/urras
\`\`\`

## Reasoning

This is the right repo.

## Glossary Entry

### jackjennings/urras

A pipeline automation tool for managing GitHub issues and PRs.
`;

Deno.test("validateGlossaryRequirement: returns null when scope is empty", () => {
  const output = `## Proposed Scope

\`\`\`yaml
scope: []
\`\`\`

## Reasoning

No relevant repos.
`;
  assertEquals(validateGlossaryRequirement(output), null);
});

Deno.test("validateGlossaryRequirement: returns null when glossary entry matches first scope slug", () => {
  assertEquals(validateGlossaryRequirement(VALID_OUTPUT), null);
});

Deno.test("validateGlossaryRequirement: rejects when glossary entry is absent", () => {
  const output = `## Proposed Scope

\`\`\`yaml
scope:
  - jackjennings/urras
\`\`\`

## Reasoning

This is the right repo.
`;
  const result = validateGlossaryRequirement(output);
  assertEquals(result?.approved, false);
  assertMatch(result!.reason, /jackjennings\/urras/);
});

Deno.test("validateGlossaryRequirement: rejects when glossary slug does not match scope", () => {
  const output = `## Proposed Scope

\`\`\`yaml
scope:
  - jackjennings/urras
\`\`\`

## Reasoning

Right repo.

## Glossary Entry

### jackjennings/other-repo

Some other description.
`;
  const result = validateGlossaryRequirement(output);
  assertEquals(result?.approved, false);
  assertMatch(result!.reason, /jackjennings\/urras/);
});

Deno.test("validateGlossaryRequirement: rejects when glossary entry has no description", () => {
  const output = `## Proposed Scope

\`\`\`yaml
scope:
  - jackjennings/urras
\`\`\`

## Reasoning

Right repo.

## Glossary Entry

### jackjennings/urras
`;
  const result = validateGlossaryRequirement(output);
  assertEquals(result?.approved, false);
});
