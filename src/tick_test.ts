import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertExists,
  assertFalse,
  assertLess,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { assertSpyCall, assertSpyCalls, spy, stub } from "@std/testing/mock";
import { appendTickLog, selectCandidates, TickService } from "./tick.ts";
import { adjudicatePhaseModel } from "./pre-phase-adjudication.ts";
import type { TickDeps } from "./phases/advance.ts";
import type { Lock } from "./lock.ts";
import type { TicketState } from "./state/types.ts";
import {
  makeTickDeps,
  makeTicket,
  makeTickServiceDeps,
  withLazyboyDir,
} from "./test-support.ts";
import type { Provider, WorkItem } from "./providers/types.ts";
import { CorruptRepoIdentitiesError } from "./providers/github/repo-identity.ts";

type SpawnOpts = Parameters<TickDeps["spawn"]>[0];

Deno.test("implementation.md contains explicit draft PR instruction", async () => {
  const content = await Deno.readTextFile(
    new URL("./phases/prompts/implementation.md", import.meta.url).pathname,
  );
  assertStringIncludes(content, "pull requests in draft mode");
});

// ── appendTickLog ─────────────────────────────────────────────────────────────

Deno.test("appendTickLog: writes to combined log without id field", async () => {
  using lazy = withLazyboyDir();
  await appendTickLog({ event: "tick-failed", error: "boom" });
  const combined = await Deno.readTextFile(
    join(lazy.path, "log.ndjson"),
  );
  const parsed = JSON.parse(combined.trim());
  assertEquals(parsed.event, "tick-failed");
  assertEquals(parsed.id, undefined);
});

Deno.test("appendTickLog: tick log entry is unchanged", async () => {
  using lazy = withLazyboyDir();
  await appendTickLog({ event: "stale-lock" });
  const tick = await Deno.readTextFile(
    join(lazy.path, "tick.ndjson"),
  );
  const parsed = JSON.parse(tick.trim());
  assertEquals(parsed.event, "stale-lock");
  assertEquals(parsed.id, undefined);
});

Deno.test("appendTickLog: tick log write succeeds when combined log write fails", async () => {
  using lazy = withLazyboyDir();
  await Deno.mkdir(join(lazy.path, "log.ndjson"), { recursive: true });
  await appendTickLog({ event: "tick-already-running" });
  const tick = await Deno.readTextFile(
    join(lazy.path, "tick.ndjson"),
  );
  assertEquals(JSON.parse(tick.trim()).event, "tick-already-running");
});

// ── TickService ────────────────────────────────────────────────────────────────

Deno.test("TickService: lock.withLock called once per run()", async () => {
  let calls = 0;
  const lock: Lock = {
    withLock: async (fn) => {
      calls++;
      await fn();
    },
  };
  const deps = makeTickServiceDeps({ lock });
  await new TickService(deps).run();
  assertEquals(calls, 1);
});

Deno.test(
  "TickService: workflow does not run if lock.withLock does not call fn",
  async () => {
    const listTicketsSpy = spy(() => Promise.resolve([]));
    const lock: Lock = { withLock: (_fn) => Promise.resolve() };
    const deps = makeTickServiceDeps({ lock, listTickets: listTicketsSpy });
    await new TickService(deps).run();
    assertSpyCalls(listTicketsSpy, 0);
  },
);

Deno.test(
  "TickService: installPackages called with packageSources before listTickets",
  async () => {
    const sequence: string[] = [];
    const deps = makeTickServiceDeps({
      packageSources: ["npm:foo"],
      installPackages: spy(() => {
        sequence.push("install");
        return Promise.resolve([]);
      }),
      listTickets: spy(() => {
        sequence.push("list");
        return Promise.resolve([]);
      }),
    });
    await new TickService(deps).run();
    assertEquals(sequence[0], "install");
    assertEquals(sequence[1], "list");
  },
);

Deno.test(
  "TickService: providers.fetchNew called with existingIds set",
  async () => {
    let capturedIds: Set<string> | null = null;
    const provider: Provider = {
      fetchNew: (ids) => {
        capturedIds = ids;
        return Promise.resolve([]);
      },
      close: () => Promise.resolve(),
    };
    const deps = makeTickServiceDeps({
      providers: [provider],
      listTickets: () => Promise.resolve(["gh-1"]),
    });
    await new TickService(deps).run();
    assertEquals(capturedIds, new Set(["gh-1"]));
  },
);

Deno.test(
  "TickService: new work items written as tickets with intake/new",
  async () => {
    const item: WorkItem = {
      id: "gh-2",
      provider: "github",
      title: "Title",
      url: "https://github.com/t/r/issues/2",
      description: "body",
    };
    const provider: Provider = {
      fetchNew: () => Promise.resolve([item]),
      close: () => Promise.resolve(),
    };
    const writtenTickets: TicketState[] = [];
    const deps = makeTickServiceDeps({
      providers: [provider],
      listTickets: () => Promise.resolve([]),
      writeTicket: spy((t: TicketState) => {
        writtenTickets.push(t);
        return Promise.resolve();
      }),
    });
    await new TickService(deps).run();
    assertEquals(writtenTickets.length, 1);
    assertEquals(writtenTickets[0].id, "gh-2");
    assertEquals(writtenTickets[0].phase, "intake");
    assertEquals(writtenTickets[0].status, "new");
    assertEquals(writtenTickets[0].approvals, []);
    assertEquals(writtenTickets[0].body, "body");
  },
);

Deno.test(
  "TickService: ticket-captured logged for each new item",
  async () => {
    const item: WorkItem = {
      id: "gh-2",
      provider: "github",
      title: "Fix the bug",
      url: "https://github.com/t/r/issues/2",
      description: "body",
    };
    const provider: Provider = {
      fetchNew: () => Promise.resolve([item]),
      close: () => Promise.resolve(),
    };
    const appendLogSpy = spy(() => Promise.resolve());
    const deps = makeTickServiceDeps({
      providers: [provider],
      listTickets: () => Promise.resolve([]),
      tickDeps: makeTickDeps({ ...makeTickDeps(), appendLog: appendLogSpy }),
    });
    await new TickService(deps).run();
    assertSpyCalls(appendLogSpy, 1);
    assertEquals(appendLogSpy.calls[0].args, [
      "/state",
      "gh-2",
      { event: "ticket-captured", title: "Fix the bug" },
    ]);
  },
);

