import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertExists,
  assertFalse,
  assertLess,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { assertSpyCall, assertSpyCalls, spy } from "@std/testing/mock";
import { advancePhase, type TickDeps } from "./advance.ts";
import type { TicketState } from "../state/types.ts";
import { loadPromptFile } from "./runners.ts";
import { makeTickDeps, makeTicket } from "../test-support.ts";

type SpawnOpts = Parameters<TickDeps["spawn"]>[0];

Deno.test("advancePhase: new ticket starts intake", async () => {
  const ticket = makeTicket({ phase: "intake", status: "new" });
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
    }),
  );
  assertSpyCall(spawnSpy, 0);
  assertEquals(spawnedPhase, "intake");
});

Deno.test("advancePhase: running phase with dead PID sets waiting", async () => {
  const ticket = makeTicket({ phase: "intake", status: "running" });
  let written = { phase: "", status: "" };
  const writeTicketSpy = spy((_dir: string, t: TicketState) => {
    written = { phase: t.phase, status: t.status };
    return Promise.resolve();
  });
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      writeTicket: writeTicketSpy,
    }),
  );
  assertSpyCall(writeTicketSpy, 0);
  assertEquals(written.phase, "intake");
  assertEquals(written.status, "waiting");
});

Deno.test("advancePhase: implementation running with dead PID transitions to implementation/waiting", async () => {
  const ticket = makeTicket({
    phase: "implementation",
    status: "running",
    prs: [{ url: "u", title: "T", dependsOn: [], merged: false }],
  });
  let written = { phase: "", status: "" };
  const writeTicketSpy = spy((_dir: string, t: TicketState) => {
    written = { phase: t.phase, status: t.status };
    return Promise.resolve();
  });
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      writeTicket: writeTicketSpy,
    }),
  );
  assertSpyCall(writeTicketSpy, 0);
  assertEquals(written.phase, "implementation");
  assertEquals(written.status, "waiting");
});

Deno.test("advancePhase: running phase with live PID does nothing", async () => {
  const ticket = makeTicket({ phase: "intake", status: "running" });
  const writeTicketSpy = spy((_dir: string, _t: TicketState) =>
    Promise.resolve()
  );
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      isProcessAlive: () => true,
      writeTicket: writeTicketSpy,
    }),
  );
  assertSpyCalls(writeTicketSpy, 0);
});

Deno.test("advancePhase: waiting + approved advances to next phase", async () => {
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
    }),
  );
  assertSpyCall(spawnSpy, 0);
  assertEquals(spawnedPhase, "enrichment");
});

Deno.test("advancePhase: waiting + not approved does nothing", async () => {
  const ticket = makeTicket({
    phase: "intake",
    status: "waiting",
    approvals: [],
  });
  const spawnSpy = spy(() => Promise.resolve());
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      spawn: spawnSpy,
    }),
  );
  assertSpyCalls(spawnSpy, 0);
});

Deno.test(
  "advancePhase: implementation/waiting + approved with PRs advances to merge/waiting",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "waiting",
      approvals: [{ timestamp: "t", actor: "human", phase: "implementation" }],
      prs: [
        {
          url: "https://github.com/example/repo/pull/1",
          title: "PR",
          dependsOn: [],
          merged: false,
        },
      ],
    });
    let written = { phase: "", status: "" };
    const writeTicketSpy = spy((_dir: string, t: TicketState) => {
      written = { phase: t.phase, status: t.status };
      return Promise.resolve();
    });
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: writeTicketSpy,
        resolveModelConfig: () => ({
          model: "claude-sonnet-4-6",
          thinking: "off",
        }),
      }),
    );
    assertSpyCall(writeTicketSpy, 0);
    assertEquals(written.phase, "merge");
    assertEquals(written.status, "waiting");
  },
);

Deno.test(
  "advancePhase: implementation/needs-attention + approved does not advance to merge",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "needs-attention",
      approvals: [{ timestamp: "t", actor: "human", phase: "implementation" }],
    });
    const writeTicketSpy = spy((_dir: string, _t: TicketState) =>
      Promise.resolve()
    );
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: writeTicketSpy,
        resolveModelConfig: () => ({
          model: "claude-sonnet-4-6",
          thinking: "off",
        }),
      }),
    );
    assertSpyCalls(writeTicketSpy, 0);
  },
);

Deno.test("advancePhase: implementation phase receives ticket worktrees", async () => {
  const ticket = makeTicket({
    phase: "plan",
    status: "waiting",
    approvals: [{ timestamp: "t", actor: "human", phase: "plan" }],
    worktrees: {
      "jackjennings/lazyboy": { path: "/tmp/wt", branch: "gh-1" },
    },
  });
  let spawnedWorktrees: Record<string, unknown> = {};
  const spawnSpy = spy((opts: SpawnOpts) => {
    spawnedWorktrees = opts.worktrees;
    return Promise.resolve();
  });
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      spawn: spawnSpy,
    }),
  );
  assertSpyCall(spawnSpy, 0);
  assertEquals(spawnedWorktrees, {
    "jackjennings/lazyboy": { path: "/tmp/wt", branch: "gh-1" },
  });
});

Deno.test("advancePhase: non-implementation phases receive empty worktrees", async () => {
  const ticket = makeTicket({
    phase: "intake",
    status: "waiting",
    approvals: [{ timestamp: "t", actor: "human", phase: "intake" }],
    worktrees: {
      "jackjennings/lazyboy": { path: "/tmp/wt", branch: "gh-1" },
    },
  });
  let spawnedWorktrees: Record<string, unknown> = {};
  const spawnSpy = spy((opts: SpawnOpts) => {
    spawnedWorktrees = opts.worktrees;
    return Promise.resolve();
  });
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      spawn: spawnSpy,
    }),
  );
  assertSpyCall(spawnSpy, 0);
  assertEquals(spawnedWorktrees, {});
});

Deno.test("advancePhase: new ticket spawn receives empty worktrees", async () => {
  const ticket = makeTicket({
    phase: "intake",
    status: "new",
    worktrees: {
      "jackjennings/lazyboy": { path: "/tmp/wt", branch: "gh-1" },
    },
  });
  let spawnedWorktrees: Record<string, unknown> = {};
  const spawnSpy = spy((opts: SpawnOpts) => {
    spawnedWorktrees = opts.worktrees;
    return Promise.resolve();
  });
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      spawn: spawnSpy,
    }),
  );
  assertSpyCall(spawnSpy, 0);
  assertEquals(spawnedWorktrees, {});
});

Deno.test("advancePhase: implementation phase with empty worktrees transitions to needs-attention", async () => {
  const ticket = makeTicket({
    phase: "plan",
    status: "waiting",
    approvals: [{ timestamp: "t", actor: "human", phase: "plan" }],
    worktrees: {},
  });
  let written = { phase: "", status: "" };
  const writeTicketSpy = spy((_dir: string, t: TicketState) => {
    written = { phase: t.phase, status: t.status };
    return Promise.resolve();
  });
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      writeTicket: writeTicketSpy,
    }),
  );
  assertSpyCall(writeTicketSpy, 0);
  assertEquals(written.phase, "implementation");
  assertEquals(written.status, "needs-attention");
});

Deno.test("advancePhase: new ticket logs status-only transition", async () => {
  const ticket = makeTicket({ phase: "intake", status: "new" });
  const appendLogSpy = spy(
    (_dir: string, _id: string, _entry: object) => Promise.resolve(),
  );
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      appendLog: appendLogSpy,
    }),
  );
  assertSpyCall(appendLogSpy, 0);
  assertSpyCalls(appendLogSpy, 1);
  assertEquals(appendLogSpy.calls[0].args[2], {
    event: "status-transition",
    phase: "intake",
    from: "new",
    to: "running",
  });
});

Deno.test("advancePhase: dead PID on non-impl phase logs status-only transition", async () => {
  const ticket = makeTicket({ phase: "enrichment", status: "running" });
  const appendLogSpy = spy(
    (_dir: string, _id: string, _entry: object) => Promise.resolve(),
  );
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      appendLog: appendLogSpy,
      resolveModelConfig: () => ({ model: "m", thinking: "off" }),
    }),
  );
  assertSpyCall(appendLogSpy, 0);
  assertEquals(appendLogSpy.calls[0].args[2], {
    event: "status-transition",
    phase: "enrichment",
    from: "running",
    to: "waiting",
  });
});

Deno.test("advancePhase: dead PID on implementation logs status-transition to waiting", async () => {
  const ticket = makeTicket({
    phase: "implementation",
    status: "running",
    prs: [{ url: "u", title: "T", dependsOn: [], merged: false }],
  });
  const logEntries: object[] = [];
  const appendLogSpy = spy(
    (_dir: string, _id: string, entry: object) => {
      logEntries.push(entry);
      return Promise.resolve();
    },
  );
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      appendLog: appendLogSpy,
      resolveModelConfig: () => ({ model: "m", thinking: "off" }),
    }),
  );
  assertSpyCalls(appendLogSpy, 2);
  assertEquals(logEntries[0], {
    event: "status-transition",
    phase: "implementation",
    from: "running",
    to: "waiting",
  });
  assertEquals(logEntries[1], {
    event: "error",
    context: "spawnOutlierAnalysis",
    message: "no jackjennings/lazyboy worktree",
  });
});

Deno.test("advancePhase: live PID does not log", async () => {
  const ticket = makeTicket({ phase: "intake", status: "running" });
  const appendLogSpy = spy(
    (_dir: string, _id: string, _entry: object) => Promise.resolve(),
  );
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      isProcessAlive: () => true,
      appendLog: appendLogSpy,
      resolveModelConfig: () => ({ model: "m", thinking: "off" }),
    }),
  );
  assertSpyCalls(appendLogSpy, 0);
});

Deno.test("advancePhase: implementation/waiting approved logs implementation → merge", async () => {
  const ticket = makeTicket({
    phase: "implementation",
    status: "waiting",
    approvals: [{ timestamp: "t", actor: "human", phase: "implementation" }],
  });
  const logEntries: object[] = [];
  const appendLogSpy = spy(
    (_dir: string, _id: string, entry: object) => {
      logEntries.push(entry);
      return Promise.resolve();
    },
  );
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      appendLog: appendLogSpy,
      resolveModelConfig: () => ({ model: "m", thinking: "off" }),
    }),
  );
  assertSpyCalls(appendLogSpy, 1);
  assertEquals(logEntries[0], {
    event: "phase-transition",
    from: "implementation",
    to: "merge",
  });
});

Deno.test(
  "advancePhase: implementation/waiting+approved with unmerged PRs calls markPRsReady with those URLs",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "waiting",
      approvals: [{ timestamp: "t", actor: "human", phase: "implementation" }],
      prs: [
        {
          url: "https://github.com/o/r/pull/1",
          title: "T1",
          dependsOn: [],
          merged: false,
        },
        {
          url: "https://github.com/o/r/pull/2",
          title: "T2",
          dependsOn: [],
          merged: true,
        },
      ],
    });
    const markPRsReadySpy = spy((_urls: string[]) => Promise.resolve());
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        markPRsReady: markPRsReadySpy,
      }),
    );
    assertSpyCall(markPRsReadySpy, 0, {
      args: [["https://github.com/o/r/pull/1"]],
    });
  },
);

