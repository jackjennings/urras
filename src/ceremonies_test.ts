import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { join } from "@std/path";
import { existsSync } from "./filesystem.ts";
import { CeremonyRunner } from "./ceremonies.ts";
import { DocumentationGapsCeremony } from "./ceremonies/documentation-gaps.ts";
import {
  ceremonyHash,
  readApprovals,
  writeApprovals,
} from "./ceremonies/approvals.ts";
import { urrasDir } from "./paths.ts";
import { withLazyboyDir } from "./test-support.ts";
import type { TicketState } from "./state/types.ts";
import type { Ceremony } from "./ceremonies/types.ts";
import type { CommandRunner } from "./apfel.ts";
import type { LanguageModelRequest } from "./models/types.ts";

const TEST_NOW = Temporal.ZonedDateTime.from(
  "2026-07-27T10:00:00[America/New_York]",
);

function makeRunner(
  stateDir: string,
  opts: {
    extensionsDir?: string;
    appendTickLog?: (entry: object) => Promise<void>;
    now?: () => Temporal.ZonedDateTime;
    ceremonies?: ConstructorParameters<typeof CeremonyRunner>[1];
    runClaude?: (args: string[]) => Promise<{ stdout: string; code: number }>;
    notify?: (title: string, message: string) => Promise<void>;
    listTickets?: () => Promise<string[]>;
    readTicket?: (id: string) => Promise<TicketState>;
    generateText?: (
      request: LanguageModelRequest,
    ) => Promise<string | null>;
    commitState?: () => Promise<void>;
    pushTicket?: (ticket: { title: string; body: string }) => Promise<void>;
    timeoutMs?: number;
  } = {},
): CeremonyRunner {
  return new CeremonyRunner(
    {
      stateDir,
      extensionsDir: opts.extensionsDir ?? stateDir,
      appendTickLog: opts.appendTickLog ?? (() => Promise.resolve()),
      now: opts.now,
      runClaude: opts.runClaude,
      notify: opts.notify,
      listTickets: opts.listTickets ?? (() => Promise.resolve([])),
      readTicket: opts.readTicket ??
        (() => Promise.reject(new Error("not called"))),
      generateText: opts.generateText ?? (() => Promise.resolve("text")),
      commitState: opts.commitState ?? (() => Promise.resolve()),
      pushTicket: opts.pushTicket ?? (() => Promise.resolve()),
      timeoutMs: opts.timeoutMs,
    },
    opts.ceremonies ?? [],
  );
}

function makeCountedCeremony(
  name: string,
): { ceremony: Ceremony; runCount: () => number } {
  let count = 0;
  const ceremony: Ceremony = {
    name,
    run: async (_now, outputDir) => {
      await Deno.mkdir(outputDir, { recursive: true });
      await Deno.writeTextFile(
        join(outputDir, `${name}-output.md`),
        "output",
      );
      count++;
    },
  };
  return { ceremony, runCount: () => count };
}