Deno.test(
  "TickService: ticket-captured not logged when writeTicket throws",
  async () => {
    const item: WorkItem = {
      id: "gh-2",
      provider: "github",
      title: "Fix the bug",
      url: "https://github.com/t/r/issues/2",
      description: "body",
    };
    const provider: Provider = {
      fetchNew: () => Promise.resolve([item]),
      close: () => Promise.resolve(),
    };
    const appendLogSpy = spy(() => Promise.resolve());
    const deps = makeTickServiceDeps({
      providers: [provider],
      listTickets: () => Promise.resolve([]),
      writeTicket: () => Promise.reject(new Error("write failed")),
      tickDeps: makeTickDeps({ ...makeTickDeps(), appendLog: appendLogSpy }),
      exit: () => {},
    });
    await new TickService(deps).run();
    assertSpyCalls(appendLogSpy, 0);
  },
);

Deno.test(
  "TickService: unreadable ticket logs ticket-read-error and valid tickets proceed",
  async () => {
    using _dir = withLazyboyDir();
    const validTicket = makeTicket({
      id: "gh-valid",
      phase: "intake",
      status: "new",
    });
    const tickLogEntries: Record<string, unknown>[] = [];
    const migratedTickets: TicketState[][] = [];
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.resolve(["gh-bad", "gh-valid"]),
      readTicket: (id) =>
        id === "gh-bad"
          ? Promise.reject(new Error("invalid phase"))
          : Promise.resolve(validTicket),
      appendTickLog: (entry) => {
        tickLogEntries.push(entry as Record<string, unknown>);
        return Promise.resolve();
      },
      runMigrations: (_dir, tickets) => {
        migratedTickets.push([...tickets]);
        return Promise.resolve(tickets);
      },
    });
    await new TickService(deps).run();

    const readError = tickLogEntries.find(
      (e) => e.event === "ticket-read-error",
    );
    assertExists(readError);
    assertEquals(readError.id, "gh-bad");
    assertEquals(readError.message, "invalid phase");

    assertEquals(migratedTickets.length, 1);
    assertEquals(migratedTickets[0].length, 1);
    assertEquals(migratedTickets[0][0].id, "gh-valid");
  },
);

Deno.test(
  "TickService: runMigrations called before tick actions",
  async () => {
    const sequence: string[] = [];
    const ticket = makeTicket({ id: "gh-1", phase: "intake", status: "new" });
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.resolve(["gh-1"]),
      readTicket: () => Promise.resolve(ticket),
      runMigrations: spy((_dir, tickets) => {
        sequence.push("migrate");
        return Promise.resolve(tickets);
      }),
      tickActions: [{
        applies: (_t) => {
          sequence.push("action");
          return false;
        },
        run: () => Promise.resolve(null),
      }],
      concurrency: 0,
    });
    await new TickService(deps).run();
    assertLess(sequence.indexOf("migrate"), sequence.indexOf("action"));
  },
);

Deno.test(
  "TickService: tickAction.applies and .run called for matching ticket",
  async () => {
    const ticket = makeTicket({ id: "gh-1", phase: "intake", status: "new" });
    const runSpy = spy(
      (_t: TicketState, _sd: string) =>
        Promise.resolve<TicketState | null>(null),
    );
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.resolve(["gh-1"]),
      readTicket: () => Promise.resolve(ticket),
      tickActions: [{ applies: () => true, run: runSpy }],
      concurrency: 0,
    });
    await new TickService(deps).run();
    assertSpyCalls(runSpy, 1);
  },
);

Deno.test(
  "TickService: tick actions skipped for wont-do tickets",
  async () => {
    const ticket = makeTicket({
      id: "gh-1",
      phase: "wont-do",
      status: "done",
    });
    const appliesSpy = spy((_t: TicketState) => true);
    const runSpy = spy(
      (_t: TicketState, _sd: string) =>
        Promise.resolve<TicketState | null>(null),
    );
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.resolve(["gh-1"]),
      readTicket: () => Promise.resolve(ticket),
      tickActions: [{ applies: appliesSpy, run: runSpy }],
      concurrency: 0,
    });
    await new TickService(deps).run();
    assertSpyCalls(appliesSpy, 0);
    assertSpyCalls(runSpy, 0);
  },
);

Deno.test(
  "TickService: writeLastWorked called with selected candidate IDs",
  async () => {
    const t1 = makeTicket({
      id: "gh-1",
      phase: "intake",
      status: "waiting",
    });
    const t2 = makeTicket({
      id: "gh-2",
      phase: "intake",
      status: "waiting",
    });
    const store: Record<string, TicketState> = { "gh-1": t1, "gh-2": t2 };
    const writeLastWorkedSpy = spy((_ids: string[]) => Promise.resolve());
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.resolve(["gh-1", "gh-2"]),
      readTicket: (id) => Promise.resolve(store[id]),
      writeLastWorked: writeLastWorkedSpy,
      concurrency: 1,
    });
    await new TickService(deps).run();
    assertSpyCall(writeLastWorkedSpy, 0, { args: [["gh-1"]] });
  },
);

Deno.test(
  "TickService: readLastWorked shifts round-robin start position",
  async () => {
    const t1 = makeTicket({
      id: "gh-1",
      phase: "intake",
      status: "waiting",
    });
    const t2 = makeTicket({
      id: "gh-2",
      phase: "intake",
      status: "waiting",
    });
    const t3 = makeTicket({
      id: "gh-3",
      phase: "intake",
      status: "waiting",
    });
    const store: Record<string, TicketState> = {
      "gh-1": t1,
      "gh-2": t2,
      "gh-3": t3,
    };
    const writeLastWorkedSpy = spy((_ids: string[]) => Promise.resolve());
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.resolve(["gh-1", "gh-2", "gh-3"]),
      readTicket: (id) => Promise.resolve(store[id]),
      readLastWorked: () => Promise.resolve(["gh-1"]),
      writeLastWorked: writeLastWorkedSpy,
      concurrency: 1,
    });
    await new TickService(deps).run();
    assertSpyCall(writeLastWorkedSpy, 0, { args: [["gh-2"]] });
  },
);

Deno.test(
  "TickService: running tickets excluded from writeLastWorked",
  async () => {
    const running = makeTicket({
      id: "gh-1",
      phase: "intake",
      status: "running",
    });
    const waiting = makeTicket({
      id: "gh-2",
      phase: "intake",
      status: "waiting",
    });
    const store: Record<string, TicketState> = {
      "gh-1": running,
      "gh-2": waiting,
    };
    const writeLastWorkedSpy = spy((_ids: string[]) => Promise.resolve());
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.resolve(["gh-1", "gh-2"]),
      readTicket: (id) => Promise.resolve(store[id]),
      tickDeps: makeTickDeps({
        isProcessAlive: (id) => id === "gh-1",
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
      }),
      writeLastWorked: writeLastWorkedSpy,
      concurrency: 2,
    });
    await new TickService(deps).run();
    assertSpyCall(writeLastWorkedSpy, 0, { args: [["gh-2"]] });
  },
);

