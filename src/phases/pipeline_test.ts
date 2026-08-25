import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  DEFAULT_PIPELINE_STEPS,
  formatAvailablePipelines,
  listAvailablePipelines,
  loadPipelineTemplate,
  nextPipelinePhase,
  type PipelineStep,
} from "./pipeline.ts";

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
  const steps: PipelineStep[] = [
    { phase: "intake" },
    { phase: "implementation" },
  ];
  assertEquals(nextPipelinePhase(steps, "spec"), "done");
});

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

Deno.test("loadPipelineTemplate: name containing '..' returns template-invalid-shape", async () => {
  await withTempExtensionsDir(async (dir) => {
    const result = await loadPipelineTemplate(dir, "..");
    assertEquals(result, { ok: false, reason: "template-invalid-shape" });
  });
});

Deno.test("loadPipelineTemplate: name containing '/' returns template-invalid-shape", async () => {
  await withTempExtensionsDir(async (dir) => {
    const result = await loadPipelineTemplate(dir, "../etc/passwd");
    assertEquals(result, { ok: false, reason: "template-invalid-shape" });
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

Deno.test("listAvailablePipelines: skips a directory whose name fails the charset check", async () => {
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
    const invalidName = "invalid name!";
    await Deno.mkdir(join(dir, "pipelines", invalidName), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(dir, "pipelines", invalidName, "pipeline.toml"),
      `name = "${invalidName}"

[[steps]]
phase = "intake"

[[steps]]
phase = "implementation"
`,
    );
    const templates = await listAvailablePipelines(dir);
    assertEquals(templates.length, 1);
    assertEquals(templates[0].name, "fast");
  });
});

Deno.test("listAvailablePipelines: excludes a directory literally named 'default'", async () => {
  await withTempExtensionsDir(async (dir) => {
    await writeTemplate(
      dir,
      "default",
      `name = "default"

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
    const templates = await listAvailablePipelines(dir);
    assertEquals(templates, []);
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