Deno.test(
  "advancePhase: implementation/waiting+approved with no prs field does not call markPRsReady",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "waiting",
      approvals: [{ timestamp: "t", actor: "human", phase: "implementation" }],
    });
    const markPRsReadySpy = spy((_urls: string[]) => Promise.resolve());
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        markPRsReady: markPRsReadySpy,
      }),
    );
    assertSpyCalls(markPRsReadySpy, 0);
  },
);

Deno.test(
  "advancePhase: implementation/waiting+approved with empty prs array does not call markPRsReady",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "waiting",
      approvals: [{ timestamp: "t", actor: "human", phase: "implementation" }],
      prs: [],
    });
    const markPRsReadySpy = spy((_urls: string[]) => Promise.resolve());
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        markPRsReady: markPRsReadySpy,
      }),
    );
    assertSpyCalls(markPRsReadySpy, 0);
  },
);

Deno.test(
  "advancePhase: implementation/waiting+approved with all PRs merged does not call markPRsReady",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "waiting",
      approvals: [{ timestamp: "t", actor: "human", phase: "implementation" }],
      prs: [
        {
          url: "https://github.com/o/r/pull/1",
          title: "T1",
          dependsOn: [],
          merged: true,
        },
      ],
    });
    const markPRsReadySpy = spy((_urls: string[]) => Promise.resolve());
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        markPRsReady: markPRsReadySpy,
      }),
    );
    assertSpyCalls(markPRsReadySpy, 0);
  },
);

Deno.test(
  "advancePhase: implementation/waiting+approved markPRsReady failure logs error and still transitions to merge/waiting",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "waiting",
      approvals: [{ timestamp: "t", actor: "human", phase: "implementation" }],
      prs: [
        {
          url: "https://github.com/o/r/pull/1",
          title: "T1",
          dependsOn: [],
          merged: false,
        },
      ],
    });
    const writtenTickets: TicketState[] = [];
    const writeTicketSpy = spy((_dir: string, t: TicketState) => {
      writtenTickets.push(t);
      return Promise.resolve();
    });
    const logEntries2: object[] = [];
    const appendLogSpy2 = spy(
      (_dir: string, _id: string, entry: object) => {
        logEntries2.push(entry);
        return Promise.resolve();
      },
    );
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: writeTicketSpy,
        appendLog: appendLogSpy2,
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        markPRsReady: () => Promise.reject(new Error("API error")),
      }),
    );
    assertSpyCall(writeTicketSpy, 0);
    assertEquals(writtenTickets[0].phase, "merge");
    assertEquals(writtenTickets[0].status, "waiting");
    assert(
      logEntries2.some(
        (e) =>
          (e as Record<string, unknown>).event === "error" &&
          (e as Record<string, unknown>).context === "markPRsReady",
      ),
    );
  },
);

Deno.test("advancePhase: approved waiting phase logs transition to next phase", async () => {
  const ticket = makeTicket({
    phase: "intake",
    status: "waiting",
    approvals: [{ timestamp: "t", actor: "human", phase: "intake" }],
  });
  const logEntries: object[] = [];
  const appendLogSpy = spy(
    (_dir: string, _id: string, entry: object) => {
      logEntries.push(entry);
      return Promise.resolve();
    },
  );
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      appendLog: appendLogSpy,
      resolveModelConfig: () => ({ model: "m", thinking: "off" }),
    }),
  );
  assertSpyCalls(appendLogSpy, 1);
  assertEquals(logEntries[0], {
    event: "phase-transition",
    from: "intake",
    to: "enrichment",
  });
});

Deno.test("advancePhase: no worktrees logs plan → needs-attention", async () => {
  const ticket = makeTicket({
    phase: "plan",
    status: "waiting",
    approvals: [{ timestamp: "t", actor: "human", phase: "plan" }],
    worktrees: {},
  });
  const logEntries: object[] = [];
  const appendLogSpy = spy(
    (_dir: string, _id: string, entry: object) => {
      logEntries.push(entry);
      return Promise.resolve();
    },
  );
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      appendLog: appendLogSpy,
      resolveModelConfig: () => ({ model: "m", thinking: "off" }),
    }),
  );
  assertSpyCalls(appendLogSpy, 1);
  assertEquals(logEntries[0], {
    event: "phase-transition",
    from: "plan",
    to: "needs-attention",
    reason: "no-worktrees",
  });
});

Deno.test("advancePhase: log entry does not include ts (appended by appendTicketLog)", async () => {
  const ticket = makeTicket({ phase: "intake", status: "new" });
  const logEntries: object[] = [];
  const appendLogSpy = spy(
    (_dir: string, _id: string, entry: object) => {
      logEntries.push(entry);
      return Promise.resolve();
    },
  );
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      appendLog: appendLogSpy,
      resolveModelConfig: () => ({ model: "m", thinking: "off" }),
    }),
  );
  assertSpyCalls(appendLogSpy, 1);
  assertFalse("ts" in logEntries[0]);
});

Deno.test("advancePhase: revising status spawns plan with timestamped outputFile", async () => {
  const ticket = makeTicket({ phase: "plan", status: "revising" });
  let spawnedOutputFile = "";
  const spawnSpy = spy((opts: SpawnOpts) => {
    spawnedOutputFile = opts.outputFile;
    return Promise.resolve();
  });
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      spawn: spawnSpy,
      resolveModelConfig: () => ({ model: "m", thinking: "off" }),
    }),
  );
  assertSpyCall(spawnSpy, 0);
  assert(/^\d{8}T\d{6}-plan\.md$/.test(spawnedOutputFile));
});

Deno.test("advancePhase: revising status transitions to running", async () => {
  const ticket = makeTicket({
    phase: "plan",
    status: "revising",
  });
  const writtenTickets: TicketState[] = [];
  const writeTicketSpy = spy((_dir: string, t: TicketState) => {
    writtenTickets.push(t);
    return Promise.resolve();
  });
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      writeTicket: writeTicketSpy,
      resolveModelConfig: () => ({ model: "m", thinking: "off" }),
    }),
  );
  assertSpyCall(writeTicketSpy, 0);
  assertEquals(writtenTickets[0].status, "running");
});

Deno.test("advancePhase: revising status logs status-transition from revising to running", async () => {
  const ticket = makeTicket({ phase: "plan", status: "revising" });
  const logEntries: object[] = [];
  const appendLogSpy = spy(
    (_dir: string, _id: string, entry: object) => {
      logEntries.push(entry);
      return Promise.resolve();
    },
  );
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      appendLog: appendLogSpy,
      resolveModelConfig: () => ({ model: "m", thinking: "off" }),
    }),
  );
  assertSpyCalls(appendLogSpy, 1);
  assertEquals(logEntries[0], {
    event: "status-transition",
    phase: "plan",
    from: "revising",
    to: "running",
  });
});

Deno.test("advancePhase: revising outputFile uses YYYYMMDDTHHMMSS prefix format", async () => {
  const ticket = makeTicket({ phase: "plan", status: "revising" });
  let spawnedOutputFile: string | undefined;
  const spawnSpy = spy((opts: SpawnOpts) => {
    spawnedOutputFile = opts.outputFile;
    return Promise.resolve();
  });
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      spawn: spawnSpy,
      resolveModelConfig: () => ({ model: "m", thinking: "off" }),
    }),
  );
  assertSpyCall(spawnSpy, 0);
  assert(/^\d{8}T\d{6}-plan\.md$/.test(spawnedOutputFile ?? ""));
});

Deno.test("advancePhase: new status spawn receives timestamp-prefixed intake output filename", async () => {
  const ticket = makeTicket({ phase: "intake", status: "new" });
  let spawnedOutputFile = "";
  const spawnSpy = spy((opts: SpawnOpts) => {
    spawnedOutputFile = opts.outputFile;
    return Promise.resolve();
  });
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      spawn: spawnSpy,
      resolveModelConfig: () => ({ model: "m", thinking: "off" }),
    }),
  );
  assertSpyCall(spawnSpy, 0);
  assert(/^\d{8}T\d{6}-intake\.md$/.test(spawnedOutputFile));
});

Deno.test("advancePhase: waiting+approved spawn receives timestamp-prefixed next-phase output filename", async () => {
  const ticket = makeTicket({
    phase: "intake",
    status: "waiting",
    approvals: [{ timestamp: "t", actor: "human", phase: "intake" }],
  });
  let spawnedOutputFile = "";
  const spawnSpy = spy((opts: SpawnOpts) => {
    spawnedOutputFile = opts.outputFile;
    return Promise.resolve();
  });
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      spawn: spawnSpy,
      resolveModelConfig: () => ({ model: "m", thinking: "off" }),
    }),
  );
  assertSpyCall(spawnSpy, 0);
  assert(/^\d{8}T\d{6}-enrichment\.md$/.test(spawnedOutputFile ?? ""));
});

Deno.test(
  "advancePhase: running phase with dead PID and missing output transitions to needs-attention",
  async () => {
    const ticket = makeTicket({ phase: "spec", status: "running" });
    const writtenTickets: TicketState[] = [];
    const logs: object[] = [];
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: (_dir, t) => {
          writtenTickets.push(t);
          return Promise.resolve();
        },
        appendLog: (_dir, _id, entry) => {
          logs.push(entry);
          return Promise.resolve();
        },
        resolveModelConfig: () => ({
          model: "claude-sonnet-4-6",
          thinking: "off",
        }),
        readPhaseOutput: () => Promise.resolve(null),
      }),
    );
    const final = writtenTickets[writtenTickets.length - 1];
    assertEquals(final.status, "needs-attention");
    const invalidLog = logs.find(
      (e) => (e as Record<string, unknown>).event === "phase-output-invalid",
    );
    assertEquals((invalidLog as Record<string, unknown>).reason, "missing");
  },
);

Deno.test(
  "advancePhase: valid output with outputRetries clears it on waiting ticket",
  async () => {
    const ticket = makeTicket({
      phase: "spec",
      status: "running",
      outputRetries: 1,
    });
    const writtenTickets: TicketState[] = [];
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: (_dir, t) => {
          writtenTickets.push(t);
          return Promise.resolve();
        },
        resolveModelConfig: () => ({
          model: "claude-sonnet-4-6",
          thinking: "off",
        }),
        readPhaseOutput: () => Promise.resolve("## What to Build\n\ncontent"),
      }),
    );
    const waitingWrite = writtenTickets.find((t) => t.status === "waiting");
    assertEquals(waitingWrite?.outputRetries, undefined);
  },
);

Deno.test(
  "advancePhase: running phase with dead PID and empty output transitions to needs-attention",
  async () => {
    const ticket = makeTicket({ phase: "spec", status: "running" });
    const writtenTickets: TicketState[] = [];
    const logs: object[] = [];
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: (_dir, t) => {
          writtenTickets.push(t);
          return Promise.resolve();
        },
        appendLog: (_dir, _id, entry) => {
          logs.push(entry);
          return Promise.resolve();
        },
        resolveModelConfig: () => ({
          model: "claude-sonnet-4-6",
          thinking: "off",
        }),
        readPhaseOutput: () => Promise.resolve("   \n  "),
      }),
    );
    const final = writtenTickets[writtenTickets.length - 1];
    assertEquals(final.status, "needs-attention");
    const invalidLog = logs.find(
      (e) => (e as Record<string, unknown>).event === "phase-output-invalid",
    );
    assertEquals((invalidLog as Record<string, unknown>).reason, "empty");
  },
);