Deno.test(
  "TickService: writeLastWorked called with empty array when no candidates",
  async () => {
    const running = makeTicket({
      id: "gh-1",
      phase: "intake",
      status: "running",
    });
    const store: Record<string, TicketState> = { "gh-1": running };
    const writeLastWorkedSpy = spy((_ids: string[]) => Promise.resolve());
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.resolve(["gh-1"]),
      readTicket: (id) => Promise.resolve(store[id]),
      writeLastWorked: writeLastWorkedSpy,
      concurrency: 2,
    });
    await new TickService(deps).run();
    assertSpyCall(writeLastWorkedSpy, 0, { args: [[]] });
  },
);

Deno.test(
  "TickService: skipped-status tickets not included in candidates or writeLastWorked",
  async () => {
    const done = makeTicket({ id: "gh-1", phase: "merge", status: "done" });
    const needsAttention = makeTicket({
      id: "gh-2",
      phase: "intake",
      status: "needs-attention",
    });
    const mergeWaiting = makeTicket({
      id: "gh-3",
      phase: "merge",
      status: "waiting",
    });
    const store: Record<string, TicketState> = {
      "gh-1": done,
      "gh-2": needsAttention,
      "gh-3": mergeWaiting,
    };
    const writeLastWorkedSpy = spy((_ids: string[]) => Promise.resolve());
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.resolve(["gh-1", "gh-2", "gh-3"]),
      readTicket: (id) => Promise.resolve(store[id]),
      writeLastWorked: writeLastWorkedSpy,
      concurrency: 3,
    });
    await new TickService(deps).run();
    assertSpyCall(writeLastWorkedSpy, 0, { args: [[]] });
  },
);

Deno.test(
  "TickService: wont-do tickets not included in candidates or writeLastWorked",
  async () => {
    const wontDo = makeTicket({
      id: "gh-wont-do",
      phase: "wont-do",
      status: "done",
    });
    const store: Record<string, TicketState> = { "gh-wont-do": wontDo };
    const writeLastWorkedSpy = spy((_ids: string[]) => Promise.resolve());
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.resolve(["gh-wont-do"]),
      readTicket: (id) => Promise.resolve(store[id]),
      writeLastWorked: writeLastWorkedSpy,
      concurrency: 3,
    });
    await new TickService(deps).run();
    assertSpyCall(writeLastWorkedSpy, 0, { args: [[]] });
  },
);

Deno.test(
  "TickService: commitState called after writeLastWorked",
  async () => {
    const sequence: string[] = [];
    const deps = makeTickServiceDeps({
      writeLastWorked: spy(() => {
        sequence.push("writeLastWorked");
        return Promise.resolve();
      }),
      commitState: spy(() => {
        sequence.push("commitState");
        return Promise.resolve();
      }),
    });
    await new TickService(deps).run();
    assertLess(
      sequence.indexOf("writeLastWorked"),
      sequence.indexOf("commitState"),
    );
  },
);

Deno.test("TickService: exit(1) called when workflow throws", async () => {
  const exitSpy = spy((_code: number) => {});
  const deps = makeTickServiceDeps({
    listTickets: () => Promise.reject(new Error("workflow error")),
    exit: exitSpy,
  });
  await new TickService(deps).run();
  assertSpyCall(exitSpy, 0, { args: [1] });
});

Deno.test(
  "TickService: writes tick-failed entry via injected appendTickLog when workflow throws",
  async () => {
    const captured: object[] = [];
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.reject(new Error("workflow error")),
      appendTickLog: (entry) => {
        captured.push(entry);
        return Promise.resolve();
      },
      exit: () => {},
    });
    await new TickService(deps).run();
    assertEquals(captured.length, 2);
    assertEquals((captured[0] as Record<string, unknown>).event, "tick-start");
    const entry = captured[1] as Record<string, unknown>;
    assertEquals(entry.event, "tick-failed");
    assertEquals(entry.error, "workflow error");
    assertEquals(typeof entry.ts, "string");
  },
);

Deno.test(
  "TickService: writes tick-start then tick-end on successful workflow",
  async () => {
    const captured: object[] = [];
    const deps = makeTickServiceDeps({
      appendTickLog: (entry) => {
        captured.push(entry);
        return Promise.resolve();
      },
    });
    await new TickService(deps).run();
    assertEquals(captured.length, 2);
    assertEquals((captured[0] as Record<string, unknown>).event, "tick-start");
    assertEquals((captured[1] as Record<string, unknown>).event, "tick-end");
  },
);

Deno.test(
  "TickService: installPackages called before lock fn is invoked",
  async () => {
    const sequence: string[] = [];
    const lock: Lock = {
      withLock: async (fn) => {
        sequence.push("lockFn");
        await fn();
      },
    };
    const deps = makeTickServiceDeps({
      lock,
      installPackages: spy(() => {
        sequence.push("install");
        return Promise.resolve([]);
      }),
    });
    await new TickService(deps).run();
    assertLess(sequence.indexOf("install"), sequence.indexOf("lockFn"));
  },
);

Deno.test(
  "TickService: lock fn not called when installPackages throws",
  async () => {
    let lockFnCalled = false;
    const lock: Lock = {
      withLock: async (fn) => {
        lockFnCalled = true;
        await fn();
      },
    };
    const deps = makeTickServiceDeps({
      lock,
      installPackages: () => Promise.reject(new Error("install failed")),
      exit: () => {},
    });
    await new TickService(deps).run();
    assertFalse(lockFnCalled);
  },
);

Deno.test(
  "TickService: lock fn not called when refreshAnthropicPricing throws",
  async () => {
    let lockFnCalled = false;
    const lock: Lock = {
      withLock: async (fn) => {
        lockFnCalled = true;
        await fn();
      },
    };
    const deps = makeTickServiceDeps({
      lock,
      refreshAnthropicPricing: () =>
        Promise.reject(new Error("pricing failed")),
      exit: () => {},
    });
    await new TickService(deps).run();
    assertFalse(lockFnCalled);
  },
);

