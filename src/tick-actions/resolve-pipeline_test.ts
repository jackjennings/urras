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