Deno.test(
  "advancePhase: running phase with dead PID and valid output does not transition to needs-attention",
  async () => {
    const ticket = makeTicket({ phase: "spec", status: "running" });
    const writtenTickets: TicketState[] = [];
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: (_dir, t) => {
          writtenTickets.push(t);
          return Promise.resolve();
        },
        resolveModelConfig: () => ({
          model: "claude-sonnet-4-6",
          thinking: "off",
        }),
        readPhaseOutput: () => Promise.resolve("## What to Build\n\ncontent"),
      }),
    );
    const final = writtenTickets[writtenTickets.length - 1];
    assertEquals(final.status, "waiting");
  },
);

Deno.test(
  "advancePhase: calls appendPrinciples when output has ## Principles",
  async () => {
    const ticket = makeTicket({ phase: "intake", status: "running" });
    const appendPrinciplesSpy = spy(() => Promise.resolve());
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        ...makeTickDeps(),
        readPhaseOutput: () => Promise.resolve("## Principles\n\nlearn X"),
        appendPrinciples: appendPrinciplesSpy,
      }),
    );
    assertSpyCalls(appendPrinciplesSpy, 1);
  },
);

Deno.test(
  "advancePhase: does not call appendPrinciples when output has no ## Principles",
  async () => {
    const ticket = makeTicket({ phase: "intake", status: "running" });
    const appendPrinciplesSpy = spy(() => Promise.resolve());
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        ...makeTickDeps(),
        readPhaseOutput: () => Promise.resolve("## What to Build\n\nstuff"),
        appendPrinciples: appendPrinciplesSpy,
      }),
    );
    assertSpyCalls(appendPrinciplesSpy, 0);
  },
);

Deno.test(
  "advancePhase: does not call appendPrinciples when readPhaseOutput returns null",
  async () => {
    const ticket = makeTicket({ phase: "intake", status: "running" });
    const appendPrinciplesSpy = spy(() => Promise.resolve());
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        ...makeTickDeps(),
        readPhaseOutput: () => Promise.resolve(null),
        appendPrinciples: appendPrinciplesSpy,
      }),
    );
    assertSpyCalls(appendPrinciplesSpy, 0);
  },
);

Deno.test(
  "advancePhase: null readPhaseExitCode → needs-attention with reason incomplete",
  async () => {
    const ticket = makeTicket({ phase: "spec", status: "running" });
    const writtenTickets: TicketState[] = [];
    const logs: object[] = [];
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: (_dir, t) => {
          writtenTickets.push(t);
          return Promise.resolve();
        },
        appendLog: (_dir, _id, entry) => {
          logs.push(entry);
          return Promise.resolve();
        },
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        readPhaseOutput: () => Promise.resolve("some content"),
        readPhaseExitCode: () => Promise.resolve(null),
      }),
    );
    const final = writtenTickets[writtenTickets.length - 1];
    assertEquals(final.status, "needs-attention");
    const invalidLog = logs.find(
      (e) => (e as Record<string, unknown>).event === "phase-output-invalid",
    );
    assertEquals((invalidLog as Record<string, unknown>).reason, "incomplete");
  },
);

Deno.test(
  "advancePhase: running→waiting stores session ID from sidecar in phaseSessionIds",
  async () => {
    const ticket = makeTicket({ phase: "spec", status: "running" });
    const writtenTickets: TicketState[] = [];
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: (_dir, t) => {
          writtenTickets.push(t);
          return Promise.resolve();
        },
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        readPhaseOutput: () => Promise.resolve("## What to Build\n\ncontent"),
        readPhaseSessionId: (_dir, _phase) => Promise.resolve("sess-xyz"),
      }),
    );
    const waitingWrite = writtenTickets.find((t) => t.status === "waiting");
    assertEquals(waitingWrite?.phaseSessionIds?.["spec"], "sess-xyz");
  },
);

Deno.test(
  "advancePhase: implementation revision passes phaseSessionIds.implementation as sessionId to spawn",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "revising",
      worktrees: { "jackjennings/lazyboy": { path: "/wt", branch: "b" } },
      phaseSessionIds: { implementation: "sess-impl" },
    });
    let spawnedSessionId: string | undefined;
    const spawnSpy = spy((opts: SpawnOpts) => {
      spawnedSessionId = opts.sessionId;
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
    assertEquals(spawnedSessionId, "sess-impl");
  },
);

Deno.test(
  "advancePhase: implementation revision resumes the recorded session",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "revising",
      worktrees: { "jackjennings/lazyboy": { path: "/wt", branch: "b" } },
      phaseSessionIds: { implementation: "sess-impl" },
    });
    let spawnedResume: boolean | undefined;
    const spawnSpy = spy((opts: SpawnOpts) => {
      spawnedResume = opts.resume;
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
    assert(spawnedResume);
  },
);

Deno.test(
  "advancePhase: revision without a recorded session does not resume",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "revising",
      worktrees: { "jackjennings/lazyboy": { path: "/wt", branch: "b" } },
    });
    let spawnedResume: boolean | undefined = true;
    const spawnSpy = spy((opts: SpawnOpts) => {
      spawnedResume = opts.resume;
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
    assertFalse(spawnedResume);
  },
);

Deno.test(
  "advancePhase: implementation revision with no phaseSessionIds spawns without sessionId",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "revising",
      worktrees: { "jackjennings/lazyboy": { path: "/wt", branch: "b" } },
    });
    let spawnedSessionId: string | undefined = "sentinel";
    const spawnSpy = spy((opts: SpawnOpts) => {
      spawnedSessionId = opts.sessionId;
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
    assertEquals(spawnedSessionId, undefined);
  },
);

Deno.test(
  "advancePhase: non-implementation revision spawns without sessionId regardless of phaseSessionIds",
  async () => {
    const ticket = makeTicket({
      phase: "spec",
      status: "revising",
      phaseSessionIds: { implementation: "sess-impl" },
    });
    let spawnedSessionId: string | undefined = "sentinel";
    const spawnSpy = spy((opts: SpawnOpts) => {
      spawnedSessionId = opts.sessionId;
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
    assertEquals(spawnedSessionId, undefined);
  },
);

Deno.test(
  "advancePhase: merge revision passes phaseSessionIds.implementation as sessionId to spawn",
  async () => {
    const ticket = makeTicket({
      phase: "merge",
      status: "revising",
      worktrees: { "jackjennings/lazyboy": { path: "/wt", branch: "b" } },
      phaseSessionIds: { implementation: "sess-merge-impl" },
    });
    let spawnedSessionId: string | undefined;
    const spawnSpy = spy((opts: SpawnOpts) => {
      spawnedSessionId = opts.sessionId;
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
    assertEquals(spawnedSessionId, "sess-merge-impl");
  },
);

Deno.test(
  "advancePhase: merge revision with no phaseSessionIds spawns without sessionId",
  async () => {
    const ticket = makeTicket({
      phase: "merge",
      status: "revising",
      worktrees: { "jackjennings/lazyboy": { path: "/wt", branch: "b" } },
    });
    let spawnedSessionId: string | undefined = "sentinel";
    const spawnSpy = spy((opts: SpawnOpts) => {
      spawnedSessionId = opts.sessionId;
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
    assertEquals(spawnedSessionId, undefined);
  },
);

Deno.test(
  "advancePhase: missing output with phaseSessionIds spawns recovery and stays running",
  async () => {
    const ticket = makeTicket({
      phase: "spec",
      status: "running",
      phaseSessionIds: { spec: "sess-recover" },
    });
    const writtenTickets: TicketState[] = [];
    const logs: object[] = [];
    let spawnedSessionId: string | undefined;
    let spawnedScope: string[] | undefined;
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        spawn: (opts) => {
          spawnedSessionId = opts.sessionId;
          spawnedScope = opts.scope;
          return Promise.resolve();
        },
        writeTicket: (_dir, t) => {
          writtenTickets.push(t);
          return Promise.resolve();
        },
        appendLog: (_dir, _id, entry) => {
          logs.push(entry);
          return Promise.resolve();
        },
        resolveModelConfig: () => ({
          model: "claude-sonnet-4-6",
          thinking: "off",
        }),
        readPhaseOutput: () => Promise.resolve(null),
        readPhaseSessionId: (_dir, _phase) => Promise.resolve("sess-recover"),
      }),
    );
    const final = writtenTickets[writtenTickets.length - 1];
    assertEquals(final.status, "running");
    assertEquals(final.outputRetries, 1);
    assertEquals(spawnedSessionId, "sess-recover");
    assertEquals(spawnedScope, []);
    const retryLog = logs.find(
      (e) => (e as Record<string, unknown>).event === "phase-output-retry",
    );
    assertEquals((retryLog as Record<string, unknown>).phase, "spec");
    assertEquals((retryLog as Record<string, unknown>).attempt, 1);
  },
);

Deno.test(
  "advancePhase: revising→running clears notifiedNeedsAttention",
  async () => {
    const ticket = makeTicket({
      phase: "spec",
      status: "revising",
      notifiedNeedsAttention: true,
    });
    const writtenTickets: TicketState[] = [];
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: (_dir, t) => {
          writtenTickets.push(t);
          return Promise.resolve();
        },
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
      }),
    );
    const runningWrite = writtenTickets.find((t) => t.status === "running");
    assertEquals(runningWrite?.notifiedNeedsAttention, false);
  },
);

Deno.test(
  "advancePhase: non-zero exit code with no implementation session transitions to needs-attention",
  async () => {
    const ticket = makeTicket({ phase: "intake", status: "running" });
    const writtenTickets: TicketState[] = [];
    const logs: object[] = [];
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: (_dir, t) => {
          writtenTickets.push(t);
          return Promise.resolve();
        },
        appendLog: (_dir, _id, entry) => {
          logs.push(entry);
          return Promise.resolve();
        },
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        readPhaseOutput: () => Promise.resolve("some content"),
        readPhaseExitCode: () => Promise.resolve(1),
      }),
    );
    const final = writtenTickets[writtenTickets.length - 1];
    assertEquals(final.status, "needs-attention");
    assertEquals(
      logs.some(
        (e) =>
          (e as Record<string, unknown>).event === "phase-output-invalid" &&
          (e as Record<string, unknown>).reason === "non-zero-exit",
      ),
      true,
    );
  },
);

Deno.test(
  "advancePhase: non-zero exit with stale implementation session transitions to revising with resumeRetries",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "running",
      phaseSessionIds: { implementation: "old-sess-123" },
    });
    const writtenTickets: TicketState[] = [];
    const logs: object[] = [];
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: (_dir, t) => {
          writtenTickets.push(t);
          return Promise.resolve();
        },
        appendLog: (_dir, _id, entry) => {
          logs.push(entry);
          return Promise.resolve();
        },
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        readPhaseExitCode: () => Promise.resolve(1),
        readPhaseSessionId: () => Promise.resolve(null),
      }),
    );
    const final = writtenTickets[writtenTickets.length - 1];
    assertEquals(final.status, "revising");
    assertEquals(final.resumeRetries, 1);
    assertEquals(final.phaseSessionIds?.["implementation"], undefined);
    const retryLog = logs.find(
      (e) => (e as Record<string, unknown>).event === "resume-retry",
    );
    assert(retryLog !== undefined);
    assertEquals(
      (retryLog as Record<string, unknown>).staleSessionId,
      "old-sess-123",
    );
    assertEquals(
      (retryLog as Record<string, unknown>).phase,
      "implementation",
    );
  },
);