Deno.test(
  "TickService: fills both concurrency slots when all running tickets have dead PIDs",
  async () => {
    const running1 = makeTicket({
      id: "gh-1",
      phase: "intake",
      status: "running",
    });
    const running2 = makeTicket({
      id: "gh-2",
      phase: "intake",
      status: "running",
    });
    const candidate1 = makeTicket({
      id: "gh-3",
      phase: "intake",
      status: "new",
    });
    const candidate2 = makeTicket({
      id: "gh-4",
      phase: "intake",
      status: "new",
    });
    const store: Record<string, TicketState> = {
      "gh-1": running1,
      "gh-2": running2,
      "gh-3": candidate1,
      "gh-4": candidate2,
    };
    const spawnSpy = spy((_opts: SpawnOpts) => Promise.resolve());
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.resolve(["gh-1", "gh-2", "gh-3", "gh-4"]),
      readTicket: (id) => Promise.resolve(store[id]),
      concurrency: 2,
      tickDeps: makeTickDeps({
        spawn: spawnSpy,
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
      }),
    });
    await new TickService(deps).run();
    assertSpyCalls(spawnSpy, 2);
  },
);

Deno.test(
  "TickService: fills one concurrency slot when one running ticket is alive and one is dead",
  async () => {
    const running1 = makeTicket({
      id: "gh-1",
      phase: "intake",
      status: "running",
    });
    const running2 = makeTicket({
      id: "gh-2",
      phase: "intake",
      status: "running",
    });
    const candidate1 = makeTicket({
      id: "gh-3",
      phase: "intake",
      status: "new",
    });
    const candidate2 = makeTicket({
      id: "gh-4",
      phase: "intake",
      status: "new",
    });
    const store: Record<string, TicketState> = {
      "gh-1": running1,
      "gh-2": running2,
      "gh-3": candidate1,
      "gh-4": candidate2,
    };
    const spawnSpy = spy((_opts: SpawnOpts) => Promise.resolve());
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.resolve(["gh-1", "gh-2", "gh-3", "gh-4"]),
      readTicket: (id) => Promise.resolve(store[id]),
      concurrency: 2,
      tickDeps: makeTickDeps({
        spawn: spawnSpy,
        isProcessAlive: (id) => id === "gh-1",
        resolveModelConfig: () => ({ model: "m", thinking: "off" }),
      }),
    });
    await new TickService(deps).run();
    assertSpyCalls(spawnSpy, 1);
  },
);

Deno.test(
  "TickService: notifyTickFailure called with error message when workflow throws",
  async () => {
    const captured: string[] = [];
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.reject(new Error("auth failure")),
      notifyTickFailure: (error) => {
        captured.push(error);
        return Promise.resolve();
      },
      exit: () => {},
    });
    await new TickService(deps).run();
    assertEquals(captured, ["auth failure"]);
  },
);

Deno.test(
  "TickService: notifyTickFailure called with String(e) when non-Error thrown",
  async () => {
    const captured: string[] = [];
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.reject("raw string error"),
      notifyTickFailure: (error) => {
        captured.push(error);
        return Promise.resolve();
      },
      exit: () => {},
    });
    await new TickService(deps).run();
    assertEquals(captured, ["raw string error"]);
  },
);

Deno.test(
  "TickService: notifyTickFailure called for pre-lock failures",
  async () => {
    const captured: string[] = [];
    const deps = makeTickServiceDeps({
      installPackages: () => Promise.reject(new Error("install failed")),
      notifyTickFailure: (error) => {
        captured.push(error);
        return Promise.resolve();
      },
      exit: () => {},
    });
    await new TickService(deps).run();
    assertEquals(captured, ["install failed"]);
  },
);

Deno.test(
  "TickService: exit(1) still fires when notifyTickFailure throws",
  async () => {
    const exitSpy = spy((_code: number) => {});
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.reject(new Error("workflow error")),
      notifyTickFailure: () => Promise.reject(new Error("notify failed")),
      exit: exitSpy,
    });
    await new TickService(deps).run();
    assertSpyCall(exitSpy, 0, { args: [1] });
  },
);

Deno.test(
  "TickService: proceeds normally when notifyTickFailure is absent",
  async () => {
    const exitSpy = spy((_code: number) => {});
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.reject(new Error("workflow error")),
      exit: exitSpy,
    });
    await new TickService(deps).run();
    assertSpyCall(exitSpy, 0, { args: [1] });
  },
);

Deno.test(
  "TickService: action.run throwing is caught, error logged, loop continues to next action",
  async () => {
    const ticket = makeTicket({ id: "gh-1", phase: "intake", status: "new" });
    const appendLogSpy = spy(
      (_stateDir: string, _id: string, _entry: object) => Promise.resolve(),
    );
    const runSpy = spy(
      (_t: TicketState, _sd: string) =>
        Promise.resolve<TicketState | null>(null),
    );
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.resolve(["gh-1"]),
      readTicket: () => Promise.resolve(ticket),
      tickActions: [
        { applies: () => true, run: () => Promise.reject(new Error("boom")) },
        { applies: () => true, run: runSpy },
      ],
      tickDeps: makeTickDeps({ ...makeTickDeps(), appendLog: appendLogSpy }),
      concurrency: 0,
    });
    await new TickService(deps).run();
    assertSpyCalls(runSpy, 1);
    const errorCalls = appendLogSpy.calls.filter(
      (c) => (c.args[2] as { event: string }).event === "error",
    );
    assertEquals(errorCalls.length, 1);
    assertEquals(
      (errorCalls[0].args[2] as { context: string }).context,
      "tickAction",
    );
    assertStringIncludes(
      String((errorCalls[0].args[2] as { message: string }).message),
      "boom",
    );
  },
);

Deno.test(
  "TickService: action.applies throwing is caught, error logged, loop continues",
  async () => {
    const ticket = makeTicket({ id: "gh-1", phase: "intake", status: "new" });
    const appendLogSpy = spy(
      (_stateDir: string, _id: string, _entry: object) => Promise.resolve(),
    );
    const runSpy = spy(
      (_t: TicketState, _sd: string) =>
        Promise.resolve<TicketState | null>(null),
    );
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.resolve(["gh-1"]),
      readTicket: () => Promise.resolve(ticket),
      tickActions: [
        {
          applies: () => {
            throw new Error("applies boom");
          },
          run: () => Promise.resolve(null),
        },
        { applies: () => true, run: runSpy },
      ],
      tickDeps: makeTickDeps({ ...makeTickDeps(), appendLog: appendLogSpy }),
      concurrency: 0,
    });
    await new TickService(deps).run();
    assertSpyCalls(runSpy, 1);
    const errorCalls = appendLogSpy.calls.filter(
      (c) => (c.args[2] as { event: string }).event === "error",
    );
    assertEquals(errorCalls.length, 1);
    assertEquals(
      (errorCalls[0].args[2] as { context: string }).context,
      "tickAction",
    );
    assertStringIncludes(
      String((errorCalls[0].args[2] as { message: string }).message),
      "applies boom",
    );
  },
);

