# Pipeline Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a ticket run a phase sequence shaped to its complexity — a named,
pluggable "pipeline template" resolved once at intake and pinned for the
ticket's lifetime — instead of always running the fixed
`intake → enrichment → spec → plan → implementation` sequence.

**Architecture:** Pipeline templates are TOML files loaded from the extensions
directory (`{extensionsDir}/pipelines/<name>/pipeline.toml`), the same pattern
already used for ceremonies. Intake judges which template a ticket needs and
records the choice in its own output (never in `meta.md` directly, since
`selfReview` only reads a phase's output file); a new `TickAction` resolves,
validates, and pins the result onto the ticket after intake is approved;
`advancePhase`'s sequencing logic walks the ticket's pinned steps instead of the
global `PHASE_SEQUENCE` constant.

**Tech Stack:** Deno, TypeScript, `@std/toml`, `@std/testing/mock`,
`@std/assert`.

**Spec:** `docs/superpowers/specs/2026-08-24-pipeline-templates-design.md`

## Global Constraints

- Templates are TOML, not YAML — `@std/toml` is already a dependency; there is
  no standalone YAML parser in this repo.
- A template's `name` field must exactly match its directory name — a mismatch
  is `template-invalid-shape`.
- A template's `steps` must start with `intake`, end with `implementation`, and
  list any of `enrichment`/`spec`/`plan` in between in the same relative order
  as `PHASE_SEQUENCE` — no reordering, no duplicates, no phase name outside
  `PHASE_SEQUENCE`.
- `TicketState.pipeline`/`pipelineSteps` are resolved once (after intake is
  approved) and pinned for the ticket's lifetime — never re-resolved.
- A `TicketState` field added to the type alone and not to both `readTicket` and
  `writeTicket` silently drops on every write — this project has a documented
  production bug (`providerDone`) from exactly this mistake.
- Best-of-N generation (`variants`) and template-defined phase reordering or new
  phase names are explicitly out of scope — do not add code or schema fields for
  them.
- Run `deno fmt` and `deno lint` after writing all files in a task, before
  committing.
- Commits follow Conventional Commits (`<type>[(<scope>)]: <description>`,
  imperative mood, lowercase after the colon, no trailing period, ≤72 chars).

---

## Task 1: Pipeline step types and sequencing (`src/phases/pipeline.ts`)

**Files:**

- Create: `src/phases/pipeline.ts`
- Test: `src/phases/pipeline_test.ts`

**Interfaces:**

- Produces: `PipelineStep` (`{ phase: ActivePhase }`), `DEFAULT_PIPELINE_STEPS`
  (`PipelineStep[]`),
  `nextPipelinePhase(steps: PipelineStep[], current: ActivePhase): ActivePhase | "done"`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/phases/pipeline_test.ts
import { assertEquals } from "@std/assert";
import { DEFAULT_PIPELINE_STEPS, nextPipelinePhase } from "./pipeline.ts";

Deno.test("DEFAULT_PIPELINE_STEPS matches the five runner phases in order", () => {
  assertEquals(DEFAULT_PIPELINE_STEPS, [
    { phase: "intake" },
    { phase: "enrichment" },
    { phase: "spec" },
    { phase: "plan" },
    { phase: "implementation" },
  ]);
});

Deno.test("nextPipelinePhase: walks the default steps in order", () => {
  assertEquals(
    nextPipelinePhase(DEFAULT_PIPELINE_STEPS, "intake"),
    "enrichment",
  );
  assertEquals(nextPipelinePhase(DEFAULT_PIPELINE_STEPS, "enrichment"), "spec");
  assertEquals(nextPipelinePhase(DEFAULT_PIPELINE_STEPS, "spec"), "plan");
  assertEquals(
    nextPipelinePhase(DEFAULT_PIPELINE_STEPS, "plan"),
    "implementation",
  );
});

Deno.test("nextPipelinePhase: returns 'done' after the last step", () => {
  assertEquals(
    nextPipelinePhase(DEFAULT_PIPELINE_STEPS, "implementation"),
    "done",
  );
});

Deno.test("nextPipelinePhase: walks a short two-step template directly from intake to implementation", () => {
  const steps = [{ phase: "intake" }, { phase: "implementation" }] as const;
  assertEquals(nextPipelinePhase([...steps], "intake"), "implementation");
});

Deno.test("nextPipelinePhase: returns 'done' for a phase not present in steps", () => {
  const steps = [{ phase: "intake" }, { phase: "implementation" }];
  assertEquals(nextPipelinePhase(steps, "spec"), "done");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno task test:file src/phases/pipeline_test.ts` Expected: FAIL —
`src/phases/pipeline.ts` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// src/phases/pipeline.ts
import type { ActivePhase } from "./types.ts";
import { PHASE_SEQUENCE } from "./types.ts";

export interface PipelineStep {
  phase: ActivePhase;
}

export interface PipelineTemplate {
  name: string;
  description?: string;
  steps: PipelineStep[];
}

export const DEFAULT_PIPELINE_STEPS: PipelineStep[] = PHASE_SEQUENCE.map(
  (phase) => ({ phase }),
);

export function nextPipelinePhase(
  steps: PipelineStep[],
  current: ActivePhase,
): ActivePhase | "done" {
  const idx = steps.findIndex((s) => s.phase === current);
  if (idx === -1 || idx === steps.length - 1) return "done";
  return steps[idx + 1].phase;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno task test:file src/phases/pipeline_test.ts` Expected: PASS, 5 tests.

- [ ] **Step 5: Format, lint, commit**

```bash
deno fmt src/phases/pipeline.ts src/phases/pipeline_test.ts
deno lint src/phases/pipeline.ts src/phases/pipeline_test.ts
git add src/phases/pipeline.ts src/phases/pipeline_test.ts
git commit -m "feat(phases): add pipeline step types and sequencing"
```

---

## Task 2: `TicketState`/`Config` fields for pipeline selection

**Files:**

- Modify: `src/state/types.ts`
- Modify: `src/state/store.ts`
- Test: `src/state/store_test.ts`

**Interfaces:**

- Consumes: `ActivePhase` from `./phases/types.ts` (already imported in
  `src/state/types.ts` via `FULL_PHASE_SEQUENCE`).
- Produces: `TicketState.pipeline?: string`,
  `TicketState.pipelineSteps?: { phase: ActivePhase }[]`,
  `Config.pipelines?: { default?: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/state/store_test.ts — add near the other round-trip tests (e.g. after
// the ciHandledRunIds round-trip test)
Deno.test("writeTicket: round-trips pipeline and pipelineSteps through meta.md", async () => {
  const dir = await Deno.makeTempDir();
  const ticket: TicketState = makeTicket({
    id: "gh-9",
    pipeline: "fast",
    pipelineSteps: [{ phase: "intake" }, { phase: "implementation" }],
  });
  await writeTicket(dir, ticket);
  const read = await readTicket(dir, "gh-9");
  assertEquals(read.pipeline, "fast");
  assertEquals(read.pipelineSteps, [
    { phase: "intake" },
    { phase: "implementation" },
  ]);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("writeTicket: omits pipeline and pipelineSteps from frontmatter when not set", async () => {
  const dir = await Deno.makeTempDir();
  await writeTicket(dir, makeTicket({ id: "gh-10" }));
  const raw = await Deno.readTextFile(join(dir, "gh-10", "meta.md"));
  assertFalse(raw.includes("pipeline"));
  await Deno.remove(dir, { recursive: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno task test:file src/state/store_test.ts` Expected: FAIL —
`pipeline`/`pipelineSteps` do not survive the round trip (property is
`undefined` on read).

- [ ] **Step 3: Add the fields to `TicketState` and `Config`**

In `src/state/types.ts`, add to the `TicketState` interface (after
`artifacts: ArtifactType[];`):

```ts
pipeline?: string;
pipelineSteps?: { phase: ActivePhase }[];
```

This requires importing `ActivePhase` — change the top import from:

```ts
import { FULL_PHASE_SEQUENCE } from "../phases/types.ts";
```

to:

```ts
import { type ActivePhase, FULL_PHASE_SEQUENCE } from "../phases/types.ts";
```

Add to the `Config` interface (after
`phases?: { defaults?: PhaseModelConfig; };`):

```ts
pipelines?: { default?: string };
```

- [ ] **Step 4: Wire the fields into `writeTicket`/`readTicket`**

In `src/state/store.ts`, in `readTicket`, add to the `ticket` object literal
(after `phases: data.phases as TicketState["phases"],`):

```ts
pipeline: data.pipeline as string | undefined,
pipelineSteps: data.pipelineSteps as TicketState["pipelineSteps"],
```

In `writeTicket`, add (after the
`if (ticket.phases !== undefined) frontmatter.phases = ticket.phases;` line):

```ts
if (ticket.pipeline !== undefined) frontmatter.pipeline = ticket.pipeline;
if (ticket.pipelineSteps !== undefined) {
  frontmatter.pipelineSteps = ticket.pipelineSteps;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `deno task test:file src/state/store_test.ts` Expected: PASS.

- [ ] **Step 6: Run the full suite to check for type errors elsewhere**

Run: `deno task test` Expected: PASS (no other file constructs `TicketState`
exhaustively without optional fields, so this is additive).

- [ ] **Step 7: Format, lint, commit**

```bash
deno fmt src/state/types.ts src/state/store.ts src/state/store_test.ts
deno lint src/state/types.ts src/state/store.ts src/state/store_test.ts
git add src/state/types.ts src/state/store.ts src/state/store_test.ts
git commit -m "feat(state): add pipeline and pipelineSteps ticket fields"
```

---

## Task 3: Pipeline template loading and validation

**Files:**

- Modify: `src/phases/pipeline.ts` (extend)
- Test: `src/phases/pipeline_test.ts` (extend)

**Interfaces:**

- Consumes: `PipelineStep`, `PipelineTemplate` (Task 1).
- Produces: `PipelineLoadResult`,
  `loadPipelineTemplate(extensionsDir: string, name: string): Promise<PipelineLoadResult>`,
  `listAvailablePipelines(extensionsDir: string): Promise<PipelineTemplate[]>`,
  `formatAvailablePipelines(templates: PipelineTemplate[]): string`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/phases/pipeline_test.ts — append below the Task 1 tests
import { join } from "@std/path";
import {
  formatAvailablePipelines,
  listAvailablePipelines,
  loadPipelineTemplate,
} from "./pipeline.ts";

async function withTempExtensionsDir(
  fn: (extensionsDir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function writeTemplate(
  extensionsDir: string,
  name: string,
  toml: string,
): Promise<void> {
  const dir = join(extensionsDir, "pipelines", name);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, "pipeline.toml"), toml);
}

Deno.test("loadPipelineTemplate: loads a valid two-step template", async () => {
  await withTempExtensionsDir(async (dir) => {
    await writeTemplate(
      dir,
      "fast",
      `name = "fast"
description = "Skips enrichment, spec, and plan."

[[steps]]
phase = "intake"

[[steps]]
phase = "implementation"
`,
    );
    const result = await loadPipelineTemplate(dir, "fast");
    assertEquals(result, {
      ok: true,
      template: {
        name: "fast",
        description: "Skips enrichment, spec, and plan.",
        steps: [{ phase: "intake" }, { phase: "implementation" }],
      },
    });
  });
});

Deno.test("loadPipelineTemplate: missing file returns template-not-found", async () => {
  await withTempExtensionsDir(async (dir) => {
    const result = await loadPipelineTemplate(dir, "missing");
    assertEquals(result, { ok: false, reason: "template-not-found" });
  });
});

Deno.test("loadPipelineTemplate: unparseable TOML returns template-parse-failed", async () => {
  await withTempExtensionsDir(async (dir) => {
    await writeTemplate(dir, "broken", "this is not [ valid toml");
    const result = await loadPipelineTemplate(dir, "broken");
    assertEquals(result, { ok: false, reason: "template-parse-failed" });
  });
});

Deno.test("loadPipelineTemplate: unknown phase name returns template-invalid-shape", async () => {
  await withTempExtensionsDir(async (dir) => {
    await writeTemplate(
      dir,
      "bogus",
      `name = "bogus"

[[steps]]
phase = "intake"

[[steps]]
phase = "review"

[[steps]]
phase = "implementation"
`,
    );
    const result = await loadPipelineTemplate(dir, "bogus");
    assertEquals(result, { ok: false, reason: "template-invalid-shape" });
  });
});

Deno.test("loadPipelineTemplate: name field not matching directory returns template-invalid-shape", async () => {
  await withTempExtensionsDir(async (dir) => {
    await writeTemplate(
      dir,
      "fast",
      `name = "typo"

[[steps]]
phase = "intake"

[[steps]]
phase = "implementation"
`,
    );
    const result = await loadPipelineTemplate(dir, "fast");
    assertEquals(result, { ok: false, reason: "template-invalid-shape" });
  });
});

Deno.test("loadPipelineTemplate: missing intake anchor returns template-invalid-order", async () => {
  await withTempExtensionsDir(async (dir) => {
    await writeTemplate(
      dir,
      "no-intake",
      `name = "no-intake"

[[steps]]
phase = "enrichment"

[[steps]]
phase = "implementation"
`,
    );
    const result = await loadPipelineTemplate(dir, "no-intake");
    assertEquals(result, { ok: false, reason: "template-invalid-order" });
  });
});

Deno.test("loadPipelineTemplate: missing implementation anchor returns template-invalid-order", async () => {
  await withTempExtensionsDir(async (dir) => {
    await writeTemplate(
      dir,
      "no-impl",
      `name = "no-impl"

[[steps]]
phase = "intake"

[[steps]]
phase = "spec"
`,
    );
    const result = await loadPipelineTemplate(dir, "no-impl");
    assertEquals(result, { ok: false, reason: "template-invalid-order" });
  });
});

Deno.test("loadPipelineTemplate: out-of-order phases returns template-invalid-order", async () => {
  await withTempExtensionsDir(async (dir) => {
    await writeTemplate(
      dir,
      "reordered",
      `name = "reordered"

[[steps]]
phase = "intake"

[[steps]]
phase = "plan"

[[steps]]
phase = "spec"

[[steps]]
phase = "implementation"
`,
    );
    const result = await loadPipelineTemplate(dir, "reordered");
    assertEquals(result, { ok: false, reason: "template-invalid-order" });
  });
});

Deno.test("loadPipelineTemplate: duplicate phase returns template-invalid-order", async () => {
  await withTempExtensionsDir(async (dir) => {
    await writeTemplate(
      dir,
      "dup",
      `name = "dup"

[[steps]]
phase = "intake"

[[steps]]
phase = "intake"

[[steps]]
phase = "implementation"
`,
    );
    const result = await loadPipelineTemplate(dir, "dup");
    assertEquals(result, { ok: false, reason: "template-invalid-order" });
  });
});

Deno.test("listAvailablePipelines: empty list when pipelines directory does not exist", async () => {
  await withTempExtensionsDir(async (dir) => {
    assertEquals(await listAvailablePipelines(dir), []);
  });
});

Deno.test("listAvailablePipelines: returns only valid templates, skipping invalid ones", async () => {
  await withTempExtensionsDir(async (dir) => {
    await writeTemplate(
      dir,
      "fast",
      `name = "fast"

[[steps]]
phase = "intake"

[[steps]]
phase = "implementation"
`,
    );
    await writeTemplate(dir, "broken", "not valid toml [[[");
    const templates = await listAvailablePipelines(dir);
    assertEquals(templates.length, 1);
    assertEquals(templates[0].name, "fast");
  });
});

Deno.test("formatAvailablePipelines: empty string for no templates", () => {
  assertEquals(formatAvailablePipelines([]), "");
});

Deno.test("formatAvailablePipelines: lists name and description", () => {
  const text = formatAvailablePipelines([
    { name: "fast", description: "Skips planning.", steps: [] },
  ]);
  assertEquals(
    text,
    "## Available Pipeline Templates\n\n- fast: Skips planning.\n",
  );
});

Deno.test("formatAvailablePipelines: omits description when absent", () => {
  const text = formatAvailablePipelines([{ name: "fast", steps: [] }]);
  assertEquals(text, "## Available Pipeline Templates\n\n- fast\n");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno task test:file src/phases/pipeline_test.ts` Expected: FAIL —
`loadPipelineTemplate`, `listAvailablePipelines`, `formatAvailablePipelines` are
not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/phases/pipeline.ts`:

```ts
import { join } from "@std/path";
import { parse } from "@std/toml";
import { readDir, readTextFile } from "../filesystem.ts";

export type PipelineLoadFailureReason =
  | "template-not-found"
  | "template-parse-failed"
  | "template-invalid-shape"
  | "template-invalid-order";

export type PipelineLoadResult =
  | { ok: true; template: PipelineTemplate }
  | { ok: false; reason: PipelineLoadFailureReason };

function validateSteps(raw: unknown): PipelineStep[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const steps: PipelineStep[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const phase = (entry as Record<string, unknown>).phase;
    if (
      typeof phase !== "string" ||
      !(PHASE_SEQUENCE as readonly string[]).includes(phase)
    ) {
      return null;
    }
    steps.push({ phase: phase as ActivePhase });
  }
  return steps;
}

function isValidOrder(steps: PipelineStep[]): boolean {
  if (steps[0]?.phase !== "intake") return false;
  if (steps[steps.length - 1]?.phase !== "implementation") return false;
  const seen = new Set<ActivePhase>();
  let lastIndex = -1;
  for (const step of steps) {
    if (seen.has(step.phase)) return false;
    seen.add(step.phase);
    const index = PHASE_SEQUENCE.indexOf(step.phase);
    if (index <= lastIndex) return false;
    lastIndex = index;
  }
  return true;
}

export async function loadPipelineTemplate(
  extensionsDir: string,
  name: string,
): Promise<PipelineLoadResult> {
  const path = join(extensionsDir, "pipelines", name, "pipeline.toml");
  let raw: string;
  try {
    raw = await readTextFile(path);
  } catch {
    return { ok: false, reason: "template-not-found" };
  }
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch {
    return { ok: false, reason: "template-parse-failed" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.name !== name) {
    return { ok: false, reason: "template-invalid-shape" };
  }
  const steps = validateSteps(obj.steps);
  if (steps === null) {
    return { ok: false, reason: "template-invalid-shape" };
  }
  if (!isValidOrder(steps)) {
    return { ok: false, reason: "template-invalid-order" };
  }
  const template: PipelineTemplate = { name, steps };
  if (typeof obj.description === "string") {
    template.description = obj.description;
  }
  return { ok: true, template };
}

export async function listAvailablePipelines(
  extensionsDir: string,
): Promise<PipelineTemplate[]> {
  const pipelinesDir = join(extensionsDir, "pipelines");
  const names: string[] = [];
  try {
    for await (const entry of readDir(pipelinesDir)) {
      if (entry.isDirectory) names.push(entry.name);
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
  const templates: PipelineTemplate[] = [];
  for (const name of names) {
    const result = await loadPipelineTemplate(extensionsDir, name);
    if (result.ok) templates.push(result.template);
  }
  return templates;
}

export function formatAvailablePipelines(
  templates: PipelineTemplate[],
): string {
  if (templates.length === 0) return "";
  const lines = templates.map((t) =>
    t.description ? `- ${t.name}: ${t.description}` : `- ${t.name}`
  );
  return ["## Available Pipeline Templates", "", ...lines].join("\n") + "\n";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno task test:file src/phases/pipeline_test.ts` Expected: PASS, all tests
(Task 1's 5 plus this task's 13).

- [ ] **Step 5: Format, lint, commit**

```bash
deno fmt src/phases/pipeline.ts src/phases/pipeline_test.ts
deno lint src/phases/pipeline.ts src/phases/pipeline_test.ts
git add src/phases/pipeline.ts src/phases/pipeline_test.ts
git commit -m "feat(phases): add pipeline template loading and validation"
```

---

## Task 4: Intake pipeline extraction (`src/extract-pipeline.ts`)

**Files:**

- Create: `src/extract-pipeline.ts`
- Test: `src/extract-pipeline_test.ts`

**Interfaces:**

- Consumes: `CommandRunner` (`src/apfel.ts`), `ApfelLanguageModel`
  (`src/models/apfel.ts`), `ClaudeLanguageModel` (`src/models/claude.ts`),
  `FallbackLanguageModel` (`src/models/fallback.ts`).
- Produces:
  `extractIntakePipeline(content: string, run: CommandRunner, availableNames: string[]): Promise<string | null>`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/extract-pipeline_test.ts
import { assertEquals, assertStringIncludes } from "@std/assert";
import { spy } from "@std/testing/mock";
import type { CommandRunner } from "./apfel.ts";
import { extractIntakePipeline } from "./extract-pipeline.ts";

function runner(
  handler: (args: string[]) => { code: number; stdout: string },
): CommandRunner {
  return spy((args: string[]) => Promise.resolve(handler(args)));
}

function alwaysReturn(stdout: string) {
  return (_args: string[]) => ({ code: 0, stdout });
}

function callArgs(run: CommandRunner, index: number): string[] {
  return (run as ReturnType<typeof spy>).calls[index].args[0] as string[];
}

Deno.test("extractIntakePipeline: returns null when availableNames is empty, without calling the LLM", async () => {
  const run = runner(alwaysReturn(JSON.stringify({ pipeline: "fast" })));
  assertEquals(await extractIntakePipeline("some content", run, []), null);
  assertEquals((run as ReturnType<typeof spy>).calls.length, 0);
});

Deno.test("extractIntakePipeline: returns the requested name when it is in availableNames", async () => {
  const run = runner(alwaysReturn(JSON.stringify({ pipeline: "fast" })));
  assertEquals(
    await extractIntakePipeline("## Pipeline\n\npipeline: fast", run, [
      "fast",
    ]),
    "fast",
  );
});

Deno.test("extractIntakePipeline: returns null when the LLM's name is not in availableNames", async () => {
  const run = runner(alwaysReturn(JSON.stringify({ pipeline: "made-up" })));
  assertEquals(
    await extractIntakePipeline("intake content", run, ["fast"]),
    null,
  );
});

Deno.test("extractIntakePipeline: returns null when the LLM reports no pipeline requested", async () => {
  const run = runner(alwaysReturn(JSON.stringify({ pipeline: null })));
  assertEquals(
    await extractIntakePipeline(
      "intake content with no Pipeline section",
      run,
      [
        "fast",
      ],
    ),
    null,
  );
});

Deno.test("extractIntakePipeline: returns null when all LLM calls fail", async () => {
  const run: CommandRunner = spy(() =>
    Promise.resolve({ code: 1, stdout: "" })
  );
  assertEquals(
    await extractIntakePipeline("intake content", run, ["fast"]),
    null,
  );
});

Deno.test("extractIntakePipeline: passes intake content to the LLM", async () => {
  const run = runner(alwaysReturn(JSON.stringify({ pipeline: null })));
  const content = "## Pipeline\n\npipeline: fast\nreason: trivial change";
  await extractIntakePipeline(content, run, ["fast"]);
  const args = callArgs(run, 0);
  assertStringIncludes(args[args.length - 1], content);
});

Deno.test("extractIntakePipeline: uses claude-haiku-4-5 as fallback model", async () => {
  const run = runner((args) =>
    args[0] === "apfel"
      ? { code: 1, stdout: "" }
      : { code: 0, stdout: JSON.stringify({ pipeline: null }) }
  );
  await extractIntakePipeline("intake content", run, ["fast"]);
  const args = callArgs(run, 1);
  const modelIdx = args.indexOf("--model");
  assertEquals(args[modelIdx + 1], "claude-haiku-4-5");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno task test:file src/extract-pipeline_test.ts` Expected: FAIL —
`src/extract-pipeline.ts` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// src/extract-pipeline.ts
import type { CommandRunner } from "./apfel.ts";
import { ApfelLanguageModel } from "./models/apfel.ts";
import { ClaudeLanguageModel } from "./models/claude.ts";
import { FallbackLanguageModel } from "./models/fallback.ts";

export async function extractIntakePipeline(
  content: string,
  run: CommandRunner,
  availableNames: string[],
): Promise<string | null> {
  if (availableNames.length === 0) return null;
  const systemPrompt =
    "You are extracting the chosen pipeline template name from an intake " +
    "output written by an AI coding agent. Valid template names are: " +
    `${availableNames.join(", ")}. Return the name from the "## Pipeline" ` +
    "section of the intake output if present, or null if that section is " +
    "absent or the ticket should use the default pipeline.";
  const schema = {
    type: "object",
    properties: {
      pipeline: {
        type: ["string", "null"],
        enum: [...availableNames, null],
      },
    },
    required: ["pipeline"],
    additionalProperties: false,
  };
  const model = new FallbackLanguageModel([
    new ApfelLanguageModel(run),
    new ClaudeLanguageModel(run, { model: "claude-haiku-4-5" }),
  ]);
  const result = await model.generateObject<{ pipeline: string | null }>({
    systemPrompt,
    prompt: content,
    schema,
    maxTokens: 32,
  });
  if (!result || typeof result.pipeline !== "string") return null;
  return availableNames.includes(result.pipeline) ? result.pipeline : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno task test:file src/extract-pipeline_test.ts` Expected: PASS, 7 tests.

- [ ] **Step 5: Format, lint, commit**

```bash
deno fmt src/extract-pipeline.ts src/extract-pipeline_test.ts
deno lint src/extract-pipeline.ts src/extract-pipeline_test.ts
git add src/extract-pipeline.ts src/extract-pipeline_test.ts
git commit -m "feat: add LLM-based intake pipeline name extraction"
```

---

## Task 5: `[pipelines]` config parsing

**Files:**

- Modify: `src/config.ts`
- Test: `src/config_test.ts`

**Interfaces:**

- Consumes: `Config.pipelines` (Task 2).
- Produces: `loadConfig` populates `Config.pipelines`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/config_test.ts — add near the [phases.defaults] tests
Deno.test("loadConfig parses [pipelines].default", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1

[pipelines]
default = "thorough"
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.pipelines?.default, "thorough");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig: pipelines is undefined when [pipelines] absent", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.pipelines, undefined);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig: throws when [pipelines].default is not a string", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1

[pipelines]
default = 5
`,
  );
  await assertRejects(
    () => loadConfig(join(dir, "config.toml")),
    Error,
    "[pipelines].default must be a string",
  );
  await Deno.remove(dir, { recursive: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno task test:file src/config_test.ts` Expected: FAIL — `cfg.pipelines`
is always `undefined`; the throw test fails because no error is thrown.

- [ ] **Step 3: Write the implementation**

In `src/config.ts`, add after the `phasesDefaults` block:

```ts
const pipelinesRaw = parsed.pipelines as { default?: unknown } | undefined;
if (
  pipelinesRaw?.default !== undefined &&
  typeof pipelinesRaw.default !== "string"
) {
  throw new Error("config.toml: [pipelines].default must be a string");
}
```

In the returned object, add after
`phases: phasesDefaults !== undefined ? { defaults: phasesDefaults } : undefined,`:

```ts
pipelines: pipelinesRaw?.default !== undefined
  ? { default: pipelinesRaw.default as string }
  : undefined,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno task test:file src/config_test.ts` Expected: PASS.

- [ ] **Step 5: Format, lint, commit**

```bash
deno fmt src/config.ts src/config_test.ts
deno lint src/config.ts src/config_test.ts
git add src/config.ts src/config_test.ts
git commit -m "feat(config): parse [pipelines].default"
```

---

## Task 6: `resolvePipelineAction` tick action

**Files:**

- Create: `src/tick-actions/resolve-pipeline.ts`
- Test: `src/tick-actions/resolve-pipeline_test.ts`

**Interfaces:**

- Consumes: `TickAction` (`src/tick-actions/types.ts`), `isApproved`,
  `TicketState` (`src/state/types.ts`), `DEFAULT_PIPELINE_STEPS`,
  `loadPipelineTemplate`, `listAvailablePipelines`, `PipelineStep`
  (`src/phases/pipeline.ts`, Tasks 1 & 3), `extractIntakePipeline`
  (`src/extract-pipeline.ts`, Task 4), `CommandRunner` (`src/apfel.ts`).
- Produces: `ResolvePipelineDeps`, `resolvePipelineAction(deps): TickAction`.

- [ ] **Step 1: Write the failing tests**

````ts
// src/tick-actions/resolve-pipeline_test.ts
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { spy } from "@std/testing/mock";
import { resolvePipelineAction } from "./resolve-pipeline.ts";
import type { TicketState } from "../state/types.ts";
import { makeTicket } from "../test-support.ts";
import type { CommandRunner } from "../apfel.ts";

async function withTempExtensionsDir(
  fn: (extensionsDir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function writeTemplate(
  extensionsDir: string,
  name: string,
  toml: string,
): Promise<void> {
  const dir = join(extensionsDir, "pipelines", name);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, "pipeline.toml"), toml);
}

const FAST_TOML = `name = "fast"
description = "Skips enrichment, spec, and plan."

[[steps]]
phase = "intake"

[[steps]]
phase = "implementation"
`;

function alwaysReturn(stdout: string): CommandRunner {
  return spy(() => Promise.resolve({ code: 0, stdout }));
}

function approvedIntakeTicket(overrides: Partial<TicketState> = {}) {
  return makeTicket({
    phase: "intake",
    status: "waiting",
    approvals: [{ timestamp: "t", actor: "human", phase: "intake" }],
    ...overrides,
  });
}

function makeAction(
  overrides: Partial<Parameters<typeof resolvePipelineAction>[0]> = {},
) {
  return resolvePipelineAction({
    readIntakeOutput: () => Promise.resolve(null),
    run: alwaysReturn(JSON.stringify({ pipeline: null })),
    extensionsDir: "/nonexistent",
    writeTicket: () => Promise.resolve(),
    appendLog: () => Promise.resolve(),
    ...overrides,
  });
}

// ── applies ──────────────────────────────────────────────────────────────────

Deno.test("resolvePipelineAction: applies to approved intake/waiting with no pipelineSteps", () => {
  assertEquals(makeAction().applies(approvedIntakeTicket()), true);
});

Deno.test("resolvePipelineAction: does not apply when pipelineSteps already set", () => {
  assertEquals(
    makeAction().applies(
      approvedIntakeTicket({ pipelineSteps: [{ phase: "intake" }] }),
    ),
    false,
  );
});

Deno.test("resolvePipelineAction: does not apply before approval", () => {
  assertEquals(
    makeAction().applies(approvedIntakeTicket({ approvals: [] })),
    false,
  );
});

Deno.test("resolvePipelineAction: does not apply outside intake phase", () => {
  assertEquals(
    makeAction().applies(
      approvedIntakeTicket({
        phase: "enrichment",
        approvals: [{ timestamp: "t", actor: "human", phase: "enrichment" }],
      }),
    ),
    false,
  );
});

Deno.test("resolvePipelineAction: applies regardless of artifact type", () => {
  assertEquals(
    makeAction().applies(approvedIntakeTicket({ artifacts: ["document"] })),
    true,
  );
});

// ── run: no pipeline requested ────────────────────────────────────────────────

Deno.test("resolvePipelineAction: no ## Pipeline section pins the default steps and logs pipeline-defaulted", async () => {
  const logged: Record<string, unknown>[] = [];
  const result = await makeAction({
    readIntakeOutput: () => Promise.resolve("## Proposed Scope\n\nscope: []\n"),
    appendLog: (_dir, _id, entry) => {
      logged.push(entry as Record<string, unknown>);
      return Promise.resolve();
    },
  }).run(approvedIntakeTicket(), "/state");

  assertEquals(result?.pipeline, "default");
  assertEquals(result?.pipelineSteps, [
    { phase: "intake" },
    { phase: "enrichment" },
    { phase: "spec" },
    { phase: "plan" },
    { phase: "implementation" },
  ]);
  assertEquals(logged, [{ event: "pipeline-defaulted", pipeline: "default" }]);
});

// ── run: valid pipeline requested ─────────────────────────────────────────────

Deno.test("resolvePipelineAction: a valid requested template is pinned and logs pipeline-corrected", async () => {
  await withTempExtensionsDir(async (extensionsDir) => {
    await writeTemplate(extensionsDir, "fast", FAST_TOML);
    const logged: Record<string, unknown>[] = [];
    const written: TicketState[] = [];
    const result = await makeAction({
      extensionsDir,
      readIntakeOutput: () =>
        Promise.resolve("## Pipeline\n\n```yaml\npipeline: fast\n```\n"),
      run: alwaysReturn(JSON.stringify({ pipeline: "fast" })),
      writeTicket: (_dir, t) => {
        written.push(t);
        return Promise.resolve();
      },
      appendLog: (_dir, _id, entry) => {
        logged.push(entry as Record<string, unknown>);
        return Promise.resolve();
      },
    }).run(approvedIntakeTicket(), "/state");

    assertEquals(result?.pipeline, "fast");
    assertEquals(result?.pipelineSteps, [
      { phase: "intake" },
      { phase: "implementation" },
    ]);
    assertEquals(logged, [{ event: "pipeline-corrected", pipeline: "fast" }]);
    assertEquals(written.length, 1);
  });
});

// ── run: invalid pipeline (via a broken config default) ──────────────────────

Deno.test("resolvePipelineAction: an invalid config default falls back to the built-in default and logs pipeline-invalid", async () => {
  const logged: Record<string, unknown>[] = [];
  const result = await makeAction({
    extensionsDir: "/nonexistent",
    defaultPipelineName: "thorough",
    readIntakeOutput: () => Promise.resolve(null),
    appendLog: (_dir, _id, entry) => {
      logged.push(entry as Record<string, unknown>);
      return Promise.resolve();
    },
  }).run(approvedIntakeTicket(), "/state");

  assertEquals(result?.pipeline, "default");
  assertEquals(result?.pipelineSteps, [
    { phase: "intake" },
    { phase: "enrichment" },
    { phase: "spec" },
    { phase: "plan" },
    { phase: "implementation" },
  ]);
  assertEquals(logged, [
    {
      event: "pipeline-invalid",
      requestedName: "thorough",
      reason: "template-not-found",
    },
  ]);
});

// ── run: config default ───────────────────────────────────────────────────────

Deno.test("resolvePipelineAction: falls back to a valid config default when intake requests nothing", async () => {
  await withTempExtensionsDir(async (extensionsDir) => {
    await writeTemplate(
      extensionsDir,
      "thorough",
      `name = "thorough"

[[steps]]
phase = "intake"

[[steps]]
phase = "enrichment"

[[steps]]
phase = "spec"

[[steps]]
phase = "plan"

[[steps]]
phase = "implementation"
`,
    );
    const logged: Record<string, unknown>[] = [];
    const result = await makeAction({
      extensionsDir,
      defaultPipelineName: "thorough",
      readIntakeOutput: () => Promise.resolve(null),
      appendLog: (_dir, _id, entry) => {
        logged.push(entry as Record<string, unknown>);
        return Promise.resolve();
      },
    }).run(approvedIntakeTicket(), "/state");

    assertEquals(result?.pipeline, "thorough");
    assertEquals(logged, [
      { event: "pipeline-defaulted", pipeline: "thorough" },
    ]);
  });
});
````

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno task test:file src/tick-actions/resolve-pipeline_test.ts` Expected:
FAIL — `src/tick-actions/resolve-pipeline.ts` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// src/tick-actions/resolve-pipeline.ts
import { join } from "@std/path";
import type { TickAction } from "./types.ts";
import { isApproved, type TicketState } from "../state/types.ts";
import type { CommandRunner } from "../apfel.ts";
import {
  DEFAULT_PIPELINE_STEPS,
  listAvailablePipelines,
  loadPipelineTemplate,
  type PipelineStep,
} from "../phases/pipeline.ts";
import { extractIntakePipeline } from "../extract-pipeline.ts";

export interface ResolvePipelineDeps {
  readIntakeOutput: (ticketDir: string) => Promise<string | null>;
  run: CommandRunner;
  extensionsDir: string;
  defaultPipelineName?: string;
  writeTicket: (stateDir: string, t: TicketState) => Promise<void>;
  appendLog: (stateDir: string, id: string, entry: object) => Promise<void>;
}

interface Resolved {
  name: string;
  steps: PipelineStep[];
  invalid?: { requestedName: string; reason: string };
}

async function resolveByName(
  deps: ResolvePipelineDeps,
  name: string,
): Promise<Resolved> {
  if (name === "default") {
    return { name: "default", steps: DEFAULT_PIPELINE_STEPS };
  }
  const result = await loadPipelineTemplate(deps.extensionsDir, name);
  if (result.ok) return { name, steps: result.template.steps };
  return {
    name: "default",
    steps: DEFAULT_PIPELINE_STEPS,
    invalid: { requestedName: name, reason: result.reason },
  };
}

export function resolvePipelineAction(
  deps: ResolvePipelineDeps,
): TickAction {
  return {
    label: "Resolving pipeline",
    applies(ticket: TicketState): boolean {
      return (
        ticket.phase === "intake" &&
        ticket.status === "waiting" &&
        isApproved(ticket) &&
        ticket.pipelineSteps === undefined
      );
    },
    async run(
      ticket: TicketState,
      stateDir: string,
    ): Promise<TicketState | null> {
      const now = Temporal.Now.instant().toString();
      const ticketDir = join(stateDir, ticket.id);

      const available = await listAvailablePipelines(deps.extensionsDir);
      const availableNames = available.map((t) => t.name);

      const intakeContent = await deps.readIntakeOutput(ticketDir);
      const requestedName = intakeContent !== null
        ? await extractIntakePipeline(intakeContent, deps.run, availableNames)
        : null;

      const nameToResolve = requestedName ?? deps.defaultPipelineName ??
        "default";
      const resolved = await resolveByName(deps, nameToResolve);

      const updated: TicketState = {
        ...ticket,
        pipeline: resolved.name,
        pipelineSteps: resolved.steps,
        updated: now,
      };
      await deps.writeTicket(stateDir, updated);

      if (resolved.invalid) {
        await deps.appendLog(stateDir, ticket.id, {
          event: "pipeline-invalid",
          requestedName: resolved.invalid.requestedName,
          reason: resolved.invalid.reason,
        });
      } else if (requestedName === null) {
        await deps.appendLog(stateDir, ticket.id, {
          event: "pipeline-defaulted",
          pipeline: resolved.name,
        });
      } else {
        await deps.appendLog(stateDir, ticket.id, {
          event: "pipeline-corrected",
          pipeline: resolved.name,
        });
      }
      return updated;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno task test:file src/tick-actions/resolve-pipeline_test.ts` Expected:
PASS, 10 tests.

- [ ] **Step 5: Format, lint, commit**

```bash
deno fmt src/tick-actions/resolve-pipeline.ts src/tick-actions/resolve-pipeline_test.ts
deno lint src/tick-actions/resolve-pipeline.ts src/tick-actions/resolve-pipeline_test.ts
git add src/tick-actions/resolve-pipeline.ts src/tick-actions/resolve-pipeline_test.ts
git commit -m "feat(tick): add resolvePipelineAction"
```

---

## Task 7: `advancePhase` walks per-ticket pipeline steps

**Files:**

- Modify: `src/phases/advance.ts`
- Modify: `src/test-support.ts`
- Test: `src/phases/advance_test.ts`

**Interfaces:**

- Consumes: `DEFAULT_PIPELINE_STEPS`, `nextPipelinePhase`
  (`src/phases/pipeline.ts`, Task 1).
- Produces: `TickDeps.buildPipelineOptionsText: () => Promise<string>`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/phases/advance_test.ts — add near the existing repo-corpus prompt tests
Deno.test(
  "advancePhase: new ticket intake prompt appends pipeline options text when present",
  async () => {
    const ticket = makeTicket({
      phase: "intake",
      status: "new",
      provider: "jira",
    });
    let spawnedPrompt = "";
    const spawnSpy = spy((opts: SpawnOpts) => {
      spawnedPrompt = opts.prompt;
      return Promise.resolve();
    });
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        spawn: spawnSpy,
        resolveModelConfig: () => ({
          model: "claude-sonnet-4-6",
          thinking: "off",
        }),
        buildPipelineOptionsText: () =>
          Promise.resolve(
            "## Available Pipeline Templates\n\n- fast: Skips planning.\n",
          ),
      }),
    );
    assertSpyCall(spawnSpy, 0);
    const basePrompt = await loadPromptFile("intake.md");
    assertEquals(
      spawnedPrompt,
      basePrompt +
        "\n\n## Available Pipeline Templates\n\n" +
        "- fast: Skips planning.\n",
    );
  },
);

Deno.test(
  "advancePhase: new ticket intake prompt has no trailing pipeline block when buildPipelineOptionsText is absent",
  async () => {
    const ticket = makeTicket({
      phase: "intake",
      status: "new",
      provider: "jira",
    });
    let spawnedPrompt = "";
    const spawnSpy = spy((opts: SpawnOpts) => {
      spawnedPrompt = opts.prompt;
      return Promise.resolve();
    });
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        spawn: spawnSpy,
        resolveModelConfig: () => ({
          model: "claude-sonnet-4-6",
          thinking: "off",
        }),
      }),
    );
    assertSpyCall(spawnSpy, 0);
    const basePrompt = await loadPromptFile("intake.md");
    assertEquals(spawnedPrompt, basePrompt);
  },
);

Deno.test(
  "advancePhase: intake/waiting + approved with a two-step pipeline advances directly to implementation",
  async () => {
    const ticket = makeTicket({
      phase: "intake",
      status: "waiting",
      approvals: [{ timestamp: "t", actor: "human", phase: "intake" }],
      pipelineSteps: [{ phase: "intake" }, { phase: "implementation" }],
      worktrees: {
        "jackjennings/lazyboy": { path: "/tmp/wt", branch: "gh-1" },
      },
    });
    let spawnedPhase = "";
    const spawnSpy = spy((opts: SpawnOpts) => {
      spawnedPhase = opts.phase;
      return Promise.resolve();
    });
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        spawn: spawnSpy,
        resolveModelConfig: () => ({
          model: "claude-sonnet-4-6",
          thinking: "off",
        }),
        readPhaseExitCode: () => Promise.resolve(null),
      }),
    );
    assertEquals(spawnedPhase, "implementation");
  },
);

Deno.test(
  "advancePhase: intake/waiting + approved with no pipelineSteps falls back to the default sequence and advances to enrichment",
  async () => {
    const ticket = makeTicket({
      phase: "intake",
      status: "waiting",
      approvals: [{ timestamp: "t", actor: "human", phase: "intake" }],
    });
    let spawnedPhase = "";
    const spawnSpy = spy((opts: SpawnOpts) => {
      spawnedPhase = opts.phase;
      return Promise.resolve();
    });
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        spawn: spawnSpy,
        resolveModelConfig: () => ({
          model: "claude-sonnet-4-6",
          thinking: "off",
        }),
        readPhaseExitCode: () => Promise.resolve(null),
      }),
    );
    assertEquals(spawnedPhase, "enrichment");
  },
);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno task test:file src/phases/advance_test.ts` Expected: FAIL —
`makeTickDeps` rejects the unknown `buildPipelineOptionsText` override
(TypeScript error) until Step 3's `test-support.ts` change lands; the
two-step-pipeline test fails because `advancePhase` doesn't read `pipelineSteps`
yet.

- [ ] **Step 3: Add the `buildPipelineOptionsText` default to
      `test-support.ts`**

In `src/test-support.ts`, add to `makeTickDeps`'s returned object (after
`buildRepoCorpusText: () => Promise.resolve(""),`):

```ts
buildPipelineOptionsText: () => Promise.resolve(""),
```

- [ ] **Step 4: Update `src/phases/advance.ts`**

Change the import block at the top from:

```ts
import {
  loadArtifactPrompt,
  loadPrompt,
  loadProviderPrompt,
  loadRevisionPrompt,
  loadStatePrompt,
  nextPhase,
} from "./runners.ts";
```

to:

```ts
import {
  loadArtifactPrompt,
  loadPrompt,
  loadProviderPrompt,
  loadRevisionPrompt,
  loadStatePrompt,
} from "./runners.ts";
```

Add a new import for the pipeline helpers:

```ts
import { DEFAULT_PIPELINE_STEPS, nextPipelinePhase } from "./pipeline.ts";
```

Change:

```ts
import { type ActivePhase, PHASE_SEQUENCE } from "./types.ts";
```

to:

```ts
import type { ActivePhase } from "./types.ts";
```

Add `buildPipelineOptionsText` to the `TickDeps` interface (after
`buildRepoCorpusText: () => Promise<string>;`):

```ts
buildPipelineOptionsText: (() => Promise<string>);
```

In the `ticket.status === "new"` branch, add a call to
`buildPipelineOptionsText` and include it in the prompt array. Change:

```ts
const corpusText = await deps.buildRepoCorpusText();
const intakeStatePrompt = await loadStatePrompt(
  "intake",
  stateDir,
  ticket.provider,
  ticket.id,
);
const prompt = [
  intakeBase,
  intakeSupplement,
  intakeArtifactSupplement,
  corpusText,
  intakeStatePrompt,
]
  .filter((part) => part.length > 0)
  .join("\n\n");
```

to:

```ts
const corpusText = await deps.buildRepoCorpusText();
const pipelineOptionsText = await deps.buildPipelineOptionsText();
const intakeStatePrompt = await loadStatePrompt(
  "intake",
  stateDir,
  ticket.provider,
  ticket.id,
);
const prompt = [
  intakeBase,
  intakeSupplement,
  intakeArtifactSupplement,
  corpusText,
  pipelineOptionsText,
  intakeStatePrompt,
]
  .filter((part) => part.length > 0)
  .join("\n\n");
```

Finally, change the sequencing block near the end of the file. Change:

```ts
const activePhases = PHASE_SEQUENCE.filter((p) => p !== "implementation");
if (
  ticket.status === "waiting" &&
  isApproved(ticket) &&
  (activePhases as string[]).includes(ticket.phase)
) {
  const activePhase = ticket.phase as ActivePhase;
  const next = nextPhase(activePhase);
  if (next === "done") return;
  const effectiveNext: ActivePhase = activePhase === "spec" &&
      ticket.phases?.plan?.skip === true &&
      next === "plan"
    ? nextPhase("plan") as ActivePhase
    : next;
```

to:

```ts
const pipelineSteps = ticket.pipelineSteps ?? DEFAULT_PIPELINE_STEPS;
const activePhases = pipelineSteps
  .map((s) => s.phase)
  .filter((p) => p !== "implementation");
if (
  ticket.status === "waiting" &&
  isApproved(ticket) &&
  (activePhases as string[]).includes(ticket.phase)
) {
  const activePhase = ticket.phase as ActivePhase;
  const next = nextPipelinePhase(pipelineSteps, activePhase);
  if (next === "done") return;
  const effectiveNext: ActivePhase = activePhase === "spec" &&
      ticket.phases?.plan?.skip === true &&
      next === "plan"
    ? nextPipelinePhase(pipelineSteps, "plan") as ActivePhase
    : next;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `deno task test:file src/phases/advance_test.ts` Expected: PASS — this file
has hundreds of pre-existing tests; all must still pass (they don't set
`pipelineSteps`, so they exercise the `DEFAULT_PIPELINE_STEPS` fallback path,
which is behaviorally identical to the old `PHASE_SEQUENCE`-based code).

- [ ] **Step 6: Run the full test suite**

Run: `deno task test` Expected: PASS. This also confirms no other file still
imports `nextPhase` from `src/phases/runners.ts` (it is no longer called
anywhere after this task — leave its definition in `runners.ts` alone for this
task; Task 7 only removes the _import_ in `advance.ts`, not the export itself,
since removing dead exports is a separate, deliberate cleanup — see Step 7).

- [ ] **Step 7: Remove the now-unused `nextPhase` export**

Confirm no remaining references:

```bash
grep -rn "nextPhase\b" src/ --include=*.ts | grep -v pipeline
```

Expected: only the definition in `src/phases/runners.ts`. Delete that function
from `src/phases/runners.ts`:

```ts
export function nextPhase(current: ActivePhase): ActivePhase | "done" {
  const idx = PHASE_SEQUENCE.indexOf(current);
  if (idx === -1 || idx === PHASE_SEQUENCE.length - 1) return "done";
  return PHASE_SEQUENCE[idx + 1];
}
```

Check whether `PHASE_SEQUENCE` is still used elsewhere in `runners.ts`
(`nextPhase` was one of two usages — `loadPrompt` does not use it, but confirm
with `grep -n "PHASE_SEQUENCE" src/phases/runners.ts` before removing the
import) and drop the `PHASE_SEQUENCE` import from `runners.ts` only if it is now
unused there.

Run `deno task test` again to confirm nothing broke.

- [ ] **Step 8: Format, lint, commit**

```bash
deno fmt src/phases/advance.ts src/phases/advance_test.ts src/phases/runners.ts src/test-support.ts
deno lint src/phases/advance.ts src/phases/advance_test.ts src/phases/runners.ts src/test-support.ts
git add src/phases/advance.ts src/phases/advance_test.ts src/phases/runners.ts src/test-support.ts
git commit -m "feat(phases): walk per-ticket pipeline steps in advancePhase"
```

---

## Task 8: Intake prompt — `## Pipeline` section

**Files:**

- Modify: `src/phases/prompts/intake.md`

No test file — per this project's convention, prompt `.md` files are plain text
with no executable logic, so `_test.ts` files are not written for them.

- [ ] **Step 1: Add the `## Pipeline` section**

In `src/phases/prompts/intake.md`, insert a new section after the existing
`## Artifact type` section (i.e. immediately before the `{{principles}}` marker
at the end of the file):

````markdown
## Pipeline

If an `## Available Pipeline Templates` section appears below this prompt, judge
whether this ticket is simple enough to use one of the lighter templates listed
there: a single, self-contained change with no interface or API changes and no
more than one distinct acceptance criterion. If so, name it in your output file
body as a fenced YAML block under `## Pipeline`, using the same format as
`## Proposed Scope`, along with a one-sentence reason. Do not use the Edit tool
to write to `meta.md`. Do not include `pipeline` in the frontmatter.

```yaml
pipeline: fast
reason: Single-file config change, no interface changes, one acceptance criterion.
```
````

Omit the `## Pipeline` section entirely to use the default pipeline — absence is
the default. If no `## Available Pipeline Templates` section appears below this
prompt, always omit `## Pipeline`.

- [ ] **Step 2: Verify the file still renders**

Run: `deno task test:file src/phases/advance_test.ts`
Expected: PASS — the existing intake-prompt tests load this file dynamically
via `loadPromptFile`/`loadPrompt`, so they pick up the new content
automatically; none hardcode the old text.

- [ ] **Step 3: Format, lint, commit**

```bash
deno fmt src/phases/prompts/intake.md
deno lint src/phases/prompts/intake.md
git add src/phases/prompts/intake.md
git commit -m "docs(prompts): add pipeline selection to the intake prompt"
```

---

## Task 9: Intake self-review — pipeline choice safety net

**Files:**

- Modify: `src/phases/prompts/intake-self-review.md`

No test file — same rationale as Task 8.

- [ ] **Step 1: Update criterion 2 and add criterion 7**

In `src/phases/prompts/intake-self-review.md`, change:

```markdown
2. Optionally, there may be `Artifact type` and `Principles` sections.
```

to:

```markdown
2. Optionally, there may be `Artifact type`, `Pipeline`, and `Principles`
   sections.
```

Add a new criterion 7 at the end of the criteria list:

```markdown
7. If a `## Pipeline` section is present, independently verify the chosen
   template is justified: the ticket must describe a single, self-contained
   change with no interface or API changes implied and no more than one distinct
   acceptance criterion. If not justified, respond:

   REJECT Pipeline choice "<name>" is not justified — <reason>.
```

- [ ] **Step 2: Format, lint, commit**

```bash
deno fmt src/phases/prompts/intake-self-review.md
deno lint src/phases/prompts/intake-self-review.md
git add src/phases/prompts/intake-self-review.md
git commit -m "docs(prompts): gate intake pipeline choice in self-review"
```

---

## Task 10: Wire `resolvePipelineAction` and `buildPipelineOptionsText` in `compose.ts`

**Files:**

- Modify: `src/compose.ts`

**Interfaces:**

- Consumes: `resolvePipelineAction` (Task 6), `listAvailablePipelines`,
  `formatAvailablePipelines` (Task 3), `config.extensions.dir`,
  `config.pipelines?.default` (Tasks 2 & 5).

- [ ] **Step 1: Add imports**

In `src/compose.ts`, add near the other tick-action imports (after the
`reconcilePRsAction` import):

```ts
import { resolvePipelineAction } from "./tick-actions/resolve-pipeline.ts";
```

Add near any other `src/phases/*` import (or as a new import block):

```ts
import {
  formatAvailablePipelines,
  listAvailablePipelines,
} from "./phases/pipeline.ts";
```

- [ ] **Step 2: Register `resolvePipelineAction` in `tickActions`**

In the `tickActions` array, add a new entry immediately after the
`createWorktreeAction({...}),` block and before `createRemoteRepoAction`:

```ts
resolvePipelineAction({
  readIntakeOutput: async (ticketDir: string) => {
    const files: string[] = [];
    try {
      for await (const entry of readDir(ticketDir)) {
        if (
          entry.isFile &&
          /^\d{8}T\d{6}-intake\.md$/.test(entry.name)
        ) {
          files.push(entry.name);
        }
      }
    } catch {
      return null;
    }
    if (files.length === 0) return null;
    files.sort();
    return readTextFile(join(ticketDir, files[files.length - 1]));
  },
  run: captureCommandRunner(),
  extensionsDir: config.extensions.dir,
  defaultPipelineName: config.pipelines?.default,
  writeTicket,
  appendLog: appendTicketLog,
}),
```

- [ ] **Step 3: Wire `buildPipelineOptionsText` into the `TickDeps`
      construction**

Find the `buildRepoCorpusText` entry in the object passed to `advancePhase`'s
deps (near `currentBootId: () => bootId(),`):

```ts
buildRepoCorpusText: () =>
  listRepoCorpus(
    config.codebase.roots.map(expandHome),
    config.github.repos,
  )
    .then(formatRepoCorpus),
```

Add immediately after it:

```ts
buildPipelineOptionsText: () =>
  listAvailablePipelines(config.extensions.dir).then(
    formatAvailablePipelines,
  ),
```

- [ ] **Step 4: Run the full test suite**

Run: `deno task test` Expected: PASS. `deno check` (run implicitly by
`deno task test`) will catch any missed `TickDeps` field or import typo as a
compile error.

- [ ] **Step 5: Format, lint, commit**

```bash
deno fmt src/compose.ts
deno lint src/compose.ts
git add src/compose.ts
git commit -m "feat(compose): wire pipeline resolution into the tick loop"
```

---

## Task 11: Documentation

**Files:**

- Modify: `AGENTS.md`

- [ ] **Step 1: Amend the "Phase state machine" section**

Change:

```markdown
- `PHASE_SEQUENCE` covers only the five runner phases (`intake` →
  `implementation`), cycling `new → running → waiting → (approved) → running`;
  `merge` is handled explicitly in `advancePhase`.
```

to:

```markdown
- `PHASE_SEQUENCE` covers only the five runner phases (`intake` →
  `implementation`), cycling `new → running → waiting → (approved) → running`;
  `merge` is handled explicitly in `advancePhase`. It is the master list a
  per-ticket pipeline template subsequences from, not necessarily a given
  ticket's actual path — see Pipeline templates below.
```

- [ ] **Step 2: Insert a new "Pipeline templates" section**

Insert immediately after the "Phase state machine" section (before
`## Approval log`):

````markdown
## Pipeline templates

A ticket's phase sequence is not always the fixed
`intake → enrichment →
spec → plan → implementation` order.
`TicketState.pipeline` (a template name) and `TicketState.pipelineSteps`
(`{ phase: ActivePhase }[]`) are resolved once, right after intake is approved,
and pinned for the ticket's lifetime — `advancePhase` walks `pipelineSteps` (via
`nextPipelinePhase`, `src/phases/pipeline.ts`) instead of `PHASE_SEQUENCE`
directly. `PHASE_SEQUENCE` remains the master list of valid phase names in
canonical order; a template's `steps` is always an in-order subsequence of it,
never a reordering or a superset.

Templates are TOML files at `{extensionsDir}/pipelines/<name>/pipeline.toml`:

```toml
name = "fast"
description = "Skips enrichment, spec, and plan for a single, self-contained change."

[[steps]]
phase = "intake"

[[steps]]
phase = "implementation"
```
````

`name` must match the directory name exactly — a mismatch is
`template-invalid-shape`. `steps` must start with `intake` and end with
`implementation` (`merge`/`wont-do` are never part of a template — the state
machine appends them) and list any of `enrichment`/`spec`/`plan` in between, in
the same relative order as `PHASE_SEQUENCE`, with no reordering and no
duplicates. urras ships exactly one built-in template, `default`
(`DEFAULT_PIPELINE_STEPS`, equivalent to today's fixed `PHASE_SEQUENCE`) —
everything else is extensions-dir content only.

Intake judges whether a ticket is simple enough for a lighter template and, if
so, names it in its own output under a `## Pipeline` section (same
omit-means-default convention as `## Artifact type`) — never by editing
`meta.md` directly, since `selfReview` only reads a phase's output file.
`intake-self-review.md` independently re-derives whether the choice is
justified, the same way `spec-self-review.md` re-derives spec triviality.

`resolvePipelineAction` (`src/tick-actions/resolve-pipeline.ts`) fires once,
after intake is approved, extracts the requested name (via
`extractIntakePipeline`, an LLM classification call constrained to the templates
`listAvailablePipelines` currently finds — same pattern as
`extractIntakeArtifacts`), resolves it against `config.pipelines?.default` and
the built-in `default` as fallbacks, and pins the result onto
`pipeline`/`pipelineSteps`. A ticket written before this feature shipped has no
`pipelineSteps` — `advancePhase` treats that as `DEFAULT_PIPELINE_STEPS`, so no
migration is needed.

Best-of-N generation (running multiple candidate outputs at a step and judging
between them) and template-defined phase reordering or new phase names are
deliberately out of scope — see
`docs/superpowers/specs/2026-08-24-pipeline-templates-design.md` for why.

````
- [ ] **Step 3: Add the new log events to the per-ticket `log.ndjson` table**

In the "Per-ticket `log.ndjson` format" section's table, add three rows
after the `artifact-defaulted` row and before the `error` row:

```markdown
| `pipeline-corrected`                                                               | Intake pipeline choice parsed and validated; `pipeline`/`pipelineSteps` pinned; carries `pipeline`. |
| `pipeline-defaulted`                                                               | No pipeline requested; default pipeline pinned silently; carries `pipeline`.                        |
| `pipeline-invalid`                                                                 | A requested or configured pipeline name failed to load or validate; carries `requestedName` and `reason`. |
````

- [ ] **Step 4: Add the new reason labels**

In the same section, add `template-not-found`, `template-parse-failed`,
`template-invalid-shape`, and `template-invalid-order` to the parenthesized list
of `reason` labels (immediately before the closing
`). Reuse an
existing label...` sentence).

- [ ] **Step 5: Format, commit**

```bash
deno fmt AGENTS.md
git add AGENTS.md
git commit -m "docs: document pipeline templates"
```

---

## Final verification

- [ ] Run `deno task test` — expect all tests passing, 0 failures.
- [ ] Run `deno lint` and `deno fmt --check` across the whole repo — expect no
      findings.
- [ ] Manually re-read
      `docs/superpowers/specs/2026-08-24-pipeline-templates-design.md` section
      by section and confirm each is covered by a task above: Template artifact
      (Task 3), Selection/extraction/pinning (Tasks 2, 4, 6), Self-review update
      (Task 9), Sequencing engine (Tasks 1, 7), Config (Task 5), Testing (Tasks
      1, 3, 4, 6), Documentation (Task 11).