Deno.test(
  "advancePhase: non-zero exit on merge phase with stale implementation session transitions to revising",
  async () => {
    const ticket = makeTicket({
      phase: "merge",
      status: "running",
      phaseSessionIds: { implementation: "old-sess-merge" },
    });
    const writtenTickets: TicketState[] = [];
    const logs: object[] = [];
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: (_dir, t) => {
          writtenTickets.push(t);
          return Promise.resolve();
        },
        appendLog: (_dir, _id, entry) => {
          logs.push(entry);
          return Promise.resolve();
        },
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        readPhaseExitCode: () => Promise.resolve(1),
        readPhaseSessionId: () => Promise.resolve(null),
      }),
    );
    const final = writtenTickets[writtenTickets.length - 1];
    assertEquals(final.status, "revising");
    assertEquals(final.resumeRetries, 1);
    assertEquals(final.phaseSessionIds?.["implementation"], undefined);
    assert(
      logs.some(
        (e) => (e as Record<string, unknown>).event === "resume-retry",
      ),
    );
  },
);

Deno.test(
  "advancePhase: non-zero exit with resumeRetries already set parks to needs-attention",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "running",
      phaseSessionIds: { implementation: "old-sess-123" },
      resumeRetries: 1,
    });
    const writtenTickets: TicketState[] = [];
    const logs: object[] = [];
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: (_dir, t) => {
          writtenTickets.push(t);
          return Promise.resolve();
        },
        appendLog: (_dir, _id, entry) => {
          logs.push(entry);
          return Promise.resolve();
        },
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        readPhaseExitCode: () => Promise.resolve(1),
        readPhaseSessionId: () => Promise.resolve(null),
      }),
    );
    const final = writtenTickets[writtenTickets.length - 1];
    assertEquals(final.status, "needs-attention");
    assert(
      logs.some(
        (e) =>
          (e as Record<string, unknown>).event === "phase-output-invalid" &&
          (e as Record<string, unknown>).reason === "non-zero-exit",
      ),
    );
  },
);

Deno.test(
  "advancePhase: non-zero exit on implementation with no phaseSessionIds parks to needs-attention",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "running",
    });
    const writtenTickets: TicketState[] = [];
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: (_dir, t) => {
          writtenTickets.push(t);
          return Promise.resolve();
        },
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        readPhaseExitCode: () => Promise.resolve(1),
        readPhaseSessionId: () => Promise.resolve(null),
      }),
    );
    assertEquals(
      writtenTickets[writtenTickets.length - 1].status,
      "needs-attention",
    );
  },
);

Deno.test(
  "advancePhase: implementation approved advancing to merge clears resumeRetries",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "waiting",
      approvals: [{ timestamp: "t", actor: "human", phase: "implementation" }],
      resumeRetries: 1,
    });
    const writtenTickets: TicketState[] = [];
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: (_dir, t) => {
          writtenTickets.push(t);
          return Promise.resolve();
        },
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
      }),
    );
    const mergeWrite = writtenTickets.find((t) => t.phase === "merge");
    assert(mergeWrite !== undefined);
    assertEquals(mergeWrite.resumeRetries, undefined);
  },
);

Deno.test(
  "advancePhase: zero exit code falls through to existing output checks",
  async () => {
    const ticket = makeTicket({ phase: "intake", status: "running" });
    const writtenTickets: TicketState[] = [];
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: (_dir, t) => {
          writtenTickets.push(t);
          return Promise.resolve();
        },
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        readPhaseOutput: () => Promise.resolve("good content"),
      }),
    );
    assertEquals(writtenTickets[writtenTickets.length - 1].status, "waiting");
  },
);

Deno.test(
  "advancePhase: empty output with exit code 0 goes to needs-attention with reason empty",
  async () => {
    const ticket = makeTicket({ phase: "intake", status: "running" });
    const writtenTickets: TicketState[] = [];
    const logs: object[] = [];
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: (_dir, t) => {
          writtenTickets.push(t);
          return Promise.resolve();
        },
        appendLog: (_dir, _id, entry) => {
          logs.push(entry);
          return Promise.resolve();
        },
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        readPhaseOutput: () => Promise.resolve(""),
      }),
    );
    assertEquals(
      writtenTickets[writtenTickets.length - 1].status,
      "needs-attention",
    );
    assertEquals(
      logs.some(
        (e) =>
          (e as Record<string, unknown>).event === "phase-output-invalid" &&
          (e as Record<string, unknown>).reason === "empty",
      ),
      true,
    );
  },
);

Deno.test(
  "advancePhase: feedback immediately preceding output suppresses self-review",
  async () => {
    const stateDir = Deno.makeTempDirSync();
    try {
      const ticket = makeTicket({ phase: "spec", status: "running" });
      const ticketDir = join(stateDir, ticket.id);
      await Deno.mkdir(ticketDir, { recursive: true });
      await Deno.writeTextFile(
        join(ticketDir, "20260101T100000-spec-feedback.md"),
        "feedback",
      );
      await Deno.writeTextFile(
        join(ticketDir, "20260101T100001-spec.md"),
        "content",
      );
      const selfReviewSpy = spy(() =>
        Promise.resolve({ approved: false, reason: null })
      );
      await advancePhase(
        ticket,
        stateDir,
        makeTickDeps({
          ...makeTickDeps(),
          selfReview: selfReviewSpy,
        }),
      );
      assertSpyCalls(selfReviewSpy, 0);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "advancePhase: no feedback before output calls self-review normally",
  async () => {
    const stateDir = Deno.makeTempDirSync();
    try {
      const ticket = makeTicket({ phase: "spec", status: "running" });
      const ticketDir = join(stateDir, ticket.id);
      await Deno.mkdir(ticketDir, { recursive: true });
      await Deno.writeTextFile(
        join(ticketDir, "20260101T100001-spec.md"),
        "content",
      );
      const selfReviewSpy = spy(() =>
        Promise.resolve({ approved: false, reason: null })
      );
      await advancePhase(
        ticket,
        stateDir,
        makeTickDeps({
          ...makeTickDeps(),
          selfReview: selfReviewSpy,
        }),
      );
      assertSpyCalls(selfReviewSpy, 1);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "advancePhase: feedback not immediately preceding output calls self-review normally",
  async () => {
    const stateDir = Deno.makeTempDirSync();
    try {
      const ticket = makeTicket({ phase: "spec", status: "running" });
      const ticketDir = join(stateDir, ticket.id);
      await Deno.mkdir(ticketDir, { recursive: true });
      await Deno.writeTextFile(
        join(ticketDir, "20260101T100000-spec-feedback.md"),
        "feedback",
      );
      await Deno.writeTextFile(
        join(ticketDir, "20260101T100001-spec.md"),
        "first output",
      );
      await Deno.writeTextFile(
        join(ticketDir, "20260101T100002-spec.md"),
        "second output",
      );
      const selfReviewSpy = spy(() =>
        Promise.resolve({ approved: false, reason: null })
      );
      await advancePhase(
        ticket,
        stateDir,
        makeTickDeps({
          ...makeTickDeps(),
          selfReview: selfReviewSpy,
          readPhaseOutput: () => Promise.resolve("second output"),
        }),
      );
      assertSpyCalls(selfReviewSpy, 1);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "advancePhase: plan phase with non-empty newRepos skips self-review",
  async () => {
    const stateDir = Deno.makeTempDirSync();
    try {
      const ticket = makeTicket({
        phase: "plan",
        status: "running",
        newRepos: ["myorg/new-repo"],
      });
      const ticketDir = join(stateDir, ticket.id);
      await Deno.mkdir(ticketDir, { recursive: true });
      await Deno.writeTextFile(
        join(ticketDir, "20260101T100001-plan.md"),
        "content",
      );
      const selfReviewSpy = spy(() =>
        Promise.resolve({ approved: false, reason: null })
      );
      await advancePhase(
        ticket,
        stateDir,
        makeTickDeps({
          ...makeTickDeps(),
          selfReview: selfReviewSpy,
        }),
      );
      assertSpyCalls(selfReviewSpy, 0);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "advancePhase: plan phase without newRepos calls self-review normally",
  async () => {
    const stateDir = Deno.makeTempDirSync();
    try {
      const ticket = makeTicket({ phase: "plan", status: "running" });
      const ticketDir = join(stateDir, ticket.id);
      await Deno.mkdir(ticketDir, { recursive: true });
      await Deno.writeTextFile(
        join(ticketDir, "20260101T100001-plan.md"),
        "content",
      );
      const selfReviewSpy = spy(() =>
        Promise.resolve({ approved: false, reason: null })
      );
      await advancePhase(
        ticket,
        stateDir,
        makeTickDeps({
          ...makeTickDeps(),
          selfReview: selfReviewSpy,
        }),
      );
      assertSpyCalls(selfReviewSpy, 1);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test("advancePhase: spawn receives model and thinking from resolveModelConfig", async () => {
  const ticket = makeTicket({ phase: "intake", status: "new" });
  let spawnedModel = "";
  let spawnedThinking = "";
  const spawnSpy = spy((opts: SpawnOpts) => {
    spawnedModel = opts.model;
    spawnedThinking = opts.thinking;
    return Promise.resolve();
  });
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      spawn: spawnSpy,
      resolveModelConfig: () => ({ model: "claude-opus-4-7", thinking: "max" }),
    }),
  );
  assertSpyCall(spawnSpy, 0);
  assertEquals(spawnedModel, "claude-opus-4-7");
  assertEquals(spawnedThinking, "max");
});

Deno.test("advancePhase: resolveModelConfig called with the phase being spawned", async () => {
  const ticket = makeTicket({
    phase: "intake",
    status: "waiting",
    approvals: [{ timestamp: "t", actor: "human", phase: "intake" }],
  });
  let resolvedPhase = "";
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      resolveModelConfig: (phase, _t) => {
        resolvedPhase = phase;
        return { model: "m", thinking: "off" };
      },
    }),
  );
  assertEquals(resolvedPhase, "enrichment");
});

Deno.test("advancePhase: implementation/revising spawns with ticket.worktrees", async () => {
  const ticket = makeTicket({
    phase: "implementation",
    status: "revising",
    worktrees: {
      "jackjennings/lazyboy": { path: "/tmp/wt", branch: "gh-99" },
    },
  });
  let spawnedWorktrees: Record<string, unknown> = {};
  const spawnSpy = spy((opts: SpawnOpts) => {
    spawnedWorktrees = opts.worktrees;
    return Promise.resolve();
  });
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      spawn: spawnSpy,
      writeTicket: async () => {},
      writePhaseOutput: async () => {},
      appendLog: async () => {},
      resolveModelConfig: () => ({ model: "m", thinking: "off" }),
    }),
  );
  assertSpyCall(spawnSpy, 0);
  assertEquals(spawnedWorktrees, {
    "jackjennings/lazyboy": { path: "/tmp/wt", branch: "gh-99" },
  });
});

Deno.test("advancePhase: non-implementation revising uses empty worktrees", async () => {
  const ticket = makeTicket({
    phase: "plan",
    status: "revising",
    worktrees: {
      "jackjennings/lazyboy": { path: "/tmp/wt", branch: "gh-99" },
    },
  });
  let spawnedWorktrees: Record<string, unknown> = {};
  const spawnSpy = spy((opts: SpawnOpts) => {
    spawnedWorktrees = opts.worktrees;
    return Promise.resolve();
  });
  await advancePhase(
    ticket,
    "/state",
    makeTickDeps({
      spawn: spawnSpy,
      writeTicket: async () => {},
      writePhaseOutput: async () => {},
      appendLog: async () => {},
      resolveModelConfig: () => ({ model: "m", thinking: "off" }),
    }),
  );
  assertSpyCall(spawnSpy, 0);
  assertEquals(spawnedWorktrees, {});
});

Deno.test(
  "advancePhase: running ticket with dead PID and selfReview true sets approved and logs self-approved",
  async () => {
    const ticket = makeTicket({ phase: "intake", status: "running" });
    const writtenTickets: TicketState[] = [];
    const writeTicketSpy = spy((_dir: string, t: TicketState) => {
      writtenTickets.push(t);
      return Promise.resolve();
    });
    const logEntries: object[] = [];
    const appendLogSpy = spy(
      (_dir: string, _id: string, entry: object) => {
        logEntries.push(entry);
        return Promise.resolve();
      },
    );
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: writeTicketSpy,
        appendLog: appendLogSpy,
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        selfReview: () => Promise.resolve({ approved: true, reason: null }),
      }),
    );
    assertSpyCalls(writeTicketSpy, 2);
    assertEquals(writtenTickets[0].status, "waiting");
    assertEquals(writtenTickets[0].approvals, []);
    assertEquals(writtenTickets[1].status, "waiting");
    assertEquals(writtenTickets[1].approvals.length, 1);
    assertEquals(writtenTickets[1].approvals[0].actor, "agent");
    assertEquals(writtenTickets[1].approvals[0].phase, "intake");
    assertEquals(logEntries.length, 2);
    assertEquals(logEntries[0], {
      event: "status-transition",
      phase: "intake",
      from: "running",
      to: "waiting",
    });
    assertEquals(logEntries[1], { event: "self-approved", phase: "intake" });
  },
);