Deno.test("CeremonyRunner: no ceremonies dir does not throw", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    await makeRunner(stateDir).run();
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: unknown ceremony directory silently skipped", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(stateDir, "ceremonies", "digest"), {
      recursive: true,
    });
    const { ceremony, runCount } = makeCountedCeremony("standup");
    await makeRunner(stateDir, { now: () => TEST_NOW, ceremonies: [ceremony] })
      .run();
    assertEquals(runCount(), 0);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: standup skipped when no config.toml", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(stateDir, "ceremonies", "standup"), {
      recursive: true,
    });
    const { ceremony, runCount } = makeCountedCeremony("standup");
    await makeRunner(stateDir, { now: () => TEST_NOW, ceremonies: [ceremony] })
      .run();
    assertEquals(runCount(), 0);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: invalid time appends warning and skips ceremony", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(stateDir, "ceremonies", "standup"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(stateDir, "ceremonies", "standup", "config.toml"),
      'time = "9am"',
    );
    const warnings: object[] = [];
    const { ceremony, runCount } = makeCountedCeremony("standup");
    await makeRunner(stateDir, {
      appendTickLog: (entry) => {
        warnings.push(entry);
        return Promise.resolve();
      },
      now: () => TEST_NOW,
      ceremonies: [ceremony],
    }).run();
    assertEquals(runCount(), 0);
    assertEquals(warnings.length, 1);
    assertEquals(
      (warnings[0] as Record<string, unknown>).event,
      "ceremony-warning",
    );
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: invalid time 25:00 appends warning and skips ceremony", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(stateDir, "ceremonies", "standup"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(stateDir, "ceremonies", "standup", "config.toml"),
      'time = "25:00"',
    );
    const warnings: object[] = [];
    const { ceremony } = makeCountedCeremony("standup");
    await makeRunner(stateDir, {
      appendTickLog: (entry) => {
        warnings.push(entry);
        return Promise.resolve();
      },
      now: () => TEST_NOW,
      ceremonies: [ceremony],
    }).run();
    assertEquals(warnings.length, 1);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: standup does not fire before configured time", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(stateDir, "ceremonies", "standup"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(stateDir, "ceremonies", "standup", "config.toml"),
      'time = "23:00"',
    );
    const { ceremony, runCount } = makeCountedCeremony("standup");
    await makeRunner(stateDir, { now: () => TEST_NOW, ceremonies: [ceremony] })
      .run();
    assertEquals(runCount(), 0);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: standup fires when time has passed", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(stateDir, "ceremonies", "standup"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(stateDir, "ceremonies", "standup", "config.toml"),
      'time = "09:00"',
    );
    const { ceremony, runCount } = makeCountedCeremony("standup");
    await makeRunner(stateDir, { now: () => TEST_NOW, ceremonies: [ceremony] })
      .run();
    assertEquals(runCount(), 1);
    const outputDir = join(stateDir, "ceremonies", "standup", "output");
    const files: string[] = [];
    for await (const entry of Deno.readDir(outputDir)) {
      files.push(entry.name);
    }
    assertEquals(files.length, 1);
    assertEquals(files[0], "standup-output.md");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: standup does not rerun if output file exists for today", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const outputDir = join(stateDir, "ceremonies", "standup", "output");
    await Deno.mkdir(outputDir, { recursive: true });
    await Deno.writeTextFile(
      join(stateDir, "ceremonies", "standup", "config.toml"),
      'time = "09:00"',
    );
    await Deno.writeTextFile(
      join(outputDir, "20260727T090000-standup.md"),
      "existing",
    );
    const { ceremony, runCount } = makeCountedCeremony("standup");
    await makeRunner(stateDir, { now: () => TEST_NOW, ceremonies: [ceremony] })
      .run();
    assertEquals(runCount(), 0);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: interval ceremony skipped on weekend when workdays_only", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(stateDir, "ceremonies", "interval-test"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(stateDir, "ceremonies", "interval-test", "config.toml"),
      'time = "09:00"\ninterval_hours = 2\nworkdays_only = true\n',
    );
    // 2026-07-25 is a Saturday
    const saturday = Temporal.ZonedDateTime.from(
      "2026-07-25T10:00:00[America/New_York]",
    );
    const { ceremony, runCount } = makeCountedCeremony("interval-test");
    await makeRunner(stateDir, {
      now: () => saturday,
      ceremonies: [ceremony],
    }).run();
    assertEquals(runCount(), 0);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: interval ceremony runs on weekend when workdays_only is false", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(stateDir, "ceremonies", "interval-test"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(stateDir, "ceremonies", "interval-test", "config.toml"),
      'time = "09:00"\ninterval_hours = 2\nworkdays_only = false\n',
    );
    const saturday = Temporal.ZonedDateTime.from(
      "2026-07-25T10:00:00[America/New_York]",
    );
    const { ceremony, runCount } = makeCountedCeremony("interval-test");
    await makeRunner(stateDir, {
      now: () => saturday,
      ceremonies: [ceremony],
    }).run();
    assertEquals(runCount(), 1);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: interval ceremony skipped when output file is within interval", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const outputDir = join(
      stateDir,
      "ceremonies",
      "interval-test",
      "output",
    );
    await Deno.mkdir(outputDir, { recursive: true });
    await Deno.writeTextFile(
      join(stateDir, "ceremonies", "interval-test", "config.toml"),
      'time = "09:00"\ninterval_hours = 2\n',
    );
    // TEST_NOW is 2026-07-27T10:00. A file from 1 hour ago is within the 2-hour interval.
    await Deno.writeTextFile(
      join(outputDir, "20260727T090000-interval-test.md"),
      "prior output",
    );
    const { ceremony, runCount } = makeCountedCeremony("interval-test");
    await makeRunner(stateDir, {
      now: () => TEST_NOW,
      ceremonies: [ceremony],
    }).run();
    assertEquals(runCount(), 0);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: interval ceremony runs when output file is beyond interval", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const outputDir = join(
      stateDir,
      "ceremonies",
      "interval-test",
      "output",
    );
    await Deno.mkdir(outputDir, { recursive: true });
    await Deno.writeTextFile(
      join(stateDir, "ceremonies", "interval-test", "config.toml"),
      'time = "09:00"\ninterval_hours = 2\n',
    );
    // 3 hours ago — beyond the 2-hour interval
    await Deno.writeTextFile(
      join(outputDir, "20260727T070000-interval-test.md"),
      "prior output",
    );
    const { ceremony, runCount } = makeCountedCeremony("interval-test");
    await makeRunner(stateDir, {
      now: () => TEST_NOW,
      ceremonies: [ceremony],
    }).run();
    assertEquals(runCount(), 1);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: interval ceremony runs when no prior output file exists", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(stateDir, "ceremonies", "interval-test"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(stateDir, "ceremonies", "interval-test", "config.toml"),
      'time = "09:00"\ninterval_hours = 2\n',
    );
    const { ceremony, runCount } = makeCountedCeremony("interval-test");
    await makeRunner(stateDir, {
      now: () => TEST_NOW,
      ceremonies: [ceremony],
    }).run();
    assertEquals(runCount(), 1);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: prompt ceremony dir runs PromptCeremony", async () => {
  using _lazyboy = withLazyboyDir();
  const stateDir = await Deno.makeTempDir();
  try {
    const ceremonyDir = join(stateDir, "ceremonies", "docs-gap");
    await Deno.mkdir(ceremonyDir, { recursive: true });
    await Deno.writeTextFile(
      join(ceremonyDir, "config.toml"),
      'time = "09:00"',
    );
    await Deno.writeTextFile(join(ceremonyDir, "prompt.md"), "List gaps.");
    await writeApprovals({
      "docs-gap": { hash: await ceremonyHash(ceremonyDir) },
    });

    await makeRunner(stateDir, {
      now: () => TEST_NOW,
      runClaude: () => Promise.resolve({ stdout: "Gaps found.\n", code: 0 }),
    }).run();

    const outputDir = join(stateDir, "ceremonies", "docs-gap", "output");
    const files: string[] = [];
    for await (const entry of Deno.readDir(outputDir)) {
      files.push(entry.name);
    }
    assertEquals(files.length, 1);
    assert(files[0].startsWith("20260727"));
    assert(files[0].endsWith("-docs-gap.md"));
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: a ceremony that never resolves triggers timeout warning", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(stateDir, "ceremonies", "digest"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(stateDir, "ceremonies", "digest", "config.toml"),
      'time = "09:00"\n',
    );
    const neverSettles: Ceremony = {
      name: "digest",
      run: () => new Promise<void>(() => {}),
    };
    const warnings: object[] = [];
    await makeRunner(stateDir, {
      now: () => TEST_NOW,
      ceremonies: [neverSettles],
      appendTickLog: (entry) => {
        warnings.push(entry);
        return Promise.resolve();
      },
      timeoutMs: 10,
    }).run();
    assertEquals(warnings.length, 1);
    assertEquals(warnings[0], {
      event: "ceremony-warning",
      ceremony: "digest",
      reason: "timeout",
    });
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});
function makeDocumentationGaps(
  stateDir: string,
  _outputDir: string,
  opts: {
    repoDir?: string;
    run?: CommandRunner;
    commitState?: () => Promise<void>;
    notify?: (title: string, message: string) => Promise<void>;
  } = {},
): DocumentationGapsCeremony {
  return new DocumentationGapsCeremony({
    stateDir,
    repoDir: opts.repoDir ?? stateDir,
    run: opts.run ??
      ((_args) => Promise.reject(new Error("run not expected"))),
    commitState: opts.commitState ?? (() => Promise.resolve()),
    notify: opts.notify,
  });
}

