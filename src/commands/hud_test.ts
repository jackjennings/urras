import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertExists,
  assertFalse,
  assertGreater,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { dim, stripAnsiCode } from "@std/fmt/colors";
import { assertSpyCalls, spy } from "@std/testing/mock";
import type { TicketState } from "../state/types.ts";
import {
  formatHudHeader,
  formatTickLogLine,
  handleRootWatcherEvent,
  handleTicketWatcherEvent,
  HUD_CHROME_ROWS,
  hudAutocompleteProvider,
  type HudWatcherDeps,
  isBlockedCommand,
  loadTicketEntry,
  logPaneLines,
  openLogWatch,
  paneHeights,
  parseCommand,
  readTickLog,
  TICK_LOG_TAIL_LINES,
  type TicketEntry,
} from "./hud.ts";

// ── formatTickLogLine ─────────────────────────────────────────────────────────

Deno.test("formatTickLogLine: formats time", () => {
  const line = formatTickLogLine(
    '{"ts":"2026-07-29T12:00:00Z","event":"tick-failed","error":"oh no"}',
  );
  assertMatch(stripAnsiCode(line), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assertStringIncludes(line, "tick-failed");
  assertStringIncludes(line, "error=oh no");
});

Deno.test("formatTickLogLine: excludes ts and event from key=value pairs", () => {
  const line = formatTickLogLine(
    '{"ts":"2026-07-29T12:00:00Z","event":"tick-failed"}',
  );
  assertFalse(line.includes("ts="));
  assertFalse(line.includes("event="));
});

Deno.test("formatTickLogLine: no trailing key=value when no extra fields", () => {
  const line = formatTickLogLine(
    '{"ts":"2026-07-29T12:00:00Z","event":"tick-already-running"}',
  );
  const parts = line.trim().split(" ");
  assertEquals(parts.length, 3); // timestamp + event
});

Deno.test("formatTickLogLine: returns verbatim string on JSON parse failure", () => {
  assertEquals(formatTickLogLine("not json"), "not json");
});

Deno.test("formatTickLogLine: renders id field from combined log entry", () => {
  const line = formatTickLogLine(
    '{"ts":"2026-07-29T12:00:00Z","id":"github/jackjennings/lazyboy/258","event":"status-transition","from":"new","to":"running"}',
  );
  assertStringIncludes(line, "status-transition");
  assertStringIncludes(line, "github/jackjennings/lazyboy/258");
  assertStringIncludes(line, "from=new");
});

Deno.test("formatTickLogLine: renders id second", () => {
  const line = formatTickLogLine(
    '{"ts":"2026-07-29T12:00:00Z","id":"github/jackjennings/lazyboy/258","event":"tick-already-running"}',
  );
  assertEquals(
    stripAnsiCode(line).split(" ", 3)[1],
    "github/jackjennings/lazyboy/258",
  );
});

Deno.test("formatTickLogLine: renders context with event", () => {
  const line = formatTickLogLine(
    '{"ts":"2026-07-29T12:00:00Z","id":"github/jackjennings/lazyboy/258","event":"failure","context":"agent"}',
  );
  assertEquals(line.split(" ", 3)[2], "agent/failure");
});

// ── formatHudHeader ───────────────────────────────────────────────────────────

Deno.test("formatHudHeader: shows enabled badge when enabled is true", () => {
  const line = formatHudHeader(true, 2, 5);
  assertStringIncludes(stripAnsiCode(line), "enabled");
  assertStringIncludes(line, "2/5 running");
});

Deno.test("formatHudHeader: shows disabled badge when enabled is false", () => {
  const line = formatHudHeader(false, 0, 5);
  assertStringIncludes(stripAnsiCode(line), "disabled");
  assertStringIncludes(line, "0/5 running");
});

Deno.test("formatHudHeader: appends progress string when provided", () => {
  const line = formatHudHeader(true, 2, 5, "Reconciling PRs [3/47]");
  assertStringIncludes(stripAnsiCode(line), "2/5 running");
  assertStringIncludes(stripAnsiCode(line), "Reconciling PRs [3/47]");
});

Deno.test("formatHudHeader: does not append progress when absent", () => {
  const withoutProgress = formatHudHeader(true, 2, 5);
  assertFalse(stripAnsiCode(withoutProgress).includes("["));
  assertStringIncludes(stripAnsiCode(withoutProgress), "2/5 running");
});

Deno.test("formatHudHeader: does not append progress when empty string", () => {
  const withEmpty = formatHudHeader(true, 2, 5, "");
  const withoutProgress = formatHudHeader(true, 2, 5);
  assertEquals(withEmpty, withoutProgress);
});

// ── logPaneLines ──────────────────────────────────────────────────────────────

Deno.test("logPaneLines: returns dim placeholder when lines is empty", () => {
  assertEquals(logPaneLines([]), [dim("(no logs)")]);
});

Deno.test("logPaneLines: passes through non-empty lines unchanged", () => {
  const lines = ["12:00:00 tick-failed"];
  assertEquals(logPaneLines(lines), lines);
});

// ── openLogWatch ──────────────────────────────────────────────────────────────

Deno.test("openLogWatch: resolves when log.ndjson does not exist", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const watcher = await openLogWatch(tmpDir);
    watcher.close();
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ── paneHeights ───────────────────────────────────────────────────────────────

Deno.test("paneHeights: panes plus chrome and input fill the terminal exactly", () => {
  for (const rows of [24, 25, 40, 51, 120]) {
    for (const inputRows of [3, 7]) {
      const { status, log } = paneHeights({ rows, inputRows });
      assertEquals(status + log + inputRows + HUD_CHROME_ROWS, rows);
    }
  }
});

Deno.test("paneHeights: splits the remaining rows evenly", () => {
  assertEquals(paneHeights({ rows: 24, inputRows: 3 }), { status: 9, log: 9 });
});

Deno.test("paneHeights: gives the odd row to the status pane", () => {
  assertEquals(paneHeights({ rows: 25, inputRows: 3 }), { status: 10, log: 9 });
});

Deno.test("paneHeights: shrinks the panes as the input grows", () => {
  assertEquals(paneHeights({ rows: 24, inputRows: 6 }), { status: 8, log: 7 });
});

Deno.test("paneHeights: keeps both panes at least one row on a tiny terminal", () => {
  const { status, log } = paneHeights({ rows: 4, inputRows: 3 });
  assertGreater(status, 0);
  assertGreater(log, 0);
});

// ── readTickLog ───────────────────────────────────────────────────────────────

async function writeTickLog(count: number): Promise<string> {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "log.ndjson");
  const lines = Array.from(
    { length: count },
    (_, i) =>
      `{"ts":"2026-07-29T12:00:00Z","event":"tick-failed","index":${i}}`,
  );
  await Deno.writeTextFile(path, lines.join("\n") + "\n");
  return path;
}

Deno.test("readTickLog: returns no lines when the file is missing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await readTickLog(join(dir, "log.ndjson")), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readTickLog: returns every line for a short log", async () => {
  const path = await writeTickLog(3);
  try {
    const lines = await readTickLog(path);
    assertEquals(lines.length, 3);
    assertStringIncludes(lines[0], "index=0");
  } finally {
    await Deno.remove(dirname(path), { recursive: true });
  }
});

Deno.test("readTickLog: caps a long log at the tail line limit", async () => {
  const path = await writeTickLog(TICK_LOG_TAIL_LINES + 500);
  try {
    const lines = await readTickLog(path);
    assertEquals(lines.length, TICK_LOG_TAIL_LINES);
  } finally {
    await Deno.remove(dirname(path), { recursive: true });
  }
});

Deno.test("readTickLog: keeps the most recent lines of a long log", async () => {
  const total = TICK_LOG_TAIL_LINES + 500;
  const path = await writeTickLog(total);
  try {
    const lines = await readTickLog(path);
    assertStringIncludes(lines[lines.length - 1], `index=${total - 1}`);
  } finally {
    await Deno.remove(dirname(path), { recursive: true });
  }
});

Deno.test("readTickLog: drops the partial line at a byte-truncated tail", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "log.ndjson");
  try {
    const filler = Array.from(
      { length: 40 },
      (_, i) =>
        `{"ts":"2026-07-29T12:00:00Z","event":"tick-failed","pad":"${
          "x".repeat(20_000)
        }","index":${i}}`,
    );
    await Deno.writeTextFile(path, filler.join("\n") + "\n");
    const lines = await readTickLog(path);
    for (const line of lines) {
      assertFalse(line.includes("�"));
      assertStringIncludes(line, "index=");
    }
    assertGreater(lines.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── isBlockedCommand ──────────────────────────────────────────────────────────

Deno.test("isBlockedCommand: returns true for hud", () => {
  assert(isBlockedCommand("hud"));
});

Deno.test("isBlockedCommand: returns true for shell", () => {
  assert(isBlockedCommand("shell"));
});

Deno.test("isBlockedCommand: returns true for tail", () => {
  assert(isBlockedCommand("tail"));
});

Deno.test("isBlockedCommand: returns true for review", () => {
  assert(isBlockedCommand("review"));
});

Deno.test("isBlockedCommand: returns false for approve", () => {
  assertFalse(isBlockedCommand("approve"));
});

Deno.test("isBlockedCommand: returns false for decline", () => {
  assertFalse(isBlockedCommand("decline"));
});

// ── parseCommand ──────────────────────────────────────────────────────────────

Deno.test("parseCommand: returns null for empty string", () => {
  assertEquals(parseCommand(""), null);
});

Deno.test("parseCommand: returns null for whitespace-only string", () => {
  assertEquals(parseCommand("  "), null);
});

Deno.test("parseCommand: returns name with empty args for single token", () => {
  assertEquals(parseCommand("approve"), { name: "approve", args: [] });
});

Deno.test("parseCommand: splits name and single arg", () => {
  assertEquals(parseCommand("approve id123"), {
    name: "approve",
    args: ["id123"],
  });
});

Deno.test("parseCommand: splits multiple args ignoring extra whitespace", () => {
  assertEquals(parseCommand("approve  id1  id2"), {
    name: "approve",
    args: ["id1", "id2"],
  });
});

// ── hudAutocompleteProvider ───────────────────────────────────────────────────

const fakeCommands = [
  {
    name: "approve",
    description: "approve a ticket",
    completesWith: "_ids" as const,
  },
  {
    name: "decline",
    description: "decline a ticket",
    completesWith: "_ids" as const,
  },
  {
    name: "completion",
    description: "print completion",
    completesWith: ["zsh"],
  },
  { name: "tick", description: "run tick" },
  { name: "_completions", description: "internal" },
  { name: "hud", description: "blocked" },
  { name: "shell", description: "blocked" },
];

const fakeTickets = [
  "github/jackjennings/lazyboy/1",
  "github/jackjennings/lazyboy/2",
];

function makeProvider() {
  return hudAutocompleteProvider({
    commands: fakeCommands,
    listTickets: () => Promise.resolve(fakeTickets),
  });
}

const abortSignal = new AbortController().signal;

Deno.test("hudAutocompleteProvider: suggests unblocked, non-underscore commands for token 1", async () => {
  const provider = makeProvider();
  const result = await provider.getSuggestions(["app"], 0, 3, {
    signal: abortSignal,
  });
  assertExists(result);
  const names = result.items.map((i) => i.value);
  assertArrayIncludes(names, ["approve"]);
  assertFalse(names.includes("hud"));
  assertFalse(names.includes("shell"));
  assertFalse(names.includes("_completions"));
  assertEquals(result.prefix, "app");
});

Deno.test("hudAutocompleteProvider: returns null for token 1 when no commands", async () => {
  const provider = hudAutocompleteProvider({
    commands: [],
    listTickets: () => Promise.resolve([]),
  });
  const result = await provider.getSuggestions(["x"], 0, 1, {
    signal: abortSignal,
  });
  assertExists(result);
  assertEquals(result.items, []);
});

Deno.test("hudAutocompleteProvider: returns ticket IDs for token 2 on _ids command", async () => {
  const provider = makeProvider();
  const result = await provider.getSuggestions(["approve "], 0, 8, {
    signal: abortSignal,
  });
  assertExists(result);
  assertEquals(result.items.map((i) => i.value), fakeTickets);
  assertEquals(result.prefix, "");
});

Deno.test("hudAutocompleteProvider: filters ticket IDs by partial token", async () => {
  const provider = makeProvider();
  const result = await provider.getSuggestions(["approve github/j"], 0, 15, {
    signal: abortSignal,
  });
  assertExists(result);
  assertEquals(result.prefix, "github/j");
  assertEquals(result.items.map((i) => i.value), fakeTickets);
});

Deno.test("hudAutocompleteProvider: returns literal list for string[] completesWith", async () => {
  const provider = makeProvider();
  const result = await provider.getSuggestions(["completion "], 0, 11, {
    signal: abortSignal,
  });
  assertExists(result);
  assertEquals(result.items.map((i) => i.value), ["zsh"]);
  assertEquals(result.prefix, "");
});

Deno.test("hudAutocompleteProvider: returns null for command with no completesWith", async () => {
  const provider = makeProvider();
  const result = await provider.getSuggestions(["tick "], 0, 5, {
    signal: abortSignal,
  });
  assertEquals(result, null);
});

Deno.test("hudAutocompleteProvider: returns null for unknown command at token 2", async () => {
  const provider = makeProvider();
  const result = await provider.getSuggestions(["unknown "], 0, 8, {
    signal: abortSignal,
  });
  assertEquals(result, null);
});

Deno.test("hudAutocompleteProvider: returns null when signal is already aborted", async () => {
  const provider = makeProvider();
  const controller = new AbortController();
  controller.abort();
  const result = await provider.getSuggestions(["approve "], 0, 8, {
    signal: controller.signal,
  });
  assertEquals(result, null);
});

Deno.test("hudAutocompleteProvider: applyCompletion replaces prefix before cursor", () => {
  const provider = makeProvider();
  const result = provider.applyCompletion(
    ["app"],
    0,
    3,
    { value: "approve", label: "approve" },
    "app",
  );
  assertEquals(result, { lines: ["approve"], cursorLine: 0, cursorCol: 7 });
});

Deno.test("hudAutocompleteProvider: applyCompletion handles token-2 replacement", () => {
  const provider = makeProvider();
  const result = provider.applyCompletion(
    ["approve github/j"],
    0,
    16,
    {
      value: "github/jackjennings/lazyboy/1",
      label: "github/jackjennings/lazyboy/1",
    },
    "github/j",
  );
  assertEquals(result, {
    lines: ["approve github/jackjennings/lazyboy/1"],
    cursorLine: 0,
    cursorCol: 37,
  });
});

// ── handleTicketWatcherEvent ──────────────────────────────────────────────────

Deno.test(
  "handleTicketWatcherEvent: re-reads only the changed ticket",
  async () => {
    const tmpDir = await Deno.makeTempDir();
    try {
      const idA = "github/org/repo/1";
      const idB = "github/org/repo/2";
      const fakeEntry = (id: string): TicketEntry => ({
        ok: true,
        ticket: { id } as unknown as TicketState,
        tokens: null,
        alive: false,
      });
      const ticketMap = new Map<string, TicketEntry>([
        [idA, fakeEntry(idA)],
        [idB, fakeEntry(idB)],
      ]);
      const ticketDirMap = new Map<string, string>([
        [join(tmpDir, idA), idA],
        [join(tmpDir, idB), idB],
      ]);
      const readTicketImpl = (_s: string, id: string) =>
        Promise.resolve({ id } as unknown as TicketState);
      const readTicketSpy = spy(readTicketImpl);
      let refreshCalled = false;
      const deps: HudWatcherDeps = {
        readTicketFn: readTicketSpy,
        readTicketTokensFn: () => Promise.resolve(null),
        isPhaseAliveFn: () => false,
      };

      await handleTicketWatcherEvent({
        stateDir: tmpDir,
        eventPath: join(tmpDir, idA, "meta.md"),
        ticketMap,
        ticketDirMap,
        deps,
        scheduleRefresh: () => {
          refreshCalled = true;
        },
      });

      assertSpyCalls(readTicketSpy, 1);
      assertEquals(readTicketSpy.calls[0].args[1], idA);
      assert(refreshCalled);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "handleTicketWatcherEvent: discards event outside any known ticket dir",
  async () => {
    const tmpDir = await Deno.makeTempDir();
    try {
      const idA = "github/org/repo/1";
      const ticketMap = new Map<string, TicketEntry>([
        [
          idA,
          {
            ok: true,
            ticket: { id: idA } as unknown as TicketState,
            tokens: null,
            alive: false,
          },
        ],
      ]);
      const ticketDirMap = new Map<string, string>([
        [join(tmpDir, idA), idA],
      ]);
      const readTicketSpy = spy((_s: string, id: string) =>
        Promise.resolve({ id } as unknown as TicketState)
      );
      let refreshCalled = false;
      const deps: HudWatcherDeps = {
        readTicketFn: readTicketSpy,
        readTicketTokensFn: () => Promise.resolve(null),
        isPhaseAliveFn: () => false,
      };

      await handleTicketWatcherEvent({
        stateDir: tmpDir,
        eventPath: join(tmpDir, ".git", "index"),
        ticketMap,
        ticketDirMap,
        deps,
        scheduleRefresh: () => {
          refreshCalled = true;
        },
      });

      assertSpyCalls(readTicketSpy, 0);
      assertFalse(refreshCalled);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

// ── handleRootWatcherEvent ────────────────────────────────────────────────────

Deno.test(
  "handleRootWatcherEvent: adds newly appearing ticket to map and starts watcher",
  async () => {
    const tmpDir = await Deno.makeTempDir();
    try {
      const idA = "github/org/repo/1";
      const idB = "github/org/repo/2";

      await Deno.mkdir(join(tmpDir, idA), { recursive: true });
      await Deno.mkdir(join(tmpDir, idB), { recursive: true });
      await Deno.writeTextFile(join(tmpDir, idA, "meta.md"), "---\n---\n");
      await Deno.writeTextFile(join(tmpDir, idB, "meta.md"), "---\n---\n");

      const ticketMap = new Map<string, TicketEntry>([
        [
          idA,
          {
            ok: true,
            ticket: { id: idA } as unknown as TicketState,
            tokens: null,
            alive: false,
          },
        ],
      ]);
      const ticketDirMap = new Map<string, string>([
        [join(tmpDir, idA), idA],
      ]);
      const watchers = new Set<Deno.FsWatcher>();
      let refreshCalled = false;
      const readTicketSpy = spy((_s: string, id: string) =>
        Promise.resolve({ id } as unknown as TicketState)
      );
      const deps: HudWatcherDeps = {
        readTicketFn: readTicketSpy,
        readTicketTokensFn: () => Promise.resolve(null),
        isPhaseAliveFn: () => false,
      };

      await handleRootWatcherEvent({
        stateDir: tmpDir,
        ticketMap,
        ticketDirMap,
        watchers,
        deps,
        scheduleRefresh: () => {
          refreshCalled = true;
        },
      });

      assert(ticketMap.has(idB));
      assert(ticketDirMap.has(join(tmpDir, idB)));
      assertEquals(watchers.size, 1);
      assert(refreshCalled);
      assertSpyCalls(readTicketSpy, 1);
      assertEquals(readTicketSpy.calls[0].args[1], idB);

      for (const w of watchers) w.close();
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "handleRootWatcherEvent: removes deleted ticket from maps",
  async () => {
    const tmpDir = await Deno.makeTempDir();
    try {
      const idA = "github/org/repo/1";

      await Deno.mkdir(join(tmpDir, idA), { recursive: true });
      await Deno.writeTextFile(join(tmpDir, idA, "meta.md"), "---\n---\n");

      const idGone = "github/org/repo/99";
      const ticketMap = new Map<string, TicketEntry>([
        [
          idA,
          {
            ok: true,
            ticket: { id: idA } as unknown as TicketState,
            tokens: null,
            alive: false,
          },
        ],
        [
          idGone,
          {
            ok: true,
            ticket: { id: idGone } as unknown as TicketState,
            tokens: null,
            alive: false,
          },
        ],
      ]);
      const ticketDirMap = new Map<string, string>([
        [join(tmpDir, idA), idA],
        [join(tmpDir, idGone), idGone],
      ]);
      const watchers = new Set<Deno.FsWatcher>();
      const deps: HudWatcherDeps = {
        readTicketFn: (_s: string, id: string) =>
          Promise.resolve({ id } as unknown as TicketState),
        readTicketTokensFn: () => Promise.resolve(null),
        isPhaseAliveFn: () => false,
      };

      await handleRootWatcherEvent({
        stateDir: tmpDir,
        ticketMap,
        ticketDirMap,
        watchers,
        deps,
        scheduleRefresh: () => {},
      });

      assertFalse(ticketMap.has(idGone));
      assertFalse(ticketDirMap.has(join(tmpDir, idGone)));

      for (const w of watchers) w.close();
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

// ── loadTicketEntry ───────────────────────────────────────────────────────────

Deno.test(
  "loadTicketEntry: returns ok entry when readTicket succeeds",
  async () => {
    const deps: HudWatcherDeps = {
      readTicketFn: (_s: string, id: string) =>
        Promise.resolve({ id } as unknown as TicketState),
      readTicketTokensFn: () => Promise.resolve(42),
      isPhaseAliveFn: () => true,
    };
    const entry = await loadTicketEntry("/state", "github/org/repo/1", deps);
    assert(entry.ok);
    if (entry.ok) {
      assertEquals(entry.tokens, 42);
      assert(entry.alive);
    }
  },
);

Deno.test(
  "loadTicketEntry: returns error entry when readTicket throws",
  async () => {
    const deps: HudWatcherDeps = {
      readTicketFn: () => Promise.reject(new Error("parse failed")),
      readTicketTokensFn: () => Promise.resolve(null),
      isPhaseAliveFn: () => false,
    };
    const entry = await loadTicketEntry("/state", "github/org/repo/1", deps);
    assertFalse(entry.ok);
    if (!entry.ok) {
      assertStringIncludes(entry.error, "parse failed");
    }
  },
);