Deno.test(
  "advancePhase: running ticket with dead PID and selfReview false leaves approved false",
  async () => {
    const ticket = makeTicket({ phase: "intake", status: "running" });
    const writtenTickets: TicketState[] = [];
    const writeTicketSpy = spy((_dir: string, t: TicketState) => {
      writtenTickets.push(t);
      return Promise.resolve();
    });
    const logEntries: object[] = [];
    const appendLogSpy = spy(
      (_dir: string, _id: string, entry: object) => {
        logEntries.push(entry);
        return Promise.resolve();
      },
    );
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: writeTicketSpy,
        appendLog: appendLogSpy,
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
      }),
    );
    assertSpyCalls(writeTicketSpy, 1);
    assertEquals(writtenTickets[0].approvals, []);
    assertEquals(logEntries.length, 1);
    assertEquals(logEntries[0], {
      event: "status-transition",
      phase: "intake",
      from: "running",
      to: "waiting",
    });
  },
);

Deno.test(
  "advancePhase: selfReview throwing is treated as false",
  async () => {
    const ticket = makeTicket({ phase: "intake", status: "running" });
    const writeTicketSpy = spy((_dir: string, _t: TicketState) =>
      Promise.resolve()
    );
    const appendLogSpy = spy(
      (_dir: string, _id: string, _entry: object) => Promise.resolve(),
    );
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: writeTicketSpy,
        appendLog: appendLogSpy,
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        selfReview: () => Promise.reject(new Error("review exploded")),
      }),
    );
    assertSpyCalls(writeTicketSpy, 1);
    assertSpyCalls(appendLogSpy, 1);
  },
);

Deno.test(
  "advancePhase: selfReview returning false leaves ticket waiting with no approvals",
  async () => {
    const ticket = makeTicket({ phase: "intake", status: "running" });
    const writtenTickets: TicketState[] = [];
    const writeTicketSpy = spy((_dir: string, t: TicketState) => {
      writtenTickets.push(t);
      return Promise.resolve();
    });
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: writeTicketSpy,
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
      }),
    );
    assertSpyCalls(writeTicketSpy, 1);
    assertEquals(writtenTickets[0].approvals, []);
  },
);

Deno.test(
  "advancePhase: selfReview returning reason writes self-review output file",
  async () => {
    const ticket = makeTicket({
      id: "gh-1",
      phase: "intake",
      status: "running",
    });
    const writePhaseOutputCalls: Array<[string, string, string, string]> = [];
    const writePhaseOutputSpy = spy(
      (stateDir: string, id: string, file: string, content: string) => {
        writePhaseOutputCalls.push([stateDir, id, file, content]);
        return Promise.resolve();
      },
    );
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writePhaseOutput: writePhaseOutputSpy,
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        selfReview: () =>
          Promise.resolve({
            approved: false,
            reason: "REJECT\nCriterion 1 violated.",
          }),
      }),
    );
    assertSpyCalls(writePhaseOutputSpy, 1);
    assertEquals(writePhaseOutputCalls[0][0], "/state");
    assertEquals(writePhaseOutputCalls[0][1], "gh-1");
    assert(
      /^\d{8}T\d{6}-intake-self-review\.md$/.test(
        writePhaseOutputCalls[0][2],
      ),
    );
    assertEquals(writePhaseOutputCalls[0][3], "REJECT\nCriterion 1 violated.");
  },
);

Deno.test(
  "advancePhase: selfReview returning null reason does not write output file",
  async () => {
    const ticket = makeTicket({ phase: "intake", status: "running" });
    const writePhaseOutputSpy = spy(() => Promise.resolve());
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writePhaseOutput: writePhaseOutputSpy,
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
      }),
    );
    assertSpyCalls(writePhaseOutputSpy, 0);
  },
);

Deno.test(
  "advancePhase: selfReview is called with the ticket phase and ticketDir",
  async () => {
    const ticket = makeTicket({
      id: "github/jackjennings/lazyboy/104",
      phase: "intake",
      status: "running",
    });
    let capturedPhase = "";
    let capturedTicketDir = "";
    const selfReviewSpy = spy((phase: string, ticketDir: string) => {
      capturedPhase = phase;
      capturedTicketDir = ticketDir;
      return Promise.resolve({ approved: false, reason: null });
    });
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        selfReview: selfReviewSpy,
      }),
    );
    assertEquals(capturedPhase, "intake");
    assertEquals(
      capturedTicketDir,
      "/state/github/jackjennings/lazyboy/104",
    );
  },
);

Deno.test(
  "advancePhase: github implementation phase advance appends provider supplement",
  async () => {
    const ticket = makeTicket({
      phase: "plan",
      status: "waiting",
      approvals: [{ timestamp: "t", actor: "human", phase: "plan" }],
      provider: "github",
      worktrees: {
        "jackjennings/lazyboy": { path: "/tmp/wt", branch: "gh-1" },
      },
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
    const supplement = await Deno.readTextFile(
      new URL(
        "./prompts/github-implementation.md",
        import.meta.url,
      ).pathname,
    );
    assertStringIncludes(spawnedPrompt, supplement.trim());
    assertStringIncludes(spawnedPrompt, "\n\n");
  },
);

Deno.test(
  "advancePhase: github implementation revising appends provider supplement",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "revising",
      provider: "github",
      worktrees: {
        "jackjennings/lazyboy": { path: "/tmp/wt", branch: "gh-99" },
      },
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
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
      }),
    );
    assertSpyCall(spawnSpy, 0);
    const supplement = await Deno.readTextFile(
      new URL(
        "./prompts/github-implementation.md",
        import.meta.url,
      ).pathname,
    );
    assertStringIncludes(spawnedPrompt, supplement.trim());
    assertFalse(supplement.includes("gh pr create"));
  },
);

Deno.test(
  "advancePhase: non-github implementation phase advance uses base prompt only",
  async () => {
    const ticket = makeTicket({
      phase: "plan",
      status: "waiting",
      approvals: [{ timestamp: "t", actor: "human", phase: "plan" }],
      provider: "jira",
      worktrees: {
        "jackjennings/lazyboy": { path: "/tmp/wt", branch: "gh-1" },
      },
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
    const basePrompt = await loadPromptFile("implementation.md");
    assertEquals(spawnedPrompt, basePrompt);
  },
);

Deno.test(
  "advancePhase: new ticket intake prompt is unchanged when no provider supplement exists",
  async () => {
    const ticket = makeTicket({
      phase: "intake",
      status: "new",
      provider: "github",
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
  "advancePhase: new ticket intake prompt appends repo corpus text when present",
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
        buildRepoCorpusText: () =>
          Promise.resolve(
            "## Available Repositories\n\n- myorg/frontend (checked out at /code/myorg/frontend)\n",
          ),
      }),
    );
    assertSpyCall(spawnSpy, 0);
    const basePrompt = await loadPromptFile("intake.md");
    assertEquals(
      spawnedPrompt,
      basePrompt +
        "\n\n## Available Repositories\n\n" +
        "- myorg/frontend (checked out at /code/myorg/frontend)\n",
    );
  },
);

Deno.test(
  "advancePhase: new ticket intake prompt has no trailing corpus block when buildRepoCorpusText is absent",
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

Deno.test(
  "advancePhase: waiting + approved with phase not in pinned pipelineSteps parks as needs-attention",
  async () => {
    const ticket = makeTicket({
      phase: "spec",
      status: "waiting",
      approvals: [{ timestamp: "t", actor: "human", phase: "spec" }],
      pipelineSteps: [{ phase: "intake" }, { phase: "implementation" }],
    });
    let written: TicketState | null = null;
    const writeTicketSpy = spy((_dir: string, t: TicketState) => {
      written = t;
      return Promise.resolve();
    });
    const loggedEntries: object[] = [];
    const appendLogSpy = spy((_dir: string, _id: string, entry: object) => {
      loggedEntries.push(entry);
      return Promise.resolve();
    });
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: writeTicketSpy,
        appendLog: appendLogSpy,
      }),
    );
    assertSpyCall(writeTicketSpy, 0);
    assertEquals((written as unknown as TicketState).status, "needs-attention");
    assertArrayIncludes(loggedEntries, [
      { event: "needs-attention", reason: "phase-not-in-pipeline" },
    ]);
  },
);

Deno.test(
  "advancePhase: implementation/running with dead PID calls spawnOutlierAnalysis with ticket id, dir, worktree path, and phase",
  async () => {
    const ticket = makeTicket({
      id: "gh-1",
      phase: "implementation",
      status: "running",
      prs: [{ url: "u", title: "T", dependsOn: [], merged: false }],
      worktrees: {
        "jackjennings/lazyboy": { path: "/wt/path", branch: "gh-1" },
      },
    });
    const calls: Array<[string, string, string, string]> = [];
    const spawnOutlierAnalysisSpy = spy(
      (
        ticketId: string,
        ticketDir: string,
        worktreePath: string,
        phase: string,
      ) => {
        calls.push([ticketId, ticketDir, worktreePath, phase]);
        return Promise.resolve();
      },
    );
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        spawnOutlierAnalysis: spawnOutlierAnalysisSpy,
      }),
    );
    assertSpyCalls(spawnOutlierAnalysisSpy, 1);
    assertEquals(calls[0][0], "gh-1");
    assertEquals(calls[0][1], "/state/gh-1");
    assertEquals(calls[0][2], "/wt/path");
    assertEquals(calls[0][3], "implementation");
  },
);