async function outputFiles(outputDir: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(outputDir)) files.push(entry.name);
  return files;
}

Deno.test("DocumentationGapsCeremony: no enrichment files writes no-gaps output without calling run", async () => {
  const stateDir = await Deno.makeTempDir();
  const outputDir = await Deno.makeTempDir();
  try {
    let runCalled = false;
    const commitState = spy(() => Promise.resolve());
    const ceremony = makeDocumentationGaps(stateDir, outputDir, {
      run: (_args) => {
        runCalled = true;
        return Promise.reject(new Error("should not be called"));
      },
      commitState,
    });
    await ceremony.run(TEST_NOW, outputDir);
    assertFalse(runCalled);
    assertSpyCalls(commitState, 1);
    const files = await outputFiles(outputDir);
    assertEquals(files.length, 1);
    assert(files[0].startsWith("20260727"));
    assert(files[0].endsWith("-documentation-gaps.md"));
    const content = await Deno.readTextFile(join(outputDir, files[0]));
    assertStringIncludes(content, "No uncovered gaps found.");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(outputDir, { recursive: true });
  }
});

Deno.test("DocumentationGapsCeremony: LLM response written verbatim to output file", async () => {
  const stateDir = await Deno.makeTempDir();
  const outputDir = await Deno.makeTempDir();
  try {
    const ticketDir = join(stateDir, "github", "org", "repo", "1");
    await Deno.mkdir(ticketDir, { recursive: true });
    await Deno.writeTextFile(
      join(ticketDir, "20260101T000000-enrichment.md"),
      "## Open Questions\n- Which model to use?\n",
    );
    const llmResponse =
      "# Documentation Gap Report\n\n_1 cluster across 1 ticket_\n\n## Model Selection\n\n**Occurrences:** 1\n";
    const ceremony = makeDocumentationGaps(stateDir, outputDir, {
      run: (_args) => Promise.resolve({ code: 0, stdout: llmResponse }),
    });
    await ceremony.run(TEST_NOW, outputDir);
    const files = await outputFiles(outputDir);
    assertEquals(files.length, 1);
    const content = await Deno.readTextFile(join(outputDir, files[0]));
    assertEquals(content, llmResponse);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(outputDir, { recursive: true });
  }
});

