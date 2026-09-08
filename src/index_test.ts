import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertExists,
  assertFalse,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { findLatestPhaseOutput } from "./review.ts";
import { formatCompletions } from "./commands/completions.ts";
import { commands } from "./commands/registry.ts";
import { formatCommandHelp, formatGlobalHelp } from "./commands/help.ts";

function runIndex(args: string[], env?: Record<string, string>) {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-all",
      new URL("./index.ts", import.meta.url).pathname,
      ...args,
    ],
    env: { ...Deno.env.toObject(), ...env },
    stdout: "piped",
    stderr: "piped",
  });
  return cmd.output();
}

const zshFile = new URL("./completion.zsh", import.meta.url).pathname;

Deno.test("completion zsh: output begins with #compdef lazyboy", async () => {
  const content = await Deno.readTextFile(zshFile);
  assert(content.startsWith("#compdef ur"));
});

Deno.test("completion zsh: defines and registers _lazyboy", async () => {
  const content = await Deno.readTextFile(zshFile);
  assertStringIncludes(content, "_ur()");
  assertStringIncludes(content, "compdef _ur ur");
});

Deno.test(
  "completion zsh: derives the command list from lazyboy _completions",
  async () => {
    const content = await Deno.readTextFile(zshFile);
    assertStringIncludes(content, "ur _completions 2>/dev/null");
  },
);

Deno.test(
  "completion zsh: args state falls back to lazyboy _ids for id-based commands",
  async () => {
    const content = await Deno.readTextFile(zshFile);
    assertStringIncludes(content, "ur _ids 2>/dev/null");
  },
);

Deno.test(
  "completion zsh: args state splits a literal completesWith list on commas",
  async () => {
    const content = await Deno.readTextFile(zshFile);
    assertStringIncludes(content, "${(s.,.)completesWith}");
  },
);

Deno.test("doctor command: registered with correct metadata", () => {
  const cmd = commands.find((c) => c.name === "doctor");
  assertExists(cmd);
  assertEquals(cmd!.description, "Run health checks and report status");
});

Deno.test("_completions: lists all public subcommands with descriptions", () => {
  const output = formatCompletions(commands);
  const names = output.trim().split("\n").map((l) => l.split("\t")[0]);
  for (
    const cmd of [
      "tick",
      "approve",
      "status",
      "enable",
      "disable",
      "completion",
      "retry",
      "review",
      "shell",
      "update",
    ]
  ) {
    assertArrayIncludes(names, [cmd], `missing ${cmd}`);
  }
});

Deno.test(
  "_completions: excludes internal (underscore-prefixed) commands",
  () => {
    const names = formatCompletions(commands)
      .trim()
      .split("\n")
      .map((l) => l.split("\t")[0]);
    assertFalse(names.some((n) => n.startsWith("_")));
  },
);

Deno.test(
  "_completions: id-based commands report _ids as completesWith",
  () => {
    const lines = formatCompletions(commands).trim().split("\n");
    for (const cmd of ["approve", "retry", "review", "shell"]) {
      const line = lines.find((l) => l.split("\t")[0] === cmd);
      assertEquals(line?.split("\t")[2], "_ids", `${cmd} completesWith`);
    }
  },
);

Deno.test(
  "_completions: completion command reports zsh as completesWith",
  () => {
    const line = formatCompletions(commands)
      .trim()
      .split("\n")
      .find((l) => l.split("\t")[0] === "completion");
    assertEquals(line?.split("\t")[2], "zsh");
  },
);

Deno.test("completion alone: exits 1 with usage on stderr", async () => {
  const result = await runIndex(["completion"]);
  assertEquals(result.code, 1);
  assertStringIncludes(
    new TextDecoder().decode(result.stderr),
    "Usage: ur completion <zsh>",
  );
});

Deno.test(
  "completion bash: exits 1 with unsupported shell on stderr",
  async () => {
    const result = await runIndex(["completion", "bash"]);
    assertEquals(result.code, 1);
    assertStringIncludes(
      new TextDecoder().decode(result.stderr),
      "Unsupported shell: bash",
    );
  },
);