// ── selectCandidates ──────────────────────────────────────────────────────────

Deno.test("selectCandidates: empty candidates returns empty", () => {
  assertEquals(selectCandidates([], [], 2), []);
});

Deno.test("selectCandidates: no lastWorked starts at index 0", () => {
  assertEquals(selectCandidates(["gh-1", "gh-2", "gh-3"], [], 2), [
    "gh-1",
    "gh-2",
  ]);
});

Deno.test("selectCandidates: lastWorked anchor advances start by one", () => {
  assertEquals(
    selectCandidates(["gh-1", "gh-2", "gh-3", "gh-4", "gh-5"], ["gh-2"], 2),
    ["gh-3", "gh-4"],
  );
});

Deno.test("selectCandidates: anchor at last element wraps to index 0", () => {
  assertEquals(selectCandidates(["gh-1", "gh-2", "gh-3"], ["gh-3"], 2), [
    "gh-1",
    "gh-2",
  ]);
});

Deno.test("selectCandidates: wrapping selection spans end and start of list", () => {
  assertEquals(
    selectCandidates(["gh-1", "gh-2", "gh-3", "gh-4", "gh-5"], ["gh-4"], 3),
    ["gh-5", "gh-1", "gh-2"],
  );
});

Deno.test("selectCandidates: concurrency larger than candidates returns all", () => {
  assertEquals(selectCandidates(["gh-1", "gh-2"], [], 10), ["gh-1", "gh-2"]);
});

Deno.test("selectCandidates: all lastWorked IDs absent from candidates starts at 0", () => {
  assertEquals(
    selectCandidates(["gh-1", "gh-3", "gh-5"], ["gh-2", "gh-4"], 2),
    ["gh-1", "gh-3"],
  );
});

Deno.test("selectCandidates: uses last surviving ID from end of lastWorked as anchor", () => {
  assertEquals(
    selectCandidates(["gh-1", "gh-2", "gh-3"], ["gh-1", "gh-99", "gh-2"], 1),
    ["gh-3"],
  );
});

Deno.test(
  "TickService: notify called for needs-attention ticket",
  async () => {
    const ticket = makeTicket({
      id: "gh-1",
      phase: "implementation",
      status: "needs-attention",
    });
    const notifySpy = spy((_t: TicketState) => Promise.resolve());
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.resolve(["gh-1"]),
      readTicket: () => Promise.resolve(ticket),
      notify: notifySpy,
      concurrency: 0,
    });
    await new TickService(deps).run();
    assertSpyCalls(notifySpy, 1);
  },
);

Deno.test(
  "TickService: notify called with the needs-attention ticket",
  async () => {
    const ticket = makeTicket({
      id: "gh-1",
      phase: "implementation",
      status: "needs-attention",
    });
    const capturedTickets: TicketState[] = [];
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.resolve(["gh-1"]),
      readTicket: () => Promise.resolve(ticket),
      notify: (t) => {
        capturedTickets.push(t);
        return Promise.resolve();
      },
      concurrency: 0,
    });
    await new TickService(deps).run();
    assertEquals(capturedTickets.length, 1);
    assertEquals(capturedTickets[0].id, "gh-1");
    assertEquals(capturedTickets[0].status, "needs-attention");
  },
);

Deno.test(
  "TickService: notify not called for non-needs-attention ticket",
  async () => {
    const ticket = makeTicket({
      id: "gh-1",
      phase: "intake",
      status: "waiting",
      approvals: [],
    });
    const notifySpy = spy((_t: TicketState) => Promise.resolve());
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.resolve(["gh-1"]),
      readTicket: () => Promise.resolve(ticket),
      notify: notifySpy,
      concurrency: 0,
    });
    await new TickService(deps).run();
    assertSpyCalls(notifySpy, 0);
  },
);

Deno.test(
  "TickService: proceeds normally when notify is absent",
  async () => {
    const ticket = makeTicket({
      id: "gh-1",
      phase: "implementation",
      status: "needs-attention",
    });
    const commitSpy = spy(() => Promise.resolve());
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.resolve(["gh-1"]),
      readTicket: () => Promise.resolve(ticket),
      commitState: commitSpy,
      concurrency: 0,
    });
    await new TickService(deps).run();
    assertSpyCalls(commitSpy, 1);
  },
);

Deno.test(
  "TickService: notify called once per needs-attention ticket per run",
  async () => {
    const t1 = makeTicket({
      id: "gh-1",
      phase: "plan",
      status: "needs-attention",
    });
    const t2 = makeTicket({
      id: "gh-2",
      phase: "implementation",
      status: "needs-attention",
    });
    const store: Record<string, TicketState> = { "gh-1": t1, "gh-2": t2 };
    const notifySpy = spy((_t: TicketState) => Promise.resolve());
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.resolve(["gh-1", "gh-2"]),
      readTicket: (id) => Promise.resolve(store[id]),
      notify: notifySpy,
      concurrency: 0,
    });
    await new TickService(deps).run();
    assertSpyCalls(notifySpy, 2);
  },
);

Deno.test(
  "TickService: skips notification when notifiedNeedsAttention is true",
  async () => {
    const ticket = makeTicket({
      id: "gh-1",
      phase: "implementation",
      status: "needs-attention",
      notifiedNeedsAttention: true,
    });
    const notifySpy = spy((_t: TicketState) => Promise.resolve());
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.resolve(["gh-1"]),
      readTicket: () => Promise.resolve(ticket),
      notify: notifySpy,
      concurrency: 0,
    });
    await new TickService(deps).run();
    assertSpyCalls(notifySpy, 0);
  },
);

Deno.test(
  "TickService: sets notifiedNeedsAttention after notifying",
  async () => {
    const ticket = makeTicket({
      id: "gh-1",
      phase: "implementation",
      status: "needs-attention",
    });
    const writtenTickets: TicketState[] = [];
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.resolve(["gh-1"]),
      readTicket: () => Promise.resolve(ticket),
      notify: (_t) => Promise.resolve(),
      writeTicket: (t) => {
        writtenTickets.push(t);
        return Promise.resolve();
      },
      concurrency: 0,
    });
    await new TickService(deps).run();
    const notifiedWrite = writtenTickets.find((t) =>
      t.notifiedNeedsAttention === true
    );
    assertEquals(notifiedWrite?.id, "gh-1");
  },
);