Deno.test(
  "advancePhase: implementation/running with dead PID and no lazyboy worktree logs error and does not call spawnOutlierAnalysis",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "running",
      prs: [{ url: "u", title: "T", dependsOn: [], merged: false }],
      worktrees: {},
    });
    const spawnOutlierAnalysisSpy = spy(() => Promise.resolve());
    const logEntries: object[] = [];
    const appendLogSpy = spy(
      (_dir: string, _id: string, entry: object) => {
        logEntries.push(entry);
        return Promise.resolve();
      },
    );
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        appendLog: appendLogSpy,
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        spawnOutlierAnalysis: spawnOutlierAnalysisSpy,
      }),
    );
    assertSpyCalls(spawnOutlierAnalysisSpy, 0);
    assert(
      logEntries.some(
        (e) =>
          (e as Record<string, unknown>).event === "error" &&
          (e as Record<string, unknown>).context === "spawnOutlierAnalysis",
      ),
    );
  },
);

Deno.test(
  'advancePhase: plan/running with dead PID calls spawnOutlierAnalysis with phase "plan"',
  async () => {
    const ticket = makeTicket({
      id: "gh-1",
      phase: "plan",
      status: "running",
      worktrees: {
        "jackjennings/lazyboy": { path: "/wt/path", branch: "gh-1" },
      },
    });
    const calls: Array<[string, string, string, string]> = [];
    const spawnOutlierAnalysisSpy = spy(
      (
        ticketId: string,
        ticketDir: string,
        worktreePath: string,
        phase: string,
      ) => {
        calls.push([ticketId, ticketDir, worktreePath, phase]);
        return Promise.resolve();
      },
    );
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        spawnOutlierAnalysis: spawnOutlierAnalysisSpy,
      }),
    );
    assertSpyCalls(spawnOutlierAnalysisSpy, 1);
    assertEquals(calls[0][0], "gh-1");
    assertEquals(calls[0][1], "/state/gh-1");
    assertEquals(calls[0][2], "/wt/path");
    assertEquals(calls[0][3], "plan");
  },
);

Deno.test(
  "advancePhase: plan/running with dead PID and no lazyboy worktree logs error and does not call spawnOutlierAnalysis",
  async () => {
    const ticket = makeTicket({
      phase: "plan",
      status: "running",
      worktrees: {},
    });
    const spawnOutlierAnalysisSpy = spy(() => Promise.resolve());
    const logEntries: object[] = [];
    const appendLogSpy = spy(
      (_dir: string, _id: string, entry: object) => {
        logEntries.push(entry);
        return Promise.resolve();
      },
    );
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        appendLog: appendLogSpy,
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        spawnOutlierAnalysis: spawnOutlierAnalysisSpy,
      }),
    );
    assertSpyCalls(spawnOutlierAnalysisSpy, 0);
    assert(
      logEntries.some(
        (e) =>
          (e as Record<string, unknown>).event === "error" &&
          (e as Record<string, unknown>).context === "spawnOutlierAnalysis",
      ),
    );
  },
);

Deno.test(
  "advancePhase: non-implementation/running with dead PID does not call spawnOutlierAnalysis",
  async () => {
    const ticket = makeTicket({ phase: "enrichment", status: "running" });
    const spawnOutlierAnalysisSpy = spy(() => Promise.resolve());
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        spawnOutlierAnalysis: spawnOutlierAnalysisSpy,
      }),
    );
    assertSpyCalls(spawnOutlierAnalysisSpy, 0);
  },
);

Deno.test(
  "advancePhase: implementation/running with dead PID and no spawnOutlierAnalysis dep does not throw",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "running",
      prs: [{ url: "u", title: "T", dependsOn: [], merged: false }],
      worktrees: {
        "jackjennings/lazyboy": { path: "/wt/path", branch: "gh-1" },
      },
    });
    const writeTicketSpy = spy((_dir: string, _t: TicketState) =>
      Promise.resolve()
    );
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: writeTicketSpy,
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
      }),
    );
    assertSpyCalls(writeTicketSpy, 1);
  },
);