async function makeFakeHome(stateDir: string): Promise<string> {
  const home = await Deno.makeTempDir();
  const configDir = join(home, ".config", "urras");
  await Deno.mkdir(configDir, { recursive: true });
  await Deno.writeTextFile(
    join(configDir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]
[state]
dir = "${stateDir}"
[tick]
concurrency = 1
`,
  );
  return home;
}

Deno.test("_ids: prints one ticket ID per line and exits 0", async () => {
  const stateDir = await Deno.makeTempDir();
  await Deno.mkdir(
    join(stateDir, "github", "jackjennings", "lazyboy", "1"),
    { recursive: true },
  );
  await Deno.mkdir(
    join(stateDir, "github", "jackjennings", "lazyboy", "2"),
    { recursive: true },
  );
  await Deno.writeTextFile(
    join(stateDir, "github", "jackjennings", "lazyboy", "1", "meta.md"),
    "---\nid: github/jackjennings/lazyboy/1\n---\n",
  );
  await Deno.writeTextFile(
    join(stateDir, "github", "jackjennings", "lazyboy", "2", "meta.md"),
    "---\nid: github/jackjennings/lazyboy/2\n---\n",
  );
  const home = await makeFakeHome(stateDir);
  try {
    const result = await runIndex(["_ids"], { HOME: home });
    assertEquals(result.code, 0);
    const lines = new TextDecoder().decode(result.stdout)
      .trim()
      .split("\n")
      .sort();
    assertEquals(lines, [
      "github/jackjennings/lazyboy/1",
      "github/jackjennings/lazyboy/2",
    ]);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test(
  "_ids: empty output and exits 0 when state dir does not exist",
  async () => {
    const home = await makeFakeHome("/nonexistent/lazyboy-state-dir");
    try {
      const result = await runIndex(["_ids"], { HOME: home });
      assertEquals(result.code, 0);
      assertEquals(new TextDecoder().decode(result.stdout).trim(), "");
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  },
);

Deno.test("review: exits 1 with usage message when id is missing", async () => {
  const result = await runIndex(["review"]);
  assertEquals(result.code, 1);
  assertStringIncludes(
    new TextDecoder().decode(result.stderr),
    "Usage: ur review <ticket-id>",
  );
});

Deno.test("_completions: reports review's description", () => {
  assertStringIncludes(
    formatCompletions(commands),
    "review\treview the latest phase output\t_ids",
  );
});

Deno.test(
  "review: findLatestPhaseOutput returns null when no output files exist",
  async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      const result = await findLatestPhaseOutput(tempDir);
      assertEquals(result, null);
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "review: findLatestPhaseOutput returns latest prefixed revision file",
  async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(tempDir, "20260629T154506-plan.md"),
        "rev1",
      );
      await Deno.writeTextFile(
        join(tempDir, "20260629T225507-plan.md"),
        "rev2",
      );
      const result = await findLatestPhaseOutput(tempDir);
      assertEquals(result?.phaseName, "plan");
      assertEquals(result?.filename, "20260629T225507-plan.md");
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "review: findLatestPhaseOutput returns most advanced phase with output",
  async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(tempDir, "20260629T154506-intake.md"),
        "intake",
      );
      await Deno.writeTextFile(
        join(tempDir, "20260629T154506-spec.md"),
        "spec",
      );
      const result = await findLatestPhaseOutput(tempDir);
      assertEquals(result?.phaseName, "spec");
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "review: findLatestPhaseOutput excludes feedback files from revision glob",
  async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(tempDir, "20260629T154506-plan-feedback.md"),
        "fb",
      );
      const result = await findLatestPhaseOutput(tempDir);
      assertEquals(result, null);
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

async function makeTicketHome(
  stateDir: string,
  id: string,
  worktrees: Record<string, { path: string; branch: string }>,
): Promise<string> {
  const home = await makeFakeHome(stateDir);
  const ticketDir = join(stateDir, id);
  await Deno.mkdir(ticketDir, { recursive: true });
  const worktreesYaml = Object.entries(worktrees)
    .map(([slug, w]) =>
      `  ${slug}:\n    path: ${w.path}\n    branch: ${w.branch}`
    )
    .join("\n");
  await Deno.writeTextFile(
    join(ticketDir, "meta.md"),
    `---
id: ${id}
provider: github
title: Test Ticket
url: https://github.com/jackjennings/lazyboy/issues/1
phase: plan
status: waiting
approved: false
scope: []
created: "2026-06-01T00:00:00Z"
updated: "2026-06-01T00:00:00Z"
worktrees:
${worktreesYaml}
---

body
`,
  );
  return home;
}

Deno.test("shell: exits 1 with usage when id is missing", async () => {
  const result = await runIndex(["shell"]);
  assertEquals(result.code, 1);
  assertStringIncludes(
    new TextDecoder().decode(result.stderr),
    "Usage: ur shell <ticket-id>",
  );
});

Deno.test("shell: exits 1 with OS error when ticket not found", async () => {
  const stateDir = await Deno.makeTempDir();
  const home = await makeFakeHome(stateDir);
  try {
    const result = await runIndex(["shell", "gh-99999"], { HOME: home });
    assertEquals(result.code, 1);
    assertStringIncludes(
      new TextDecoder().decode(result.stderr),
      "gh-99999",
    );
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test(
  "shell: exits 1 with no worktrees message when ticket has no worktrees",
  async () => {
    const stateDir = await Deno.makeTempDir();
    const ticketDir = join(stateDir, "gh-1");
    await Deno.mkdir(ticketDir);
    await Deno.writeTextFile(
      join(ticketDir, "meta.md"),
      `---
id: gh-1
provider: github
title: Test
url: https://github.com/jackjennings/lazyboy/issues/1
phase: intake
status: new
approved: false
scope: []
created: "2026-06-01T00:00:00Z"
updated: "2026-06-01T00:00:00Z"
worktrees: {}
---

body
`,
    );
    const home = await makeFakeHome(stateDir);
    try {
      const result = await runIndex(["shell", "gh-1"], { HOME: home });
      assertEquals(result.code, 1);
      assertStringIncludes(
        new TextDecoder().decode(result.stderr),
        "No worktrees found for gh-1",
      );
    } finally {
      await Deno.remove(stateDir, { recursive: true });
      await Deno.remove(home, { recursive: true });
    }
  },
);

Deno.test(
  "shell: exits 1 with path error when worktree path does not exist",
  async () => {
    const stateDir = await Deno.makeTempDir();
    const home = await makeTicketHome(stateDir, "gh-1", {
      "jackjennings/lazyboy": {
        path: "/nonexistent/path/gh-1/jackjennings/lazyboy",
        branch: "gh-1",
      },
    });
    try {
      const result = await runIndex(["shell", "gh-1"], { HOME: home });
      assertEquals(result.code, 1);
      assertStringIncludes(
        new TextDecoder().decode(result.stderr),
        "shell: /nonexistent/path/gh-1/jackjennings/lazyboy: not a directory",
      );
    } finally {
      await Deno.remove(stateDir, { recursive: true });
      await Deno.remove(home, { recursive: true });
    }
  },
);

Deno.test(
  "shell: exits 0 when worktree path exists and shell exits 0",
  async () => {
    const stateDir = await Deno.makeTempDir();
    const worktreePath = await Deno.makeTempDir();
    const home = await makeTicketHome(stateDir, "gh-1", {
      "jackjennings/lazyboy": { path: worktreePath, branch: "gh-1" },
    });
    try {
      const result = await runIndex(["shell", "gh-1"], {
        HOME: home,
        SHELL: "/usr/bin/true",
      });
      assertEquals(result.code, 0);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
      await Deno.remove(worktreePath, { recursive: true });
      await Deno.remove(home, { recursive: true });
    }
  },
);

Deno.test(
  "shell: propagates non-zero exit code from spawned shell",
  async () => {
    const stateDir = await Deno.makeTempDir();
    const worktreePath = await Deno.makeTempDir();
    const home = await makeTicketHome(stateDir, "gh-1", {
      "jackjennings/lazyboy": { path: worktreePath, branch: "gh-1" },
    });
    try {
      const result = await runIndex(["shell", "gh-1"], {
        HOME: home,
        SHELL: "/usr/bin/false",
      });
      assertEquals(result.code, 1);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
      await Deno.remove(worktreePath, { recursive: true });
      await Deno.remove(home, { recursive: true });
    }
  },
);

Deno.test("_completions: reports shell's description", () => {
  assertStringIncludes(
    formatCompletions(commands),
    "shell\topen a shell in the worktree for a ticket\t_ids",
  );
});

async function gitExec(args: string[], cwd: string): Promise<void> {
  await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
}

async function makeRepoWithRemote(): Promise<
  { localDir: string; tmpDir: string }
> {
  const tmpDir = await Deno.makeTempDir();
  const upstreamDir = join(tmpDir, "upstream.git");
  const midDir = join(tmpDir, "mid");
  const localDir = join(tmpDir, "local");

  await Deno.mkdir(upstreamDir);
  await gitExec(["init", "--bare"], upstreamDir);
  await gitExec(["clone", upstreamDir, midDir], tmpDir);
  await gitExec(["config", "user.email", "test@test.com"], midDir);
  await gitExec(["config", "user.name", "Test"], midDir);
  await gitExec(["config", "commit.gpgsign", "false"], midDir);
  await Deno.writeTextFile(join(midDir, "README.md"), "init");
  await gitExec(["add", "."], midDir);
  await gitExec(["commit", "-m", "init"], midDir);
  await gitExec(["push"], midDir);
  await gitExec(["clone", upstreamDir, localDir], tmpDir);
  await gitExec(["config", "user.email", "test@test.com"], localDir);
  await gitExec(["config", "user.name", "Test"], localDir);
  await gitExec(["config", "commit.gpgsign", "false"], localDir);

  return { localDir, tmpDir };
}

Deno.test(
  "update: exits 0 when working tree is clean and pull succeeds",
  async () => {
    const { localDir, tmpDir } = await makeRepoWithRemote();
    try {
      const { runUpdate, outcomeExitCode } = await import(
        "./commands/update.ts"
      );
      const result = await runUpdate(localDir);
      assertEquals(outcomeExitCode(result), 0);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "update: reports dirty when working tree has local modifications",
  async () => {
    const { localDir, tmpDir } = await makeRepoWithRemote();
    try {
      await Deno.writeTextFile(join(localDir, "dirty.txt"), "change");
      const { runUpdate } = await import("./commands/update.ts");
      const result = await runUpdate(localDir);
      assertEquals(result, { status: "dirty" });
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "update: does not run git pull when working tree is dirty",
  async () => {
    const { localDir, tmpDir } = await makeRepoWithRemote();
    try {
      await Deno.writeTextFile(join(localDir, "dirty.txt"), "change");
      const { runUpdate } = await import("./commands/update.ts");
      await runUpdate(localDir);
      const result = await new Deno.Command("git", {
        args: ["log", "--oneline"],
        cwd: localDir,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const log = new TextDecoder().decode(result.stdout).trim().split("\n");
      assertEquals(log.length, 1);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "update: reports diverged with real counts when fast-forward is refused",
  async () => {
    const { localDir, tmpDir } = await makeRepoWithRemote();
    try {
      await gitExec(["config", "pull.ff", "only"], localDir);
      const midDir = join(tmpDir, "mid");
      for (const n of ["1", "2"]) {
        await Deno.writeTextFile(join(midDir, `remote-${n}.txt`), n);
        await gitExec(["add", "."], midDir);
        await gitExec(["commit", "-m", `remote ${n}`], midDir);
      }
      await gitExec(["push"], midDir);

      await Deno.writeTextFile(join(localDir, "local.txt"), "local");
      await gitExec(["add", "."], localDir);
      await gitExec(["commit", "-m", "local"], localDir);

      const { runUpdate } = await import("./commands/update.ts");
      const result = await runUpdate(localDir);
      assertEquals(result, {
        status: "diverged",
        divergence: { ahead: 1, behind: 2 },
      });
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test("update: exits non-zero when pull fails", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await gitExec(["init"], tmpDir);
    await gitExec(["config", "user.email", "test@test.com"], tmpDir);
    await gitExec(["config", "user.name", "Test"], tmpDir);
    await gitExec(["config", "commit.gpgsign", "false"], tmpDir);
    await Deno.writeTextFile(join(tmpDir, "README.md"), "init");
    await gitExec(["add", "."], tmpDir);
    await gitExec(["commit", "-m", "init"], tmpDir);
    await gitExec(
      ["remote", "add", "origin", "file:///nonexistent/repo.git"],
      tmpDir,
    );
    await gitExec(["config", "branch.main.remote", "origin"], tmpDir);
    await gitExec(
      ["config", "branch.main.merge", "refs/heads/main"],
      tmpDir,
    );
    const { runUpdate, outcomeExitCode } = await import(
      "./commands/update.ts"
    );
    const result = await runUpdate(tmpDir);
    assertNotEquals(outcomeExitCode(result), 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("update: produces no stdout or stderr output", async () => {
  const result = await runIndex(["update"]);
  assertEquals(new TextDecoder().decode(result.stdout), "");
  assertEquals(new TextDecoder().decode(result.stderr), "");
});

Deno.test("approve --help: prints usage line to stdout", () => {
  const cmd = commands.find((c) => c.name === "approve")!;
  assertStringIncludes(
    formatCommandHelp(cmd),
    "Usage: ur approve <ticket-id|ceremony/<name>>",
  );
});

Deno.test("approve --help: prints description to stdout", () => {
  const cmd = commands.find((c) => c.name === "approve")!;
  assertStringIncludes(
    formatCommandHelp(cmd),
    "approve the current phase gate",
  );
});

Deno.test("approve --help: blank line separates usage and description", () => {
  const cmd = commands.find((c) => c.name === "approve")!;
  assertStringIncludes(
    formatCommandHelp(cmd),
    "Usage: ur approve <ticket-id|ceremony/<name>>\n\napprove the current phase gate",
  );
});

Deno.test("tail --help: prints usage and description", () => {
  const cmd = commands.find((c) => c.name === "tail")!;
  const output = formatCommandHelp(cmd);
  assertStringIncludes(output, "Usage: ur tail [ticket-id]");
  assertStringIncludes(output, "stream the tick log or a ticket's event log");
});

Deno.test("tick --help: omits usage line when usage is absent", () => {
  const cmd = commands.find((c) => c.name === "tick")!;
  assertFalse(formatCommandHelp(cmd).includes("Usage:"));
});

Deno.test("--help at position 2 does not trigger help", async () => {
  const stateDir = await Deno.makeTempDir();
  const home = await makeFakeHome(stateDir);
  try {
    const result = await runIndex(["approve", "nonexistent", "--help"], {
      HOME: home,
    });
    assertEquals(result.code, 1);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("--help: usage line lists sorted public commands", () => {
  assertStringIncludes(formatGlobalHelp(commands), "Usage: ur <approve|");
});

Deno.test("--help: includes Commands: section header", () => {
  assertStringIncludes(formatGlobalHelp(commands), "Commands:");
});

Deno.test("--help: lists approve with description", () => {
  assertStringIncludes(
    formatGlobalHelp(commands),
    "approve the current phase gate",
  );
});

Deno.test("--help: names padded to longest for alignment", () => {
  const output = formatGlobalHelp(commands);
  const lines = output.split("\n");
  const approveLine = lines.find((l) => /^\s+approve\s/.test(l))!;
  const completionLine = lines.find((l) => /^\s+completion\s/.test(l))!;
  assertEquals(
    approveLine.indexOf("approve the current phase gate"),
    completionLine.indexOf("print shell completion script"),
  );
});

Deno.test("--help: excludes private commands", () => {
  const output = formatGlobalHelp(commands);
  assertFalse(output.includes("_completions"));
  assertFalse(output.includes("_ids"));
});

Deno.test("--help: commands are sorted alphabetically", () => {
  const output = formatGlobalHelp(commands);
  const names = output
    .split("\n")
    .filter((l) => l.startsWith("  "))
    .map((l) => l.trim().split(/\s+/)[0]);
  assertEquals(names, [...names].sort());
});

Deno.test("env file: var from file is visible to running command", async () => {
  const stateDir = await Deno.makeTempDir();
  const home = await Deno.makeTempDir();
  const configDir = join(home, ".config", "urras");
  await Deno.mkdir(configDir, { recursive: true });
  await Deno.writeTextFile(
    join(configDir, "config.toml"),
    `[github]\nrepos = ["jackjennings/lazyboy"]\n[github.accounts.x]\ntoken_env = "LAZYBOY_ENV_FILE_TOKEN"\nlogin = "x"\n[state]\ndir = "${stateDir}"\n[tick]\nconcurrency = 1\n`,
  );
  await Deno.writeTextFile(
    join(configDir, "env"),
    "LAZYBOY_ENV_FILE_TOKEN=tokenvalue\n",
  );
  try {
    const result = await runIndex(["status"], { HOME: home });
    assertEquals(result.code, 0);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("env file: shell env var takes precedence over file", async () => {
  const stateDir = await Deno.makeTempDir();
  const home = await Deno.makeTempDir();
  const configDir = join(home, ".config", "urras");
  await Deno.mkdir(configDir, { recursive: true });
  await Deno.writeTextFile(
    join(configDir, "config.toml"),
    `[github]\nrepos = ["jackjennings/lazyboy"]\n[state]\ndir = "${stateDir}"\n[tick]\nconcurrency = 1\n`,
  );
  await Deno.writeTextFile(join(configDir, "env"), "HOME=/nonexistent\n");
  try {
    const result = await runIndex(["status"], { HOME: home });
    assertEquals(result.code, 0);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("env file: absent env file does not cause an error", async () => {
  const home = await Deno.makeTempDir();
  const configDir = join(home, ".config", "urras");
  await Deno.mkdir(configDir, { recursive: true });
  try {
    const result = await runIndex(["--help"], { HOME: home });
    assertEquals(result.code, 0);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test(
  "env file: value containing = is not truncated at second =",
  async () => {
    const stateDir = await Deno.makeTempDir();
    const home = await Deno.makeTempDir();
    const configDir = join(home, ".config", "urras");
    await Deno.mkdir(configDir, { recursive: true });
    await Deno.writeTextFile(
      join(configDir, "config.toml"),
      `[github]\nrepos = ["jackjennings/lazyboy"]\n[github.accounts.x]\ntoken_env = "LAZYBOY_ENV_FILE_TOKEN"\nlogin = "x"\n[state]\ndir = "${stateDir}"\n[tick]\nconcurrency = 1\n`,
    );
    await Deno.writeTextFile(
      join(configDir, "env"),
      "LAZYBOY_ENV_FILE_TOKEN==base64=padded==\n",
    );
    try {
      const result = await runIndex(["status"], { HOME: home });
      assertEquals(result.code, 0);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
      await Deno.remove(home, { recursive: true });
    }
  },
);

Deno.test(
  "index: catches command error and exits 1 with message only",
  async () => {
    const stateDir = await Deno.makeTempDir();
    const home = await makeFakeHome(stateDir);
    try {
      const result = await runIndex(["approve", "nonexistent-ticket"], {
        HOME: home,
      });
      assertEquals(result.code, 1);
      const stderr = new TextDecoder().decode(result.stderr);
      assertFalse(stderr.includes("Uncaught"));
      assertStringIncludes(stderr, "nonexistent-ticket");
    } finally {
      await Deno.remove(stateDir, { recursive: true });
      await Deno.remove(home, { recursive: true });
    }
  },
);

Deno.test(
  "tick.sh: does not call lazyboy update",
  async () => {
    const tickSh = new URL("../scripts/tick.sh", import.meta.url).pathname;
    const content = await Deno.readTextFile(tickSh);
    const lines = content.split("\n");
    const updateIdx = lines.findIndex(
      (l) => l.includes("lazyboy") && l.includes("update"),
    );
    assertEquals(updateIdx, -1);
  },
);