Deno.test(
  "TickService: notify skipped when fresh read shows ticket no longer needs attention",
  async () => {
    const snapshotTicket = makeTicket({
      id: "gh-1",
      phase: "implementation",
      status: "needs-attention",
    });
    const freshTicket = makeTicket({
      id: "gh-1",
      phase: "implementation",
      status: "waiting",
    });
    let readCount = 0;
    const notifySpy = spy((_t: TicketState) => Promise.resolve());
    const writeTicketSpy = spy((_t: TicketState) => Promise.resolve());
    const deps = makeTickServiceDeps({
      listTickets: () => Promise.resolve(["gh-1"]),
      readTicket: (_id) => {
        readCount++;
        return Promise.resolve(readCount === 1 ? snapshotTicket : freshTicket);
      },
      notify: notifySpy,
      writeTicket: writeTicketSpy,
      concurrency: 0,
    });
    await new TickService(deps).run();
    assertSpyCalls(notifySpy, 0);
    assertSpyCalls(writeTicketSpy, 0);
  },
);

Deno.test(
  "TickService: refreshAnthropicPricing called before installPackages",
  async () => {
    const sequence: string[] = [];
    const refreshSpy = spy((): Promise<void> => {
      sequence.push("refresh");
      return Promise.resolve();
    });
    const deps = makeTickServiceDeps({
      refreshAnthropicPricing: refreshSpy,
      installPackages: spy(() => {
        sequence.push("install");
        return Promise.resolve([]);
      }),
    });
    await new TickService(deps).run();
    assertSpyCalls(refreshSpy, 1);
    assertEquals(sequence[0], "refresh");
    assertEquals(sequence[1], "install");
  },
);

Deno.test(
  "TickService: proceeds normally when refreshAnthropicPricing is omitted",
  async () => {
    const installPackagesSpy = spy(() => Promise.resolve([]));
    const deps = makeTickServiceDeps({
      installPackages: installPackagesSpy,
    });
    await new TickService(deps).run();
    assertSpyCalls(installPackagesSpy, 1);
  },
);

Deno.test("TickService: processLearnings called once per run", async () => {
  const processLearningsSpy = spy((): Promise<void> => Promise.resolve());
  const deps = makeTickServiceDeps({ processLearnings: processLearningsSpy });
  await new TickService(deps).run();
  assertSpyCalls(processLearningsSpy, 1);
});

Deno.test(
  "TickService: processLearnings called before ticket processing",
  async () => {
    const sequence: string[] = [];
    const deps = makeTickServiceDeps({
      processLearnings: spy((): Promise<void> => {
        sequence.push("processLearnings");
        return Promise.resolve();
      }),
      listTickets: spy((): Promise<string[]> => {
        sequence.push("listTickets");
        return Promise.resolve([]);
      }),
    });
    await new TickService(deps).run();
    assertLess(
      sequence.indexOf("processLearnings"),
      sequence.indexOf("listTickets"),
    );
  },
);

Deno.test(
  "TickService: proceeds normally when processLearnings is omitted",
  async () => {
    const commitStateSpy = spy((): Promise<void> => Promise.resolve());
    const deps = makeTickServiceDeps({ commitState: commitStateSpy });
    await new TickService(deps).run();
    assertSpyCalls(commitStateSpy, 1);
  },
);

Deno.test(
  "TickService: runCeremonies called after commitState",
  async () => {
    const sequence: string[] = [];
    const deps = makeTickServiceDeps({
      commitState: spy(() => {
        sequence.push("commitState");
        return Promise.resolve();
      }),
      runCeremonies: spy(() => {
        sequence.push("runCeremonies");
        return Promise.resolve();
      }),
    });
    await new TickService(deps).run();
    assertLess(
      sequence.indexOf("commitState"),
      sequence.indexOf("runCeremonies"),
    );
  },
);

Deno.test(
  "TickService: proceeds normally when runCeremonies is absent",
  async () => {
    const deps = makeTickServiceDeps();
    await new TickService(deps).run();
  },
);

Deno.test(
  "TickService: shortTitle set from generateShortTitle when it returns a value",
  async () => {
    const item: WorkItem = {
      id: "gh-3",
      provider: "github",
      title: "Add feature for doing something useful",
      url: "https://github.com/t/r/issues/3",
      description: "body",
    };
    const provider: Provider = {
      fetchNew: () => Promise.resolve([item]),
      close: () => Promise.resolve(),
    };
    const writtenTickets: TicketState[] = [];
    const deps = makeTickServiceDeps({
      providers: [provider],
      listTickets: () => Promise.resolve([]),
      writeTicket: spy((t: TicketState) => {
        writtenTickets.push(t);
        return Promise.resolve();
      }),
      generateShortTitle: (_title) => Promise.resolve("Add feature"),
    });
    await new TickService(deps).run();
    assertEquals(writtenTickets[0].shortTitle, "Add feature");
  },
);

Deno.test(
  "TickService: shortTitle is undefined when generateShortTitle returns null",
  async () => {
    const item: WorkItem = {
      id: "gh-3",
      provider: "github",
      title: "Title",
      url: "https://example.com",
      description: "body",
    };
    const provider: Provider = {
      fetchNew: () => Promise.resolve([item]),
      close: () => Promise.resolve(),
    };
    const writtenTickets: TicketState[] = [];
    const deps = makeTickServiceDeps({
      providers: [provider],
      listTickets: () => Promise.resolve([]),
      writeTicket: spy((t: TicketState) => {
        writtenTickets.push(t);
        return Promise.resolve();
      }),
      generateShortTitle: (_title) => Promise.resolve(null),
    });
    await new TickService(deps).run();
    assertEquals(writtenTickets[0].shortTitle, undefined);
  },
);

Deno.test(
  "TickService: shortTitle is absent when generateShortTitle dep is not provided",
  async () => {
    const item: WorkItem = {
      id: "gh-3",
      provider: "github",
      title: "Title",
      url: "https://example.com",
      description: "body",
    };
    const provider: Provider = {
      fetchNew: () => Promise.resolve([item]),
      close: () => Promise.resolve(),
    };
    const writtenTickets: TicketState[] = [];
    const deps = makeTickServiceDeps({
      providers: [provider],
      listTickets: () => Promise.resolve([]),
      writeTicket: spy((t: TicketState) => {
        writtenTickets.push(t);
        return Promise.resolve();
      }),
    });
    await new TickService(deps).run();
    assertEquals(writtenTickets[0].shortTitle, undefined);
  },
);