Deno.test("DocumentationGapsCeremony: LLM returning NO_GAPS writes no-gaps output", async () => {
  const stateDir = await Deno.makeTempDir();
  const outputDir = await Deno.makeTempDir();
  try {
    const ticketDir = join(stateDir, "github", "org", "repo", "1");
    await Deno.mkdir(ticketDir, { recursive: true });
    await Deno.writeTextFile(
      join(ticketDir, "20260101T000000-enrichment.md"),
      "## Open Questions\n- Which model to use?\n",
    );
    const ceremony = makeDocumentationGaps(stateDir, outputDir, {
      run: (_args) => Promise.resolve({ code: 0, stdout: "NO_GAPS" }),
    });
    await ceremony.run(TEST_NOW, outputDir);
    const files = await outputFiles(outputDir);
    const content = await Deno.readTextFile(join(outputDir, files[0]));
    assertStringIncludes(content, "No uncovered gaps found.");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(outputDir, { recursive: true });
  }
});

Deno.test("DocumentationGapsCeremony: LLM failure writes error output and still calls commitState", async () => {
  const stateDir = await Deno.makeTempDir();
  const outputDir = await Deno.makeTempDir();
  try {
    const ticketDir = join(stateDir, "github", "org", "repo", "1");
    await Deno.mkdir(ticketDir, { recursive: true });
    await Deno.writeTextFile(
      join(ticketDir, "20260101T000000-enrichment.md"),
      "## Open Questions\n- Which model to use?\n",
    );
    const commitState = spy(() => Promise.resolve());
    const ceremony = makeDocumentationGaps(stateDir, outputDir, {
      run: (_args) => Promise.reject(new Error("network error")),
      commitState,
    });
    await ceremony.run(TEST_NOW, outputDir);
    assertSpyCalls(commitState, 1);
    const files = await outputFiles(outputDir);
    const content = await Deno.readTextFile(join(outputDir, files[0]));
    assertStringIncludes(content, "Error:");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(outputDir, { recursive: true });
  }
});

Deno.test("DocumentationGapsCeremony: non-OK LLM response writes error output and still calls commitState", async () => {
  const stateDir = await Deno.makeTempDir();
  const outputDir = await Deno.makeTempDir();
  try {
    const ticketDir = join(stateDir, "github", "org", "repo", "1");
    await Deno.mkdir(ticketDir, { recursive: true });
    await Deno.writeTextFile(
      join(ticketDir, "20260101T000000-enrichment.md"),
      "## Open Questions\n- Which model to use?\n",
    );
    const commitState = spy(() => Promise.resolve());
    const ceremony = makeDocumentationGaps(stateDir, outputDir, {
      run: (_args) => Promise.resolve({ code: 1, stdout: "" }),
      commitState,
    });
    await ceremony.run(TEST_NOW, outputDir);
    assertSpyCalls(commitState, 1);
    const files = await outputFiles(outputDir);
    const content = await Deno.readTextFile(join(outputDir, files[0]));
    assertStringIncludes(content, "Error:");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(outputDir, { recursive: true });
  }
});

Deno.test("DocumentationGapsCeremony: notify failure does not abort ceremony", async () => {
  const stateDir = await Deno.makeTempDir();
  const outputDir = await Deno.makeTempDir();
  try {
    const commitState = spy(() => Promise.resolve());
    const ceremony = makeDocumentationGaps(stateDir, outputDir, {
      commitState,
      notify: () => Promise.reject(new Error("osascript failed")),
    });
    await ceremony.run(TEST_NOW, outputDir);
    assertSpyCalls(commitState, 1);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(outputDir, { recursive: true });
  }
});