Deno.test(
  "advancePhase: new ticket includes state prompt in spawned prompt",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${stateDir}/prompts`);
      await Deno.writeTextFile(
        `${stateDir}/prompts/intake.md`,
        "STATE INTAKE CONTEXT",
      );
      const ticket = makeTicket({ phase: "intake", status: "new" });
      let spawnedPrompt = "";
      const spawnSpy = spy((opts: SpawnOpts) => {
        spawnedPrompt = opts.prompt;
        return Promise.resolve();
      });
      await advancePhase(
        ticket,
        stateDir,
        makeTickDeps({
          spawn: spawnSpy,
          resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        }),
      );
      assertSpyCall(spawnSpy, 0);
      assertStringIncludes(spawnedPrompt, "STATE INTAKE CONTEXT");
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "advancePhase: phase transition includes state prompt in spawned prompt",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${stateDir}/prompts`);
      await Deno.writeTextFile(
        `${stateDir}/prompts/enrichment.md`,
        "STATE ENRICHMENT CONTEXT",
      );
      const ticket = makeTicket({
        phase: "intake",
        status: "waiting",
        approvals: [{ timestamp: "t", actor: "human", phase: "intake" }],
      });
      let spawnedPrompt = "";
      const spawnSpy = spy((opts: SpawnOpts) => {
        spawnedPrompt = opts.prompt;
        return Promise.resolve();
      });
      await advancePhase(
        ticket,
        stateDir,
        makeTickDeps({
          spawn: spawnSpy,
          resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        }),
      );
      assertSpyCall(spawnSpy, 0);
      assertStringIncludes(spawnedPrompt, "STATE ENRICHMENT CONTEXT");
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "advancePhase: revising includes state prompt in spawned prompt",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${stateDir}/prompts`);
      await Deno.writeTextFile(
        `${stateDir}/prompts/implementation.md`,
        "STATE IMPL CONTEXT",
      );
      const ticket = makeTicket({
        phase: "implementation",
        status: "revising",
        worktrees: {
          "jackjennings/lazyboy": { path: "/tmp/wt", branch: "gh-1" },
        },
      });
      let spawnedPrompt = "";
      const spawnSpy = spy((opts: SpawnOpts) => {
        spawnedPrompt = opts.prompt;
        return Promise.resolve();
      });
      await advancePhase(
        ticket,
        stateDir,
        makeTickDeps({
          spawn: spawnSpy,
          resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        }),
      );
      assertSpyCall(spawnSpy, 0);
      assertStringIncludes(spawnedPrompt, "STATE IMPL CONTEXT");
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "advancePhase: empty state prompt file does not inject blank separator",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${stateDir}/prompts`);
      await Deno.writeTextFile(`${stateDir}/prompts/intake.md`, "");
      const ticket = makeTicket({ phase: "intake", status: "new" });
      let spawnedPrompt = "";
      const spawnSpy = spy((opts: SpawnOpts) => {
        spawnedPrompt = opts.prompt;
        return Promise.resolve();
      });
      await advancePhase(
        ticket,
        stateDir,
        makeTickDeps({
          spawn: spawnSpy,
          resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        }),
      );
      assertSpyCall(spawnSpy, 0);
      assertFalse(spawnedPrompt.includes("\n\n\n"));
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "advancePhase: state prompt error propagates",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${stateDir}/prompts`);
      await Deno.mkdir(`${stateDir}/prompts/intake.md`);
      const ticket = makeTicket({ phase: "intake", status: "new" });
      await assertRejects(() =>
        advancePhase(
          ticket,
          stateDir,
          makeTickDeps({
            resolveModelConfig: () => ({ model: "m", thinking: "off" }),
            selfReview: () =>
              Promise.resolve({ approved: false, reason: null }),
          }),
        )
      );
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "advancePhase: per-provider prompt content is included in spawned prompt",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(join(stateDir, "prompts", "github"), {
        recursive: true,
      });
      await Deno.writeTextFile(
        join(stateDir, "prompts", "github", "intake.md"),
        "github intake supplement",
      );
      const ticket = makeTicket({
        id: "github/jackjennings/testrepo/1",
        provider: "github",
        phase: "intake",
        status: "new",
      });
      let capturedPrompt = "";
      await advancePhase(
        ticket,
        stateDir,
        makeTickDeps({
          spawn: (opts) => {
            capturedPrompt = opts.prompt;
            return Promise.resolve();
          },
          resolveModelConfig: () => ({
            model: "claude-sonnet-4-6",
            thinking: "off",
          }),
        }),
      );
      assertEquals(capturedPrompt.includes("github intake supplement"), true);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "advancePhase: document ticket in implementation/running with no documents moves to needs-attention",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const ticket = makeTicket({
        phase: "implementation",
        status: "running",
        artifacts: ["document"],
      });
      const statuses: string[] = [];
      await advancePhase(
        ticket,
        stateDir,
        makeTickDeps({
          writeTicket: (_dir, t) => {
            statuses.push(t.status);
            return Promise.resolve();
          },
          resolveModelConfig: () => ({
            model: "claude-sonnet-4-6",
            thinking: "off",
          }),
          readPhaseOutput: () => Promise.resolve("output content"),
        }),
      );
      assertArrayIncludes(statuses, ["waiting", "needs-attention"]);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "advancePhase: document ticket in plan/waiting/approved with no worktrees spawns implementation",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const ticket = makeTicket({
        phase: "plan",
        status: "waiting",
        artifacts: ["document"],
        approvals: [{
          timestamp: "2026-01-01T00:00:00Z",
          actor: "human",
          phase: "plan",
        }],
        worktrees: {},
      });
      let spawnedPhase: string | undefined;
      await advancePhase(
        ticket,
        stateDir,
        makeTickDeps({
          spawn: (opts) => {
            spawnedPhase = opts.phase;
            return Promise.resolve();
          },
          resolveModelConfig: () => ({
            model: "claude-sonnet-4-6",
            thinking: "off",
          }),
          readPhaseOutput: () => Promise.resolve(null),
        }),
      );
      assertEquals(spawnedPhase, "implementation");
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "advancePhase: document ticket in implementation/waiting/approved transitions to merge/done without calling markPRsReady",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const ticket = makeTicket({
        phase: "implementation",
        status: "waiting",
        artifacts: ["document"],
        approvals: [{
          timestamp: "2026-01-01T00:00:00Z",
          actor: "human",
          phase: "implementation",
        }],
      });
      let writtenPhase: string | undefined;
      let writtenStatus: string | undefined;
      const markPRsReadySpy = spy(() => Promise.resolve());
      await advancePhase(
        ticket,
        stateDir,
        makeTickDeps({
          writeTicket: (_dir, t) => {
            writtenPhase = t.phase;
            writtenStatus = t.status;
            return Promise.resolve();
          },
          resolveModelConfig: () => ({
            model: "claude-sonnet-4-6",
            thinking: "off",
          }),
          markPRsReady: markPRsReadySpy,
          readPhaseOutput: () => Promise.resolve(null),
        }),
      );
      assertEquals(writtenPhase, "merge");
      assertEquals(writtenStatus, "done");
      assertSpyCalls(markPRsReadySpy, 0);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "advancePhase: emits prompt-too-long for intake path when threshold exceeded",
  async () => {
    const ticket = makeTicket({ phase: "intake", status: "new" });
    const appendLogSpy = spy(
      (_dir: string, _id: string, _entry: object) => Promise.resolve(),
    );
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        appendLog: appendLogSpy,
        resolveModelConfig: () => ({
          model: "claude-sonnet-4-6",
          thinking: "off",
        }),
        maxPromptTokens: 1,
      }),
    );
    const entries = appendLogSpy.calls.map(
      (c) => c.args[2] as Record<string, unknown>,
    );
    const warning = entries.find((e) => e.event === "prompt-too-long");
    assert(warning !== undefined, "expected prompt-too-long event");
    assertEquals(warning.event, "prompt-too-long");
    assertEquals(warning.phase, "intake");
    assertEquals(warning.maxTokens, 1);
    assertLess(0, warning.tokens as number);
  },
);

Deno.test(
  "advancePhase: emits prompt-too-long for revising path when threshold exceeded",
  async () => {
    const ticket = makeTicket({ phase: "enrichment", status: "revising" });
    const appendLogSpy = spy(
      (_dir: string, _id: string, _entry: object) => Promise.resolve(),
    );
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        appendLog: appendLogSpy,
        resolveModelConfig: () => ({
          model: "claude-sonnet-4-6",
          thinking: "off",
        }),
        maxPromptTokens: 1,
      }),
    );
    const entries = appendLogSpy.calls.map(
      (c) => c.args[2] as Record<string, unknown>,
    );
    const warning = entries.find((e) => e.event === "prompt-too-long");
    assert(warning !== undefined, "expected prompt-too-long event");
    assertEquals(warning.phase, "enrichment");
    assertEquals(warning.maxTokens, 1);
    assertLess(0, warning.tokens as number);
  },
);

Deno.test(
  "advancePhase: spec/waiting + approved + phases.plan.skip skips plan, advances to implementation",
  async () => {
    const ticket = makeTicket({
      phase: "spec",
      status: "waiting",
      approvals: [{ timestamp: "t", actor: "human", phase: "spec" }],
      phases: { plan: { skip: true } },
      worktrees: {
        "jackjennings/lazyboy": { path: "/tmp/wt", branch: "gh-1" },
      },
    });
    let spawnedPhase = "";
    const spawnSpy = spy((opts: SpawnOpts) => {
      spawnedPhase = opts.phase;
      return Promise.resolve();
    });
    const logEntries: object[] = [];
    const appendLogSpy = spy(
      (_dir: string, _id: string, entry: object) => {
        logEntries.push(entry);
        return Promise.resolve();
      },
    );
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        spawn: spawnSpy,
        appendLog: appendLogSpy,
        resolveModelConfig: () => ({
          model: "claude-sonnet-4-6",
          thinking: "off",
        }),
        readPhaseExitCode: () => Promise.resolve(null),
      }),
    );
    assertEquals(spawnedPhase, "implementation");
    assertArrayIncludes(logEntries as Record<string, unknown>[], [
      { event: "phase-transition", from: "spec", to: "implementation" },
    ]);
  },
);

Deno.test(
  "advancePhase: spec/waiting + approved without skipPlan advances to plan",
  async () => {
    const ticket = makeTicket({
      phase: "spec",
      status: "waiting",
      approvals: [{ timestamp: "t", actor: "human", phase: "spec" }],
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
    assertEquals(spawnedPhase, "plan");
  },
);

Deno.test(
  "advancePhase: emits prompt-too-long for waiting+approved path when threshold exceeded",
  async () => {
    const ticket = makeTicket({
      phase: "intake",
      status: "waiting",
      approvals: [{
        timestamp: "2026-08-06T00:00:00Z",
        actor: "human",
        phase: "intake",
      }],
    });
    const appendLogSpy = spy(
      (_dir: string, _id: string, _entry: object) => Promise.resolve(),
    );
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        appendLog: appendLogSpy,
        resolveModelConfig: () => ({
          model: "claude-sonnet-4-6",
          thinking: "off",
        }),
        maxPromptTokens: 1,
      }),
    );
    const entries = appendLogSpy.calls.map(
      (c) => c.args[2] as Record<string, unknown>,
    );
    const warning = entries.find((e) => e.event === "prompt-too-long");
    assert(warning !== undefined, "expected prompt-too-long event");
    assertEquals(warning.phase, "enrichment");
    assertEquals(warning.maxTokens, 1);
    assertLess(0, warning.tokens as number);
  },
);

Deno.test(
  "advancePhase: no prompt-too-long when prompt is within threshold",
  async () => {
    const ticket = makeTicket({ phase: "intake", status: "new" });
    const appendLogSpy = spy(
      (_dir: string, _id: string, _entry: object) => Promise.resolve(),
    );
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        appendLog: appendLogSpy,
        resolveModelConfig: () => ({
          model: "claude-sonnet-4-6",
          thinking: "off",
        }),
        maxPromptTokens: 100_000,
      }),
    );
    const entries = appendLogSpy.calls.map(
      (c) => c.args[2] as Record<string, unknown>,
    );
    assertFalse(entries.some((e) => e.event === "prompt-too-long"));
  },
);

Deno.test(
  "advancePhase: no prompt-too-long with default threshold for real prompts",
  async () => {
    const ticket = makeTicket({ phase: "intake", status: "new" });
    const appendLogSpy = spy(
      (_dir: string, _id: string, _entry: object) => Promise.resolve(),
    );
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        appendLog: appendLogSpy,
        resolveModelConfig: () => ({
          model: "claude-sonnet-4-6",
          thinking: "off",
        }),
      }),
    );
    const entries = appendLogSpy.calls.map(
      (c) => c.args[2] as Record<string, unknown>,
    );
    assertFalse(entries.some((e) => e.event === "prompt-too-long"));
  },
);

Deno.test(
  "advancePhase: adjudicatePhaseModel called with prompt when next is implementation",
  async () => {
    const ticket = makeTicket({
      phase: "plan",
      status: "waiting",
      approvals: [{ timestamp: "t", actor: "human", phase: "plan" }],
      worktrees: { "jackjennings/lazyboy": { path: "/tmp/wt", branch: "b" } },
    });
    let capturedPrompt: string | undefined;
    const adjudicatePhaseModelSpy = spy((p: string) => {
      capturedPrompt = p;
      return Promise.resolve(null);
    });
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        ...makeTickDeps(),
        adjudicatePhaseModel: adjudicatePhaseModelSpy,
      }),
    );
    assertSpyCalls(adjudicatePhaseModelSpy, 1);
    assertExists(capturedPrompt);
  },
);

Deno.test(
  "advancePhase: non-null adjudicatePhaseModel result is merged into ticket before resolveModelConfig",
  async () => {
    const ticket = makeTicket({
      phase: "plan",
      status: "waiting",
      approvals: [{ timestamp: "t", actor: "human", phase: "plan" }],
      worktrees: { "jackjennings/lazyboy": { path: "/tmp/wt", branch: "b" } },
    });
    const adjudicatedModel = { model: "claude-opus-4-6", thinking: "max" };
    let resolveModelConfigTicket: TicketState | undefined;
    const writtenTickets: TicketState[] = [];
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        ...makeTickDeps(),
        writeTicket: (_dir, t) => {
          writtenTickets.push(t);
          return Promise.resolve();
        },
        resolveModelConfig: (_phase, t) => {
          resolveModelConfigTicket = t;
          return { model: "claude-sonnet-4-6", thinking: "off" };
        },
        adjudicatePhaseModel: () => Promise.resolve(adjudicatedModel),
      }),
    );
    assertEquals(
      resolveModelConfigTicket?.phases?.["implementation"],
      adjudicatedModel,
    );
    const overrideWrite = writtenTickets.find(
      (t) =>
        t.phases?.["implementation"] !== undefined && t.status !== "running",
    );
    assertExists(overrideWrite);
  },
);

Deno.test(
  "advancePhase: null adjudicatePhaseModel result leaves ticket unchanged for resolveModelConfig",
  async () => {
    const ticket = makeTicket({
      phase: "plan",
      status: "waiting",
      approvals: [{ timestamp: "t", actor: "human", phase: "plan" }],
      worktrees: { "jackjennings/lazyboy": { path: "/tmp/wt", branch: "b" } },
    });
    let resolveModelConfigTicket: TicketState | undefined;
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        ...makeTickDeps(),
        resolveModelConfig: (_phase, t) => {
          resolveModelConfigTicket = t;
          return { model: "claude-sonnet-4-6", thinking: "off" };
        },
        adjudicatePhaseModel: () => Promise.resolve(null),
      }),
    );
    assertEquals(
      resolveModelConfigTicket?.phases?.["implementation"],
      undefined,
    );
  },
);

Deno.test(
  "advancePhase: adjudicatePhaseModel not called for non-implementation next phase",
  async () => {
    const ticket = makeTicket({
      phase: "intake",
      status: "waiting",
      approvals: [{ timestamp: "t", actor: "human", phase: "intake" }],
    });
    const adjudicatePhaseModelSpy = spy(() => Promise.resolve(null));
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        ...makeTickDeps(),
        adjudicatePhaseModel: adjudicatePhaseModelSpy,
      }),
    );
    assertSpyCalls(adjudicatePhaseModelSpy, 0);
  },
);

Deno.test(
  "advancePhase: spec revising uses revision prompt when spec-revision.md exists",
  async () => {
    const ticket = makeTicket({
      phase: "spec",
      status: "revising",
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
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
      }),
    );
    assertSpyCall(spawnSpy, 0);
    const revisionPrompt = await Deno.readTextFile(
      new URL("./prompts/spec-revision.md", import.meta.url).pathname,
    );
    assertStringIncludes(spawnedPrompt, revisionPrompt.trim());
  },
);

Deno.test(
  "advancePhase: intake revising uses revision prompt when intake-revision.md exists",
  async () => {
    const ticket = makeTicket({
      phase: "intake",
      status: "revising",
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
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
      }),
    );
    assertSpyCall(spawnSpy, 0);
    const revisionPrompt = await Deno.readTextFile(
      new URL("./prompts/intake-revision.md", import.meta.url).pathname,
    );
    assertStringIncludes(spawnedPrompt, revisionPrompt.trim());
  },
);

Deno.test(
  "advancePhase: document ticket at implementation/running with no documents → needs-attention with reason no-pages",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "running",
      artifacts: ["document"],
    });
    const written: TicketState[] = [];
    const logEntries: object[] = [];
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        ...makeTickDeps(),
        writeTicket: (_dir, t) => {
          written.push(t);
          return Promise.resolve();
        },
        appendLog: (_dir, _id, entry) => {
          logEntries.push(entry);
          return Promise.resolve();
        },
        readPhaseOutput: () => Promise.resolve("valid output"),
      }),
    );
    const last = written.at(-1)!;
    assertEquals(last.status, "needs-attention");
    assertArrayIncludes(logEntries as Record<string, unknown>[], [{
      event: "needs-attention",
      reason: "no-pages",
    }]);
  },
);

Deno.test(
  "advancePhase: document ticket at implementation/waiting approved with documents → merge/done",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "waiting",
      artifacts: ["document"],
      approvals: [{ timestamp: "t", actor: "human", phase: "implementation" }],
      documents: [{ url: "https://notion.so/page", title: "Doc" }],
    });
    const written: TicketState[] = [];
    const markPRsReadySpy = spy((_urls: string[]) => Promise.resolve());
    const writeTicketSpy = spy((_dir: string, t: TicketState) => {
      written.push(t);
      return Promise.resolve();
    });
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        ...makeTickDeps(),
        writeTicket: writeTicketSpy,
        markPRsReady: markPRsReadySpy,
      }),
    );
    assertSpyCall(writeTicketSpy, 0);
    assertEquals(written[0].phase, "merge");
    assertEquals(written[0].status, "done");
    assertSpyCalls(markPRsReadySpy, 0);
  },
);

Deno.test(
  "advancePhase: document ticket at plan/waiting approved with no worktrees proceeds to implementation",
  async () => {
    const ticket = makeTicket({
      phase: "plan",
      status: "waiting",
      artifacts: ["document"],
      approvals: [{ timestamp: "t", actor: "human", phase: "plan" }],
      worktrees: {},
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
        ...makeTickDeps(),
        spawn: spawnSpy,
      }),
    );
    assertSpyCall(spawnSpy, 0);
    assertEquals(spawnedPhase, "implementation");
  },
);

Deno.test(
  "advancePhase: revising prompt is unchanged when no comment-context file exists",
  async () => {
    const ticket = makeTicket({ phase: "plan", status: "revising" });
    const spawnedPrompts: string[] = [];
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        spawn: (opts) => {
          spawnedPrompts.push(opts.prompt);
          return Promise.resolve();
        },
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
      }),
    );
    assertFalse(spawnedPrompts[0].includes("comment-context"));
  },
);

Deno.test(
  "advancePhase: revising prompt includes most recent comment-context file content",
  async () => {
    const stateDir = await Deno.makeTempDir();
    const ticketDir = join(stateDir, "github", "org", "repo", "1");
    await Deno.mkdir(ticketDir, { recursive: true });
    await Deno.writeTextFile(
      join(ticketDir, "20260101T120000-comment-context.md"),
      "## New comments\n\nOlder comment",
    );
    await Deno.writeTextFile(
      join(ticketDir, "20260201T080000-comment-context.md"),
      "## New comments\n\nNewer comment",
    );
    const ticket = makeTicket({
      id: "github/org/repo/1",
      phase: "plan",
      status: "revising",
    });
    const spawnedPrompts: string[] = [];
    await advancePhase(
      ticket,
      stateDir,
      makeTickDeps({
        spawn: (opts) => {
          spawnedPrompts.push(opts.prompt);
          return Promise.resolve();
        },
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
      }),
    );
    assertStringIncludes(spawnedPrompts[0], "Newer comment");
    assertFalse(spawnedPrompts[0].includes("Older comment"));
    await Deno.remove(stateDir, { recursive: true });
  },
);

Deno.test(
  "advancePhase: new ticket stores session ID in phaseSessionIds before spawning",
  async () => {
    const ticket = makeTicket({ phase: "intake", status: "new" });
    let writtenTicket: TicketState | undefined;
    let spawnOpts: SpawnOpts | undefined;
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        spawn: (opts) => {
          spawnOpts = opts;
          return Promise.resolve();
        },
        writeTicket: (_dir, t) => {
          writtenTicket = t;
          return Promise.resolve();
        },
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
      }),
    );
    const uuid = writtenTicket?.phaseSessionIds?.["intake"];
    assertExists(uuid);
    assert(/^[0-9a-f-]{36}$/.test(uuid));
    assertExists(spawnOpts);
    assertEquals(spawnOpts!.sessionId, uuid);
  },
);

Deno.test(
  "advancePhase: waiting + approved stores session ID in phaseSessionIds before spawning next phase",
  async () => {
    const ticket = makeTicket({
      phase: "intake",
      status: "waiting",
      approvals: [{ timestamp: "t", actor: "human", phase: "intake" }],
    });
    let writtenTicket: TicketState | undefined;
    let spawnOpts: SpawnOpts | undefined;
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        spawn: (opts) => {
          spawnOpts = opts;
          return Promise.resolve();
        },
        writeTicket: (_dir, t) => {
          writtenTicket = t;
          return Promise.resolve();
        },
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
      }),
    );
    const uuid = writtenTicket?.phaseSessionIds?.["enrichment"];
    assertExists(uuid);
    assert(/^[0-9a-f-]{36}$/.test(uuid));
    assertExists(spawnOpts);
    assertEquals(spawnOpts!.sessionId, uuid);
  },
);

Deno.test(
  "advancePhase: boot ID mismatch with stored session ID resumes the phase",
  async () => {
    const ticket = makeTicket({
      phase: "intake",
      status: "running",
      phaseSessionIds: { intake: "uuid-stored" },
    });
    const writtenStatuses: string[] = [];
    const loggedEvents: string[] = [];
    let spawnOpts: SpawnOpts | undefined;
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        spawn: (opts) => {
          spawnOpts = opts;
          return Promise.resolve();
        },
        writeTicket: (_dir, t) => {
          writtenStatuses.push(t.status);
          return Promise.resolve();
        },
        appendLog: (_dir, _id, entry) => {
          loggedEvents.push((entry as { event: string }).event);
          return Promise.resolve();
        },
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        readPhaseOutput: () => Promise.resolve(null),
        readPhaseExitCode: () => Promise.resolve(null),
        readRunPidBootStamp: () => Promise.resolve("old-boot"),
        currentBootId: () => "new-boot",
      }),
    );
    assert(writtenStatuses.includes("running"));
    assert(loggedEvents.includes("phase-resumed"));
    assertExists(spawnOpts);
    assertEquals(spawnOpts!.sessionId, "uuid-stored");
    assertEquals(spawnOpts!.resume, true);
  },
);

Deno.test(
  "advancePhase: matching boot IDs with null exit code goes to needs-attention",
  async () => {
    const ticket = makeTicket({
      phase: "intake",
      status: "running",
      phaseSessionIds: { intake: "uuid-stored" },
    });
    const writtenStatuses: string[] = [];
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: (_dir, t) => {
          writtenStatuses.push(t.status);
          return Promise.resolve();
        },
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        readPhaseOutput: () => Promise.resolve(null),
        readPhaseExitCode: () => Promise.resolve(null),
        readRunPidBootStamp: () => Promise.resolve("same-boot"),
        currentBootId: () => "same-boot",
      }),
    );
    assert(writtenStatuses.includes("needs-attention"));
    assertFalse(writtenStatuses.includes("running"));
  },
);

Deno.test(
  "advancePhase: boot ID mismatch without stored session ID goes to needs-attention",
  async () => {
    const ticket = makeTicket({ phase: "intake", status: "running" });
    const writtenStatuses: string[] = [];
    await advancePhase(
      ticket,
      "/state",
      makeTickDeps({
        writeTicket: (_dir, t) => {
          writtenStatuses.push(t.status);
          return Promise.resolve();
        },
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
        readPhaseOutput: () => Promise.resolve(null),
        readPhaseExitCode: () => Promise.resolve(null),
        readRunPidBootStamp: () => Promise.resolve("old-boot"),
        currentBootId: () => "new-boot",
      }),
    );
    assert(writtenStatuses.includes("needs-attention"));
    assertFalse(writtenStatuses.includes("running"));
  },
);

Deno.test(
  "advancePhase: revising includes state revision prompt content when file exists",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const ticket = makeTicket({
        phase: "implementation",
        status: "revising",
        worktrees: { "jackjennings/lazyboy": { path: "/wt", branch: "b" } },
      });
      await Deno.mkdir(join(stateDir, "prompts"), { recursive: true });
      await Deno.writeTextFile(
        join(stateDir, "prompts", "implementation-revision.md"),
        "state revision supplement",
      );
      let spawnedPrompt = "";
      await advancePhase(ticket, stateDir, {
        ...makeTickDeps(),
        spawn: (opts) => {
          spawnedPrompt = opts.prompt;
          return Promise.resolve();
        },
      });
      assertStringIncludes(spawnedPrompt, "state revision supplement");
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "advancePhase: revising state revision prompt absent does not change prompt",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const ticket = makeTicket({
        phase: "plan",
        status: "revising",
      });
      await Deno.mkdir(join(stateDir, "prompts"), { recursive: true });
      let spawnedPrompt = "";
      await advancePhase(ticket, stateDir, {
        ...makeTickDeps(),
        spawn: (opts) => {
          spawnedPrompt = opts.prompt;
          return Promise.resolve();
        },
      });
      assertFalse(spawnedPrompt.includes("plan-revision-sentinel"));
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "advancePhase: code+document ticket with empty documents → needs-attention with no-pages",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const ticket = makeTicket({
        phase: "implementation",
        status: "running",
        artifacts: ["code", "document"],
      });
      const written: Array<{ status: string }> = [];
      const logged: Array<Record<string, string>> = [];
      await advancePhase(
        ticket,
        stateDir,
        makeTickDeps({
          writeTicket: (_dir, t) => {
            written.push({ status: t.status });
            return Promise.resolve();
          },
          appendLog: (_dir, _id, entry) => {
            logged.push(entry as Record<string, string>);
            return Promise.resolve();
          },
          resolveModelConfig: () => ({
            model: "claude-sonnet-4-6",
            thinking: "off",
          }),
          readPhaseOutput: () => Promise.resolve("output content"),
        }),
      );
      const attention = logged.find((e) => e.event === "needs-attention");
      assertEquals(attention?.reason, "no-pages");
      const lastWritten = written.at(-1);
      assertEquals(lastWritten?.status, "needs-attention");
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "advancePhase: code+document ticket with documents transitions to merge/waiting",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const ticket = makeTicket({
        phase: "implementation",
        status: "waiting",
        artifacts: ["code", "document"],
        documents: [{ url: "https://notion.so/abc", title: "Doc" }],
        prs: [{
          url: "https://github.com/org/repo/pull/1",
          title: "PR",
          dependsOn: [],
          merged: false,
        }],
        approvals: [{
          timestamp: "2026-01-01T00:00:00Z",
          actor: "human",
          phase: "implementation",
        }],
      });
      let writtenPhase: string | undefined;
      let writtenStatus: string | undefined;
      await advancePhase(
        ticket,
        stateDir,
        makeTickDeps({
          writeTicket: (_dir, t) => {
            writtenPhase = t.phase;
            writtenStatus = t.status;
            return Promise.resolve();
          },
          resolveModelConfig: () => ({
            model: "claude-sonnet-4-6",
            thinking: "off",
          }),
        }),
      );
      assertEquals(writtenPhase, "merge");
      assertEquals(writtenStatus, "waiting");
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "advancePhase: code+document ticket with no worktrees blocks entry to implementation",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      const ticket = makeTicket({
        phase: "plan",
        status: "waiting",
        artifacts: ["code", "document"],
        approvals: [{
          timestamp: "2026-01-01T00:00:00Z",
          actor: "human",
          phase: "plan",
        }],
        worktrees: {},
      });
      let writtenPhase: string | undefined;
      let writtenStatus: string | undefined;
      await advancePhase(
        ticket,
        stateDir,
        makeTickDeps({
          writeTicket: (_dir, t) => {
            writtenPhase = t.phase;
            writtenStatus = t.status;
            return Promise.resolve();
          },
          resolveModelConfig: () => ({
            model: "claude-sonnet-4-6",
            thinking: "off",
          }),
        }),
      );
      assertEquals(writtenPhase, "implementation");
      assertEquals(writtenStatus, "needs-attention");
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);