Deno.test(
  "TickService: scaffoldStatePrompts called before commitState",
  async () => {
    const sequence: string[] = [];
    const deps = makeTickServiceDeps({
      scaffoldStatePrompts: spy(() => {
        sequence.push("scaffoldStatePrompts");
        return Promise.resolve();
      }),
      commitState: spy(() => {
        sequence.push("commitState");
        return Promise.resolve();
      }),
    });
    await new TickService(deps).run();
    assertLess(
      sequence.indexOf("scaffoldStatePrompts"),
      sequence.indexOf("commitState"),
    );
  },
);

Deno.test(
  "TickService: proceeds normally when scaffoldStatePrompts is absent",
  async () => {
    const deps = makeTickServiceDeps();
    await new TickService(deps).run();
  },
);

Deno.test(
  "TickService: preflightGitHubCredentials called before processLearnings",
  async () => {
    const order: string[] = [];
    const deps = makeTickServiceDeps({
      preflightGitHubCredentials: () => {
        order.push("preflight");
        return Promise.resolve();
      },
      processLearnings: () => {
        order.push("learnings");
        return Promise.resolve();
      },
    });
    await new TickService(deps).run();
    assert(order.indexOf("preflight") < order.indexOf("learnings"));
  },
);

Deno.test(
  "TickService: emits agents-md-too-large when file token count exceeds threshold",
  async () => {
    const dir = await Deno.makeTempDir();
    const agentsMdPath = join(dir, "AGENTS.md");
    await Deno.writeTextFile(agentsMdPath, "word ".repeat(500));
    const captured: object[] = [];
    const deps = makeTickServiceDeps({
      agentsMdPaths: [agentsMdPath],
      agentsMdMaxTokens: 10,
      listTickets: () => Promise.resolve(["gh-1"]),
      appendTickLog: (entry) => {
        captured.push(entry);
        return Promise.resolve();
      },
    });
    await new TickService(deps).run();
    await Deno.remove(dir, { recursive: true });
    const entry = captured.find(
      (e) => (e as Record<string, unknown>).event === "agents-md-too-large",
    );
    assert(entry !== undefined);
    const e = entry as Record<string, unknown>;
    assertEquals(e.path, agentsMdPath);
    assertEquals(e.maxTokens, 10);
    assert(typeof e.tokens === "number" && (e.tokens as number) > 10);
  },
);

Deno.test(
  "TickService: no agents-md-too-large event when agentsMdPaths is absent",
  async () => {
    const captured: object[] = [];
    const deps = makeTickServiceDeps({
      appendTickLog: (entry) => {
        captured.push(entry);
        return Promise.resolve();
      },
    });
    await new TickService(deps).run();
    assertFalse(
      captured.some(
        (e) => (e as Record<string, unknown>).event === "agents-md-too-large",
      ),
    );
  },
);

Deno.test(
  "TickService: no agents-md-too-large event when file token count is within threshold",
  async () => {
    const dir = await Deno.makeTempDir();
    const agentsMdPath = join(dir, "AGENTS.md");
    await Deno.writeTextFile(agentsMdPath, "hi");
    const captured: object[] = [];
    const deps = makeTickServiceDeps({
      agentsMdPaths: [agentsMdPath],
      agentsMdMaxTokens: 100000,
      listTickets: () => Promise.resolve(["gh-1"]),
      appendTickLog: (entry) => {
        captured.push(entry);
        return Promise.resolve();
      },
    });
    await new TickService(deps).run();
    await Deno.remove(dir, { recursive: true });
    assertFalse(
      captured.some(
        (e) => (e as Record<string, unknown>).event === "agents-md-too-large",
      ),
    );
  },
);

Deno.test(
  "TickService: missing AGENTS.md is skipped silently and tick completes",
  async () => {
    const commitStateSpy = spy((): Promise<void> => Promise.resolve());
    const deps = makeTickServiceDeps({
      agentsMdPaths: ["/nonexistent/path/AGENTS.md"],
      agentsMdMaxTokens: 10,
      listTickets: () => Promise.resolve(["gh-1"]),
      commitState: commitStateSpy,
    });
    await new TickService(deps).run();
    assertSpyCalls(commitStateSpy, 1);
  },
);

Deno.test(
  "TickService: emits one agents-md-too-large event per exceeding file",
  async () => {
    const dir = await Deno.makeTempDir();
    const path1 = join(dir, "root1", "AGENTS.md");
    const path2 = join(dir, "root2", "AGENTS.md");
    await Deno.mkdir(join(dir, "root1"), { recursive: true });
    await Deno.mkdir(join(dir, "root2"), { recursive: true });
    await Deno.writeTextFile(path1, "word ".repeat(500));
    await Deno.writeTextFile(path2, "word ".repeat(500));
    const captured: object[] = [];
    const deps = makeTickServiceDeps({
      agentsMdPaths: [path1, path2],
      agentsMdMaxTokens: 10,
      listTickets: () => Promise.resolve(["gh-1"]),
      appendTickLog: (entry) => {
        captured.push(entry);
        return Promise.resolve();
      },
    });
    await new TickService(deps).run();
    await Deno.remove(dir, { recursive: true });
    const events = captured.filter(
      (e) => (e as Record<string, unknown>).event === "agents-md-too-large",
    );
    assertEquals(events.length, 2);
    const paths = events.map((e) => (e as Record<string, unknown>).path);
    assertArrayIncludes(paths, [path1, path2]);
  },
);

Deno.test(
  "TickService: agents-md-too-large fires on each phase start while over threshold",
  async () => {
    const dir = await Deno.makeTempDir();
    const agentsMdPath = join(dir, "AGENTS.md");
    await Deno.writeTextFile(agentsMdPath, "word ".repeat(500));
    const captured: object[] = [];
    const appendTickLog = (entry: object) => {
      captured.push(entry);
      return Promise.resolve();
    };
    const deps = makeTickServiceDeps({
      agentsMdPaths: [agentsMdPath],
      agentsMdMaxTokens: 10,
      listTickets: () => Promise.resolve(["gh-1"]),
      appendTickLog,
    });
    await new TickService(deps).run();
    await new TickService(deps).run();
    await Deno.remove(dir, { recursive: true });
    const events = captured.filter(
      (e) => (e as Record<string, unknown>).event === "agents-md-too-large",
    );
    assertEquals(events.length, 2);
  },
);

type MockCommandOutput = {
  code: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
};

type MockCommandFactory = (
  _cmd: string,
  _opts?: Deno.CommandOptions,
) => { output: () => Promise<MockCommandOutput> };