Deno.test("DocumentationGapsCeremony: prior report headings included in LLM user message", async () => {
  const stateDir = await Deno.makeTempDir();
  const outputDir = await Deno.makeTempDir();
  try {
    const ticketDir = join(stateDir, "github", "org", "repo", "1");
    await Deno.mkdir(ticketDir, { recursive: true });
    await Deno.writeTextFile(
      join(ticketDir, "20260101T000000-enrichment.md"),
      "## Open Questions\n- Which model to use?\n",
    );
    await Deno.writeTextFile(
      join(outputDir, "20260101T060000-documentation-gaps.md"),
      "# Documentation Gap Report\n\n## Previously Reported Theme\n\n**Occurrences:** 3\n",
    );
    let capturedUserMessage = "";
    const ceremony = makeDocumentationGaps(stateDir, outputDir, {
      run: (args) => {
        capturedUserMessage = args[args.length - 1] as string;
        return Promise.resolve({ code: 0, stdout: "NO_GAPS" });
      },
    });
    await ceremony.run(TEST_NOW, outputDir);
    assertStringIncludes(capturedUserMessage, "Previously Reported Theme");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(outputDir, { recursive: true });
  }
});

Deno.test("DocumentationGapsCeremony: documentation corpus content included in LLM user message", async () => {
  const stateDir = await Deno.makeTempDir();
  const outputDir = await Deno.makeTempDir();
  const repoDir = await Deno.makeTempDir();
  try {
    const ticketDir = join(stateDir, "github", "org", "repo", "1");
    await Deno.mkdir(ticketDir, { recursive: true });
    await Deno.writeTextFile(
      join(ticketDir, "20260101T000000-enrichment.md"),
      "## Open Questions\n- Which model to use?\n",
    );
    await Deno.writeTextFile(
      join(repoDir, "AGENTS.md"),
      "# Agent Instructions\n\nSENTINEL_CORPUS_CONTENT\n",
    );
    let capturedUserMessage = "";
    const ceremony = new DocumentationGapsCeremony({
      stateDir,
      repoDir,
      run: (args) => {
        capturedUserMessage = args[args.length - 1] as string;
        return Promise.resolve({ code: 0, stdout: "NO_GAPS" });
      },
      commitState: () => Promise.resolve(),
    });
    await ceremony.run(TEST_NOW, outputDir);
    assertStringIncludes(capturedUserMessage, "SENTINEL_CORPUS_CONTENT");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(outputDir, { recursive: true });
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("DocumentationGapsCeremony: enrichment file with empty Open Questions section skipped", async () => {
  const stateDir = await Deno.makeTempDir();
  const outputDir = await Deno.makeTempDir();
  try {
    const ticketDir = join(stateDir, "github", "org", "repo", "1");
    await Deno.mkdir(ticketDir, { recursive: true });
    await Deno.writeTextFile(
      join(ticketDir, "20260101T000000-enrichment.md"),
      "## Open Questions\n## Next Section\nSome content.\n",
    );
    let runCalled = false;
    const ceremony = makeDocumentationGaps(stateDir, outputDir, {
      run: (_args) => {
        runCalled = true;
        return Promise.reject(new Error("should not be called"));
      },
    });
    await ceremony.run(TEST_NOW, outputDir);
    assertFalse(runCalled);
    const files = await outputFiles(outputDir);
    const content = await Deno.readTextFile(join(outputDir, files[0]));
    assertStringIncludes(content, "No uncovered gaps found.");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(outputDir, { recursive: true });
  }
});

Deno.test("DocumentationGapsCeremony: notify receives lazyboy title and Documentation gaps ready message", async () => {
  const stateDir = await Deno.makeTempDir();
  const outputDir = await Deno.makeTempDir();
  try {
    const notifyCalls: [string, string][] = [];
    const ceremony = makeDocumentationGaps(stateDir, outputDir, {
      notify: (title, message) => {
        notifyCalls.push([title, message]);
        return Promise.resolve();
      },
    });
    await ceremony.run(TEST_NOW, outputDir);
    assertEquals(notifyCalls, [["urras", "Documentation gaps ready"]]);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(outputDir, { recursive: true });
  }
});

async function writePromptCeremony(
  stateDir: string,
  name: string,
  config = 'time = "09:00"\n',
): Promise<string> {
  const dir = join(stateDir, "ceremonies", name);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, "config.toml"), config);
  await Deno.writeTextFile(join(dir, "prompt.md"), "summarize the day\n");
  return dir;
}

Deno.test("CeremonyRunner: unapproved prompt ceremony does not run", async () => {
  using _lazyboy = withLazyboyDir();
  const stateDir = await Deno.makeTempDir();
  try {
    await writePromptCeremony(stateDir, "digest");
    const runClaude = spy(() => Promise.resolve({ stdout: "out", code: 0 }));
    const appendTickLog = spy((_entry: object) => Promise.resolve());
    await makeRunner(stateDir, {
      now: () => TEST_NOW,
      runClaude,
      appendTickLog,
    })
      .run();
    assertSpyCalls(runClaude, 0);
    assertEquals(appendTickLog.calls[0].args[0], {
      event: "ceremony-warning",
      ceremony: "digest",
      reason: "not-approved",
    });
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: approved prompt ceremony runs", async () => {
  using _lazyboy = withLazyboyDir();
  const stateDir = await Deno.makeTempDir();
  try {
    const dir = await writePromptCeremony(stateDir, "digest");
    await writeApprovals({ digest: { hash: await ceremonyHash(dir) } });
    const runClaude = spy(() => Promise.resolve({ stdout: "out", code: 0 }));
    await makeRunner(stateDir, { now: () => TEST_NOW, runClaude }).run();
    assertSpyCalls(runClaude, 1);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: editing an approved prompt ceremony revokes it", async () => {
  using _lazyboy = withLazyboyDir();
  const stateDir = await Deno.makeTempDir();
  try {
    const dir = await writePromptCeremony(stateDir, "digest");
    await writeApprovals({ digest: { hash: await ceremonyHash(dir) } });
    await Deno.writeTextFile(join(dir, "prompt.md"), "do something else\n");
    const runClaude = spy(() => Promise.resolve({ stdout: "out", code: 0 }));
    await makeRunner(stateDir, { now: () => TEST_NOW, runClaude }).run();
    assertSpyCalls(runClaude, 0);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: built-in ceremony needs no approval", async () => {
  using _lazyboy = withLazyboyDir();
  const stateDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(stateDir, "ceremonies", "standup"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(stateDir, "ceremonies", "standup", "config.toml"),
      'time = "09:00"\n',
    );
    const { ceremony, runCount } = makeCountedCeremony("standup");
    await makeRunner(stateDir, { now: () => TEST_NOW, ceremonies: [ceremony] })
      .run();
    assertEquals(runCount(), 1);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: unapproved ceremony that is not due is silent", async () => {
  using _lazyboy = withLazyboyDir();
  const stateDir = await Deno.makeTempDir();
  try {
    await writePromptCeremony(stateDir, "digest", 'time = "23:00"\n');
    const appendTickLog = spy((_entry: object) => Promise.resolve());
    await makeRunner(stateDir, { now: () => TEST_NOW, appendTickLog }).run();
    assertSpyCalls(appendTickLog, 0);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: warns and notifies once per due window", async () => {
  using _lazyboy = withLazyboyDir();
  const stateDir = await Deno.makeTempDir();
  try {
    await writePromptCeremony(stateDir, "digest");
    const appendTickLog = spy((_entry: object) => Promise.resolve());
    const notify = spy((_title: string, _message: string) => Promise.resolve());
    const runner = makeRunner(stateDir, {
      now: () => TEST_NOW,
      appendTickLog,
      notify,
    });
    await runner.run();
    await runner.run();
    await runner.run();
    assertSpyCalls(appendTickLog, 1);
    assertSpyCalls(notify, 1);
    assertStringIncludes(
      notify.calls[0].args[1],
      "ur approve ceremony/digest",
    );
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: warns again in the next window", async () => {
  using _lazyboy = withLazyboyDir();
  const stateDir = await Deno.makeTempDir();
  try {
    await writePromptCeremony(stateDir, "digest");
    const appendTickLog = spy((_entry: object) => Promise.resolve());
    const tomorrow = TEST_NOW.add({ days: 1 });
    await makeRunner(stateDir, { now: () => TEST_NOW, appendTickLog }).run();
    await makeRunner(stateDir, { now: () => tomorrow, appendTickLog }).run();
    assertSpyCalls(appendTickLog, 2);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: warning preserves an existing hash", async () => {
  using _lazyboy = withLazyboyDir();
  const stateDir = await Deno.makeTempDir();
  try {
    const dir = await writePromptCeremony(stateDir, "digest");
    const hash = await ceremonyHash(dir);
    await writeApprovals({ digest: { hash } });
    await Deno.writeTextFile(join(dir, "prompt.md"), "changed\n");
    await makeRunner(stateDir, { now: () => TEST_NOW }).run();
    const approvals = await readApprovals();
    assertEquals(approvals.digest.hash, hash);
    assertEquals(approvals.digest.lastWarnedWindow, "20260727");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: a throwing notifier does not abort the run", async () => {
  using _lazyboy = withLazyboyDir();
  const stateDir = await Deno.makeTempDir();
  try {
    await writePromptCeremony(stateDir, "digest");
    const notify = () => Promise.reject(new Error("no notifier"));
    await makeRunner(stateDir, { now: () => TEST_NOW, notify }).run();
    assertEquals((await readApprovals()).digest.lastWarnedWindow, "20260727");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

async function writeModuleCeremony(
  stateDir: string,
  name: string,
  source: string,
): Promise<string> {
  const dir = join(stateDir, "ceremonies", name);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, "config.toml"), 'time = "09:00"\n');
  await Deno.writeTextFile(join(dir, "index.ts"), source);
  return dir;
}

Deno.test("CeremonyRunner: an unapproved module is never imported", async () => {
  using _lazyboy = withLazyboyDir();
  const stateDir = await Deno.makeTempDir();
  const sentinel = await Deno.makeTempFile();
  await Deno.remove(sentinel);
  try {
    await writeModuleCeremony(
      stateDir,
      "digest",
      `Deno.writeTextFileSync(${JSON.stringify(sentinel)}, "executed");
       export default function () {}`,
    );
    await makeRunner(stateDir, { now: () => TEST_NOW }).run();
    assertFalse(existsSync(sentinel));
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: an approved module runs", async () => {
  using _lazyboy = withLazyboyDir();
  const stateDir = await Deno.makeTempDir();
  try {
    const dir = await writeModuleCeremony(
      stateDir,
      "digest",
      `export default async function (context) {
        await context.writeOutput("done\\n");
      }`,
    );
    await writeApprovals({ digest: { hash: await ceremonyHash(dir) } });
    await makeRunner(stateDir, { now: () => TEST_NOW }).run();
    assertEquals(
      await Deno.readTextFile(
        join(dir, "output", "20260727T100000-digest.md"),
      ),
      "done\n",
    );
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: pushTicket from approved module calls the dep", async () => {
  using _lazyboy = withLazyboyDir();
  const stateDir = await Deno.makeTempDir();
  try {
    const dir = await writeModuleCeremony(
      stateDir,
      "digest",
      `export default async function (context) {
        await context.pushTicket({ title: "Fix bug", body: "Desc" });
      }`,
    );
    await writeApprovals({ digest: { hash: await ceremonyHash(dir) } });
    const pushTicket = spy(
      (_ticket: { title: string; body: string }) => Promise.resolve(),
    );
    await makeRunner(stateDir, { now: () => TEST_NOW, pushTicket }).run();
    assertSpyCalls(pushTicket, 1);
    assertEquals(pushTicket.calls[0].args[0], {
      title: "Fix bug",
      body: "Desc",
    });
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: index.ts wins over prompt.md", async () => {
  using _lazyboy = withLazyboyDir();
  const stateDir = await Deno.makeTempDir();
  try {
    const dir = await writeModuleCeremony(
      stateDir,
      "digest",
      `export default async function (context) {
        await context.writeOutput("module\\n");
      }`,
    );
    await Deno.writeTextFile(join(dir, "prompt.md"), "summarize\n");
    await writeApprovals({ digest: { hash: await ceremonyHash(dir) } });
    const runClaude = spy(() => Promise.resolve({ stdout: "out", code: 0 }));
    await makeRunner(stateDir, { now: () => TEST_NOW, runClaude }).run();
    assertSpyCalls(runClaude, 0);
    assert(existsSync(join(dir, "output", "20260727T100000-digest.md")));
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: a ceremony directory with an unsafe name is skipped", async () => {
  using _lazyboy = withLazyboyDir();
  const stateDir = await Deno.makeTempDir();
  try {
    const unsafe = 'x" & (do shell script "id") & "y';
    const dir = join(stateDir, "ceremonies", unsafe);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, "config.toml"), 'time = "09:00"\n');
    await Deno.writeTextFile(join(dir, "prompt.md"), "summarize\n");
    const appendTickLog = spy((_entry: object) => Promise.resolve());
    const notify = spy((_title: string, _message: string) => Promise.resolve());
    const runClaude = spy(() => Promise.resolve({ stdout: "out", code: 0 }));
    await makeRunner(stateDir, {
      now: () => TEST_NOW,
      appendTickLog,
      notify,
      runClaude,
    }).run();
    assertSpyCalls(notify, 0);
    assertSpyCalls(runClaude, 0);
    assertEquals(appendTickLog.calls[0].args[0], {
      event: "ceremony-warning",
      ceremony: unsafe,
      reason: "invalid-name",
    });
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: a non-regular-file index.ts is never treated as a module", async () => {
  using _lazyboy = withLazyboyDir();
  const stateDir = await Deno.makeTempDir();
  try {
    const dir = await writePromptCeremony(stateDir, "digest");
    const mkfifo = await new Deno.Command("mkfifo", {
      args: [join(dir, "index.ts")],
    }).output();
    assert(mkfifo.code === 0, "mkfifo must succeed for this test to mean much");
    await writeApprovals({ digest: { hash: await ceremonyHash(dir) } });
    const runClaude = spy(() => Promise.resolve({ stdout: "out", code: 0 }));
    const appendTickLog = spy((_entry: object) => Promise.resolve());
    await makeRunner(stateDir, {
      now: () => TEST_NOW,
      appendTickLog,
      runClaude,
    }).run();
    assertSpyCalls(runClaude, 1);
    assertSpyCalls(appendTickLog, 0);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: an unreadable ceremony does not abort the remaining ceremonies", async () => {
  using _lazyboy = withLazyboyDir();
  const stateDir = await Deno.makeTempDir();
  try {
    const broken = join(stateDir, "ceremonies", "alpha");
    await Deno.mkdir(join(broken, "config.toml"), { recursive: true });
    await Deno.writeTextFile(join(broken, "prompt.md"), "summarize\n");
    const good = await writePromptCeremony(stateDir, "zeta");
    await writeApprovals({ zeta: { hash: await ceremonyHash(good) } });
    const appendTickLog = spy((_entry: object) => Promise.resolve());
    const runClaude = spy(() => Promise.resolve({ stdout: "out", code: 0 }));
    await makeRunner(stateDir, {
      now: () => TEST_NOW,
      appendTickLog,
      runClaude,
    }).run();
    assertSpyCalls(runClaude, 1);
    assertEquals(
      (appendTickLog.calls[0].args[0] as Record<string, unknown>).ceremony,
      "alpha",
    );
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: directory-as-config.toml logs warning and does not run ceremony", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const ceremonyDir = join(stateDir, "ceremonies", "bad");
    await Deno.mkdir(join(ceremonyDir, "config.toml"), { recursive: true });
    const { ceremony, runCount } = makeCountedCeremony("bad");
    const appendTickLog = spy((_entry: object) => Promise.resolve());
    await makeRunner(stateDir, {
      now: () => TEST_NOW,
      ceremonies: [ceremony],
      appendTickLog,
    }).run();
    assertSpyCalls(appendTickLog, 1);
    assertEquals(appendTickLog.calls[0].args[0], {
      event: "ceremony-warning",
      ceremony: "bad",
      reason: "config.toml is not a regular file",
    });
    assertEquals(runCount(), 0);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: a corrupt approvals file does not destroy stored approvals", async () => {
  using _lazyboy = withLazyboyDir();
  const stateDir = await Deno.makeTempDir();
  try {
    await writePromptCeremony(stateDir, "digest");
    await Deno.mkdir(urrasDir(), { recursive: true });
    const approvalsFile = join(urrasDir(), "ceremony-approvals.json");
    await Deno.writeTextFile(approvalsFile, "{ not json");
    const appendTickLog = spy((_entry: object) => Promise.resolve());
    const notify = spy((_title: string, _message: string) => Promise.resolve());
    const runClaude = spy(() => Promise.resolve({ stdout: "out", code: 0 }));
    await makeRunner(stateDir, {
      now: () => TEST_NOW,
      appendTickLog,
      notify,
      runClaude,
    }).run();
    assertSpyCalls(runClaude, 0);
    assertSpyCalls(notify, 1);
    assertEquals(await Deno.readTextFile(approvalsFile), "{ not json");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: discovers ceremonies from extensionsDir, not stateDir", async () => {
  const stateDir = await Deno.makeTempDir();
  const extensionsDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(extensionsDir, "ceremonies", "standup"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(extensionsDir, "ceremonies", "standup", "config.toml"),
      'time = "09:00"\n',
    );
    const { ceremony, runCount } = makeCountedCeremony("standup");
    await makeRunner(stateDir, {
      extensionsDir,
      now: () => TEST_NOW,
      ceremonies: [ceremony],
    }).run();
    assertEquals(runCount(), 1);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(extensionsDir, { recursive: true });
  }
});

Deno.test("CeremonyRunner: output written to stateDir/ceremonies/<name>/output when extensionsDir differs", async () => {
  using _lazyboy = withLazyboyDir();
  const stateDir = await Deno.makeTempDir();
  const extensionsDir = await Deno.makeTempDir();
  try {
    const dir = join(extensionsDir, "ceremonies", "docs-gap");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, "config.toml"), 'time = "09:00"');
    await Deno.writeTextFile(join(dir, "prompt.md"), "List gaps.");
    await writeApprovals({
      "docs-gap": { hash: await ceremonyHash(dir) },
    });
    await makeRunner(stateDir, {
      extensionsDir,
      now: () => TEST_NOW,
      runClaude: () => Promise.resolve({ stdout: "Gaps found.\n", code: 0 }),
    }).run();
    const outputDir = join(stateDir, "ceremonies", "docs-gap", "output");
    const files: string[] = [];
    for await (const entry of Deno.readDir(outputDir)) {
      files.push(entry.name);
    }
    assertEquals(files.length, 1);
    assert(files[0].startsWith("20260727"));
    assert(files[0].endsWith("-docs-gap.md"));
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(extensionsDir, { recursive: true });
  }
});

Deno.test("ceremonyHash: output/ subdir is included in hash when present", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "prompt.md"), "do something\n");
    const hashWithout = await ceremonyHash(dir);
    await Deno.mkdir(join(dir, "output"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "output", "20260727-result.md"),
      "done\n",
    );
    const hashWith = await ceremonyHash(dir);
    assertNotEquals(hashWithout, hashWith);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