type DenoWithMockCommand = Omit<typeof Deno, "Command"> & {
  Command: MockCommandFactory;
};

function stubDenoCommand(factory: MockCommandFactory) {
  return stub(
    Deno as unknown as DenoWithMockCommand,
    "Command",
    factory,
  );
}

Deno.test(
  "adjudicatePhaseModel: valid response returns parsed model and thinking",
  async () => {
    const encoder = new TextEncoder();
    const commandStub = stubDenoCommand(() => ({
      output: () =>
        Promise.resolve({
          code: 0,
          stdout: encoder.encode(
            JSON.stringify({
              structured_output: { model: "claude-opus-4-6", thinking: "high" },
            }),
          ),
          stderr: new Uint8Array(),
        }),
    }));
    try {
      const result = await adjudicatePhaseModel("implement something");
      assertEquals(result, { model: "claude-opus-4-6", thinking: "high" });
    } finally {
      commandStub.restore();
    }
  },
);

Deno.test(
  "adjudicatePhaseModel: invalid model id returns null",
  async () => {
    const encoder = new TextEncoder();
    const commandStub = stubDenoCommand(() => ({
      output: () =>
        Promise.resolve({
          code: 0,
          stdout: encoder.encode(
            JSON.stringify({
              structured_output: { model: "gpt-4", thinking: "high" },
            }),
          ),
          stderr: new Uint8Array(),
        }),
    }));
    try {
      const result = await adjudicatePhaseModel("p");
      assertEquals(result, null);
    } finally {
      commandStub.restore();
    }
  },
);

Deno.test(
  "adjudicatePhaseModel: haiku model id returns null",
  async () => {
    const encoder = new TextEncoder();
    const commandStub = stubDenoCommand(() => ({
      output: () =>
        Promise.resolve({
          code: 0,
          stdout: encoder.encode(
            JSON.stringify({
              structured_output: { model: "claude-haiku-4-5", thinking: "off" },
            }),
          ),
          stderr: new Uint8Array(),
        }),
    }));
    try {
      const result = await adjudicatePhaseModel("p");
      assertEquals(result, null);
    } finally {
      commandStub.restore();
    }
  },
);

Deno.test(
  "adjudicatePhaseModel: invalid thinking level returns null",
  async () => {
    const encoder = new TextEncoder();
    const commandStub = stubDenoCommand(() => ({
      output: () =>
        Promise.resolve({
          code: 0,
          stdout: encoder.encode(
            JSON.stringify({
              structured_output: {
                model: "claude-sonnet-4-6",
                thinking: "turbo",
              },
            }),
          ),
          stderr: new Uint8Array(),
        }),
    }));
    try {
      const result = await adjudicatePhaseModel("p");
      assertEquals(result, null);
    } finally {
      commandStub.restore();
    }
  },
);

Deno.test(
  "adjudicatePhaseModel: non-zero exit code returns null",
  async () => {
    const commandStub = stubDenoCommand(() => ({
      output: () =>
        Promise.resolve({
          code: 1,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        }),
    }));
    try {
      const result = await adjudicatePhaseModel("p");
      assertEquals(result, null);
    } finally {
      commandStub.restore();
    }
  },
);

Deno.test(
  "adjudicatePhaseModel: malformed JSON in stdout returns null",
  async () => {
    const encoder = new TextEncoder();
    const commandStub = stubDenoCommand(() => ({
      output: () =>
        Promise.resolve({
          code: 0,
          stdout: encoder.encode("not json"),
          stderr: new Uint8Array(),
        }),
    }));
    try {
      const result = await adjudicatePhaseModel("p");
      assertEquals(result, null);
    } finally {
      commandStub.restore();
    }
  },
);

Deno.test(
  "adjudicatePhaseModel: command throws returns null",
  async () => {
    const commandStub = stubDenoCommand(() => ({
      output: () => {
        throw new Error("command failed");
      },
    }));
    try {
      const result = await adjudicatePhaseModel("p");
      assertEquals(result, null);
    } finally {
      commandStub.restore();
    }
  },
);

Deno.test("plan.md does not contain model recommendation instructions", async () => {
  const content = await Deno.readTextFile(
    new URL("./phases/prompts/plan.md", import.meta.url).pathname,
  );
  assertFalse(content.includes("## Model recommendation"));
});

Deno.test("CLAUDE.md reason vocabulary includes no-pages", async () => {
  const content = await Deno.readTextFile(
    new URL("../CLAUDE.md", import.meta.url).pathname,
  );
  assertStringIncludes(content, "no-pages");
});

Deno.test(
  "TickService: deadline exceeded logs tick-deadline-exceeded, notifies, and exits 1",
  async () => {
    const captured: object[] = [];
    const notifyTickFailureSpy = spy((_msg: string) => Promise.resolve());
    const exitSpy = spy((_code: number) => {});
    const deps = makeTickServiceDeps({
      deadlineMs: 1,
      lock: { withLock: (fn) => fn() },
      preflightGitHubCredentials: () => new Promise<void>(() => {}),
      appendTickLog: (entry) => {
        captured.push(entry);
        return Promise.resolve();
      },
      notifyTickFailure: notifyTickFailureSpy,
      exit: exitSpy,
    });
    await new TickService(deps).run();
    assertArrayIncludes(captured, [
      { event: "tick-deadline-exceeded", deadlineMs: 1 },
    ]);
    assertSpyCalls(notifyTickFailureSpy, 1);
    assertSpyCall(exitSpy, 0, { args: [1] });
  },
);

Deno.test(
  "TickService: CorruptRepoIdentitiesError skips capture, advance still runs, logs repo-identity-unavailable",
  async () => {
    using lb = withLazyboyDir();
    let fetchNewCalled = false;
    let migratesCalled = false;

    const ticket = makeTicket({ phase: "intake", status: "waiting" });

    await new TickService(makeTickServiceDeps({
      reconcileRepoIdentities: () =>
        Promise.reject(new CorruptRepoIdentitiesError("bad table")),
      providers: [{
        fetchNew: () => {
          fetchNewCalled = true;
          return Promise.resolve([]);
        },
      } as unknown as Provider],
      listTickets: () => Promise.resolve([ticket.id]),
      readTicket: () => Promise.resolve(ticket),
      runMigrations: (_dir, tickets) => {
        migratesCalled = true;
        return Promise.resolve(tickets);
      },
    })).run();

    assertFalse(fetchNewCalled);
    assert(migratesCalled);
    const log = await Deno.readTextFile(join(lb.path, "tick.ndjson"));
    assertStringIncludes(log, '"repo-identity-unavailable"');
  },
);
