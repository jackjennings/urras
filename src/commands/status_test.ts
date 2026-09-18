import {
  assert,
  assertEquals,
  assertFalse,
  assertGreater,
  assertLess,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { green, red, stripAnsiCode, yellow } from "@std/fmt/colors";
import { STATUS_SEQUENCE } from "../state/types.ts";
import type { TicketStatus } from "../state/types.ts";
import { makeTicket } from "../test-support.ts";
import {
  buildPhaseBreakdown,
  compareTickets,
  formatBrokenRow,
  formatDetailView,
  formatPhaseBreakdown,
  formatStatusHeader,
  formatStatusRow,
  formatTokens,
  type PhaseRow,
  readAllTicketUsage,
  readAttentionReason,
  readTicketCost,
  readTicketTokens,
  shouldHideTicket,
  status,
} from "./status.ts";

// ── compareTickets ────────────────────────────────────────────────────────────

Deno.test("compareTickets: orders by status index within same phase", () => {
  const a = makeTicket({ phase: "spec", status: "new" });
  const b = makeTicket({ phase: "spec", status: "waiting" });
  assertLess(compareTickets(a, b), 0);
  assertGreater(compareTickets(b, a), 0);
});

Deno.test("compareTickets: phase difference overrides status", () => {
  const a = makeTicket({ phase: "intake", status: "needs-attention" });
  const b = makeTicket({ phase: "spec", status: "new" });
  assertLess(compareTickets(a, b), 0);
});

Deno.test("compareTickets: same phase and status orders by provider then id", () => {
  const a = makeTicket({
    phase: "spec",
    status: "running",
    provider: "github",
    id: "github/a/repo/1",
  });
  const b = makeTicket({
    phase: "spec",
    status: "running",
    provider: "github",
    id: "github/a/repo/2",
  });
  assertLess(compareTickets(a, b), 0);
});

Deno.test("compareTickets: unknown status sorts last within phase", () => {
  const a = makeTicket({ phase: "intake", status: "done" as TicketStatus });
  const b = makeTicket({
    phase: "intake",
    status: "unrecognized" as TicketStatus,
  });
  assertLess(compareTickets(a, b), 0);
});

// ── STATUS_SEQUENCE ───────────────────────────────────────────────────────────

Deno.test("STATUS_SEQUENCE is exported and ordered correctly", () => {
  assertEquals(STATUS_SEQUENCE[0], "new");
  assertEquals(STATUS_SEQUENCE[STATUS_SEQUENCE.length - 1], "done");
  assertLess(
    STATUS_SEQUENCE.indexOf("running"),
    STATUS_SEQUENCE.indexOf("waiting"),
  );
  assertLess(
    STATUS_SEQUENCE.indexOf("waiting"),
    STATUS_SEQUENCE.indexOf("revising"),
  );
  assertLess(
    STATUS_SEQUENCE.indexOf("revising"),
    STATUS_SEQUENCE.indexOf("needs-attention"),
  );
  assertLess(
    STATUS_SEQUENCE.indexOf("needs-attention"),
    STATUS_SEQUENCE.indexOf("done"),
  );
});

// ── formatTokens ─────────────────────────────────────────────────────────────

Deno.test("formatTokens: returns em-dash for null", () => {
  assertEquals(formatTokens(null), "—");
});

Deno.test("formatTokens: returns plain integer string for totals under 1000", () => {
  assertEquals(formatTokens(0), "0");
  assertEquals(formatTokens(999), "999");
  assertEquals(formatTokens(500), "500");
});

Deno.test("formatTokens: returns Xk with one decimal for totals >= 1000", () => {
  assertEquals(formatTokens(1000), "1.0k");
  assertEquals(formatTokens(3300), "3.3k");
  assertEquals(formatTokens(3350), "3.4k");
  assertEquals(formatTokens(10000), "10.0k");
});

// ── readTicketTokens ─────────────────────────────────────────────────────────

Deno.test("readTicketTokens: returns null when no usage files exist", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const result = await readTicketTokens(tempDir);
    assertEquals(result, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test(
  "readTicketTokens: sums all four token fields across all usage files",
  async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(tempDir, "20260715T190000-intake.usage.json"),
        JSON.stringify({
          durationMs: 1000,
          models: [{
            model: "claude-sonnet-4-6",
            input: 10,
            output: 5,
            cacheRead: 100,
            cacheWrite: 50,
          }],
        }),
      );
      await Deno.writeTextFile(
        join(tempDir, "20260715T192000-enrichment.usage.json"),
        JSON.stringify({
          durationMs: 2000,
          models: [{
            model: "claude-sonnet-4-6",
            input: 20,
            output: 8,
            cacheRead: 200,
            cacheWrite: 30,
          }],
        }),
      );
      const result = await readTicketTokens(tempDir);
      assertEquals(result, 10 + 5 + 100 + 50 + 20 + 8 + 200 + 30);
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "readTicketTokens: returns null when usage files cannot be parsed",
  async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(tempDir, "20260715T190000-intake.usage.json"),
        "not-json",
      );
      const result = await readTicketTokens(tempDir);
      assertEquals(result, null);
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test("readTicketTokens: ignores non-usage json files", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "meta.md"), "---\n---\n");
    await Deno.writeTextFile(
      join(tempDir, "20260715T190000-intake.usage.json"),
      JSON.stringify({
        durationMs: 500,
        models: [{
          model: "claude-sonnet-4-6",
          input: 5,
          output: 3,
          cacheRead: 20,
          cacheWrite: 10,
        }],
      }),
    );
    const result = await readTicketTokens(tempDir);
    assertEquals(result, 38);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ── formatStatusRow / formatStatusHeader ─────────────────────────────────────

Deno.test("formatStatusRow: pads ID field to 36 characters", () => {
  const row = formatStatusRow(
    " ",
    "github/jackjennings/lazyboy/23",
    "intake",
    "running",
    [],
    "0",
    "My ticket",
  );
  assert(row.startsWith("  github/jackjennings/lazyboy/23"));
});

Deno.test("formatStatusRow: held ticket shows tilde marker", () => {
  const row = formatStatusRow(
    "~",
    "github/a/repo/1",
    "intake",
    "waiting",
    [],
    "0",
    "t",
  );
  assert(row.startsWith("~ "));
});

Deno.test("formatStatusRow: prioritized ticket shows exclamation marker", () => {
  const row = formatStatusRow(
    "!",
    "github/a/repo/1",
    "intake",
    "waiting",
    [],
    "0",
    "t",
  );
  assert(row.startsWith("! "));
});

Deno.test("formatStatusRow: held-and-prioritized ticket shows tilde marker", () => {
  const row = formatStatusRow(
    "~",
    "github/a/repo/1",
    "intake",
    "waiting",
    [],
    "0",
    "t",
  );
  assert(row.startsWith("~ "));
});

Deno.test("formatStatusHeader: separator line is a full-width rule", () => {
  const lines = formatStatusHeader().split("\n");
  assertGreater(lines[1].length, 0);
  assertMatch(lines[1], /^─+$/);
});

Deno.test("formatStatusHeader: first line starts with two spaces for blank marker column", () => {
  const lines = formatStatusHeader().split("\n");
  assert(lines[0].startsWith("  "));
});

// ── shouldHideTicket ──────────────────────────────────────────────────────────

Deno.test("shouldHideTicket: returns true for merge/done", () => {
  assert(shouldHideTicket("merge", "done"));
});

Deno.test("shouldHideTicket: returns true for wont-do (any status)", () => {
  assert(shouldHideTicket("wont-do", "done"));
});

Deno.test("shouldHideTicket: returns false for merge/running", () => {
  assertFalse(shouldHideTicket("merge", "running"));
});

Deno.test("shouldHideTicket: returns false for active phases", () => {
  assertFalse(shouldHideTicket("intake", "running"));
  assertFalse(shouldHideTicket("implementation", "waiting"));
});

// ── readTicketCost ────────────────────────────────────────────────────────────

Deno.test("readTicketCost: returns null/false when no usage files exist", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const result = await readTicketCost(tempDir);
    assertEquals(result, { cost: null, partial: false });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test(
  "readTicketCost: returns null/false when usage files have no costUsd",
  async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(tempDir, "20260715T190000-intake.usage.json"),
        JSON.stringify({
          durationMs: 1000,
          models: [{
            model: "claude-sonnet-4-6",
            input: 10,
            output: 5,
            cacheRead: 100,
            cacheWrite: 50,
          }],
        }),
      );
      const result = await readTicketCost(tempDir);
      assertEquals(result, { cost: null, partial: false });
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "readTicketCost: returns summed cost/false when all files have costUsd",
  async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(tempDir, "20260715T190000-intake.usage.json"),
        JSON.stringify({
          durationMs: 1000,
          models: [{
            model: "claude-sonnet-4-6",
            input: 10,
            output: 5,
            cacheRead: 100,
            cacheWrite: 50,
            costUsd: 0.50,
          }],
        }),
      );
      await Deno.writeTextFile(
        join(tempDir, "20260715T192000-enrichment.usage.json"),
        JSON.stringify({
          durationMs: 2000,
          models: [{
            model: "claude-sonnet-4-6",
            input: 20,
            output: 8,
            cacheRead: 200,
            cacheWrite: 30,
            costUsd: 0.75,
          }],
        }),
      );
      const result = await readTicketCost(tempDir);
      assertEquals(result, { cost: 1.25, partial: false });
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "readTicketCost: returns partial sum/true when only some files have costUsd",
  async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(tempDir, "20260715T190000-intake.usage.json"),
        JSON.stringify({
          durationMs: 1000,
          models: [{
            model: "claude-sonnet-4-6",
            input: 10,
            output: 5,
            cacheRead: 100,
            cacheWrite: 50,
            costUsd: 0.50,
          }],
        }),
      );
      await Deno.writeTextFile(
        join(tempDir, "20260715T192000-enrichment.usage.json"),
        JSON.stringify({
          durationMs: 2000,
          models: [{
            model: "claude-sonnet-4-6",
            input: 20,
            output: 8,
            cacheRead: 200,
            cacheWrite: 30,
          }],
        }),
      );
      const result = await readTicketCost(tempDir);
      assertEquals(result, { cost: 0.50, partial: true });
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

// ── formatDetailView ──────────────────────────────────────────────────────────

Deno.test("formatDetailView: renders phase and status", () => {
  const ticket = makeTicket({ phase: "spec", status: "running" });
  const out = formatDetailView(ticket, null, { cost: null, partial: false });
  assert(out.startsWith("Phase    spec\nStatus   running\n"));
});

Deno.test("formatDetailView: renders em-dash for null tokens", () => {
  const ticket = makeTicket({});
  const out = formatDetailView(ticket, null, { cost: null, partial: false });
  assertStringIncludes(out, "Tokens   —");
});

Deno.test("formatDetailView: renders formatted token count", () => {
  const ticket = makeTicket({});
  const out = formatDetailView(ticket, 902900, { cost: null, partial: false });
  assertStringIncludes(out, "Tokens   902.9k");
});

Deno.test("formatDetailView: renders em-dash when cost is null", () => {
  const ticket = makeTicket({});
  const out = formatDetailView(ticket, null, { cost: null, partial: false });
  assertStringIncludes(out, "Cost     —");
});

Deno.test("formatDetailView: renders $X.XX for full cost", () => {
  const ticket = makeTicket({});
  const out = formatDetailView(ticket, null, { cost: 1.23, partial: false });
  assertStringIncludes(out, "Cost     $1.23");
});

Deno.test("formatDetailView: renders ~$X.XX for partial cost", () => {
  const ticket = makeTicket({});
  const out = formatDetailView(ticket, null, { cost: 1.23, partial: true });
  assertStringIncludes(out, "Cost     ~$1.23");
});

Deno.test("formatDetailView: renders em-dash when prs is absent", () => {
  const ticket = makeTicket({ prs: undefined });
  const out = formatDetailView(ticket, null, { cost: null, partial: false });
  assertStringIncludes(out, "PRs      —");
});

Deno.test("formatDetailView: renders em-dash when prs is empty", () => {
  const ticket = makeTicket({ prs: [] });
  const out = formatDetailView(ticket, null, { cost: null, partial: false });
  assertStringIncludes(out, "PRs      —");
});

Deno.test("formatDetailView: renders single PR url on PRs line", () => {
  const ticket = makeTicket({
    prs: [{
      url: "https://github.com/a/b/pull/1",
      title: "t",
      dependsOn: [],
      merged: false,
    }],
  });
  const out = formatDetailView(ticket, null, { cost: null, partial: false });
  assertStringIncludes(out, "PRs      https://github.com/a/b/pull/1");
});

Deno.test(
  "formatDetailView: renders additional PR urls indented 9 spaces",
  () => {
    const ticket = makeTicket({
      prs: [
        {
          url: "https://github.com/a/b/pull/1",
          title: "t1",
          dependsOn: [],
          merged: false,
        },
        {
          url: "https://github.com/a/b/pull/2",
          title: "t2",
          dependsOn: [],
          merged: false,
        },
      ],
    });
    const out = formatDetailView(ticket, null, { cost: null, partial: false });
    assertStringIncludes(
      out,
      "PRs      https://github.com/a/b/pull/1\n         https://github.com/a/b/pull/2",
    );
  },
);

Deno.test(
  "formatStatusRow: renders shortTitle when ticket has one",
  () => {
    const ticket = makeTicket({
      title: "A very long full title for the issue",
      shortTitle: "Short label",
    });
    const row = formatStatusRow(
      " ",
      ticket.id,
      ticket.phase,
      ticket.status,
      ticket.approvals,
      "0",
      ticket.shortTitle ?? ticket.title,
    );
    assertStringIncludes(row, "Short label");
    assertFalse(row.includes("A very long full title for the issue"));
  },
);

Deno.test(
  "formatStatusRow: falls back to title when shortTitle is absent",
  () => {
    const ticket = makeTicket({ title: "Full title only" });
    const row = formatStatusRow(
      " ",
      ticket.id,
      ticket.phase,
      ticket.status,
      ticket.approvals,
      "0",
      ticket.shortTitle ?? ticket.title,
    );
    assertStringIncludes(row, "Full title only");
  },
);

// ── status.completesWith ──────────────────────────────────────────────────────

Deno.test("status command has completesWith set to _ids", () => {
  assertEquals(status.completesWith, "_ids");
});

// ── readAttentionReason ───────────────────────────────────────────────────────

Deno.test("readAttentionReason: returns null when log file is missing", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    assertEquals(await readAttentionReason(tempDir), null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("readAttentionReason: returns null when log has no matching events", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "log.ndjson"),
      JSON.stringify({
        ts: "2026-07-30T10:00:00Z",
        event: "phase-start",
        phase: "intake",
      }) + "\n",
    );
    assertEquals(await readAttentionReason(tempDir), null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("readAttentionReason: returns last matching entry when multiple exist", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "log.ndjson"),
      [
        JSON.stringify({
          ts: "2026-07-30T10:00:00Z",
          event: "needs-attention",
          reason: "clone-failed",
        }),
        JSON.stringify({
          ts: "2026-07-30T11:00:00Z",
          event: "phase-start",
          phase: "intake",
        }),
        JSON.stringify({
          ts: "2026-07-30T12:00:00Z",
          event: "needs-attention",
          reason: "worktree-creation-failed",
        }),
      ].join("\n") + "\n",
    );
    assertEquals(
      await readAttentionReason(tempDir),
      "2026-07-30T12:00:00Z: needs-attention: reason=worktree-creation-failed",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("readAttentionReason: formats phase-output-invalid with phase and reason", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "log.ndjson"),
      JSON.stringify({
        ts: "2026-07-30T16:41:11Z",
        event: "phase-output-invalid",
        phase: "intake",
        reason: "missing",
      }) + "\n",
    );
    assertEquals(
      await readAttentionReason(tempDir),
      "2026-07-30T16:41:11Z: phase-output-invalid: phase=intake, reason=missing",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("readAttentionReason: formats phase-transition to needs-attention with reason", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "log.ndjson"),
      JSON.stringify({
        ts: "2026-07-31T18:06:28Z",
        event: "phase-transition",
        from: "intake",
        to: "needs-attention",
        reason: "no-worktrees",
      }) + "\n",
    );
    assertEquals(
      await readAttentionReason(tempDir),
      "2026-07-31T18:06:28Z: phase-transition: reason=no-worktrees",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("readAttentionReason: ignores phase-transition not targeting needs-attention", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "log.ndjson"),
      JSON.stringify({
        ts: "2026-07-31T18:06:28Z",
        event: "phase-transition",
        from: "intake",
        to: "running",
        reason: "retry",
      }) + "\n",
    );
    assertEquals(await readAttentionReason(tempDir), null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("readAttentionReason: formats needs-attention event with reason", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "log.ndjson"),
      JSON.stringify({
        ts: "2026-07-31T18:06:28Z",
        event: "needs-attention",
        reason: "clone-failed",
      }) + "\n",
    );
    assertEquals(
      await readAttentionReason(tempDir),
      "2026-07-31T18:06:28Z: needs-attention: reason=clone-failed",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("readAttentionReason: formats conflict-resolution-failed with reason, branch, and sessionId", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "log.ndjson"),
      JSON.stringify({
        ts: "2026-07-31T19:45:22Z",
        event: "conflict-resolution-failed",
        reason: "agent-failed",
        branch: "github/jackjennings/lazyboy/271",
        worktreePath: "/some/long/path",
        sessionId: "sess_abc123",
      }) + "\n",
    );
    assertEquals(
      await readAttentionReason(tempDir),
      "2026-07-31T19:45:22Z: conflict-resolution-failed: reason=agent-failed, branch=github/jackjennings/lazyboy/271, sessionId=sess_abc123",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("readAttentionReason: formats conflict-resolution-failed without sessionId when absent", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "log.ndjson"),
      JSON.stringify({
        ts: "2026-07-31T19:45:22Z",
        event: "conflict-resolution-failed",
        reason: "agent-failed",
        branch: "github/jackjennings/lazyboy/271",
        worktreePath: "/some/long/path",
      }) + "\n",
    );
    assertEquals(
      await readAttentionReason(tempDir),
      "2026-07-31T19:45:22Z: conflict-resolution-failed: reason=agent-failed, branch=github/jackjennings/lazyboy/271",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("readAttentionReason: formats error/resolveCIFix with reason and runId", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "log.ndjson"),
      JSON.stringify({
        ts: "2026-07-31T20:00:00Z",
        event: "error",
        context: "resolveCIFix",
        reason: "output-file-missing",
        runId: "wf_abc123",
      }) + "\n",
    );
    assertEquals(
      await readAttentionReason(tempDir),
      "2026-07-31T20:00:00Z: error: reason=output-file-missing, runId=wf_abc123",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("readAttentionReason: ignores error events without resolveCIFix context", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "log.ndjson"),
      JSON.stringify({
        ts: "2026-07-31T20:00:00Z",
        event: "error",
        context: "other",
        reason: "something",
      }) + "\n",
    );
    assertEquals(await readAttentionReason(tempDir), null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("readAttentionReason: skips malformed JSON lines and continues scanning", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tempDir, "log.ndjson"),
      [
        "not-valid-json",
        JSON.stringify({
          ts: "2026-07-31T18:06:28Z",
          event: "needs-attention",
          reason: "clone-failed",
        }),
      ].join("\n") + "\n",
    );
    assertEquals(
      await readAttentionReason(tempDir),
      "2026-07-31T18:06:28Z: needs-attention: reason=clone-failed",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ── formatDetailView (Reason line) ────────────────────────────────────────────

Deno.test("formatDetailView: appends Reason line when attentionReason is provided", () => {
  const ticket = makeTicket({ status: "needs-attention" });
  const out = formatDetailView(
    ticket,
    null,
    { cost: null, partial: false },
    "2026-07-30T16:41:11Z: needs-attention: reason=clone-failed",
  );
  assertStringIncludes(
    out,
    "Reason   2026-07-30T16:41:11Z: needs-attention: reason=clone-failed",
  );
});

Deno.test("formatDetailView: omits Reason line when attentionReason is null", () => {
  const ticket = makeTicket({ status: "needs-attention" });
  const out = formatDetailView(
    ticket,
    null,
    { cost: null, partial: false },
    null,
  );
  assertFalse(out.includes("Reason"));
});

Deno.test("formatDetailView: omits Reason line when attentionReason is not passed", () => {
  const ticket = makeTicket({ status: "needs-attention" });
  const out = formatDetailView(ticket, null, { cost: null, partial: false });
  assertFalse(out.includes("Reason"));
});

Deno.test("formatDetailView: Reason is the last line", () => {
  const ticket = makeTicket({ status: "needs-attention" });
  const out = formatDetailView(
    ticket,
    null,
    { cost: null, partial: false },
    "2026-07-30T16:41:11Z: needs-attention: reason=clone-failed",
  );
  const lines = out.split("\n");
  assert(lines[lines.length - 1].startsWith("Reason"));
});

// ── formatDetailView (Approved line) ─────────────────────────────────────────

Deno.test("formatDetailView: renders em-dash for Approved when approvals is empty", () => {
  const ticket = makeTicket({ approvals: [] });
  const out = formatDetailView(ticket, null, { cost: null, partial: false });
  assertStringIncludes(out, "Approved —");
});

Deno.test(
  "formatDetailView: renders em-dash for Approved when last approval is for a different phase",
  () => {
    const ticket = makeTicket({
      phase: "spec",
      approvals: [{
        timestamp: "2026-08-17T20:00:00Z",
        actor: "human",
        phase: "intake",
      }],
    });
    const out = formatDetailView(ticket, null, { cost: null, partial: false });
    assertStringIncludes(out, "Approved —");
  },
);

Deno.test(
  "formatDetailView: renders actor for Approved when last approval matches current phase",
  () => {
    const ticket = makeTicket({
      phase: "spec",
      approvals: [{
        timestamp: "2026-08-17T20:00:00Z",
        actor: "human",
        phase: "spec",
      }],
    });
    const out = formatDetailView(ticket, null, { cost: null, partial: false });
    assertStringIncludes(out, "Approved human");
  },
);

Deno.test("formatDetailView: renders Approved between Status and Tokens", () => {
  const ticket = makeTicket({});
  const out = formatDetailView(ticket, null, { cost: null, partial: false });
  assert(
    out.indexOf("Approved") > out.indexOf("Status") &&
      out.indexOf("Tokens") > out.indexOf("Approved"),
  );
});

// ── buildPhaseBreakdown ────────────────────────────────────────────────────────

Deno.test("buildPhaseBreakdown: groups files by phase key and sums all token fields", () => {
  const rows = buildPhaseBreakdown([
    {
      name: "20260806T050000-intake.usage.json",
      usage: {
        durationMs: 0,
        models: [{
          model: "m",
          input: 10,
          output: 5,
          cacheRead: 100,
          cacheWrite: 50,
        }],
      },
    },
    {
      name: "20260806T160000-enrichment.usage.json",
      usage: {
        durationMs: 0,
        models: [{
          model: "m",
          input: 20,
          output: 8,
          cacheRead: 200,
          cacheWrite: 30,
        }],
      },
    },
  ]);
  assertEquals(rows.length, 2);
  assertEquals(rows[0].key, "intake");
  assertEquals(rows[0].tokens, 165);
  assertEquals(rows[0].revisions, 1);
  assertEquals(rows[1].key, "enrichment");
  assertEquals(rows[1].tokens, 258);
});

Deno.test(
  "buildPhaseBreakdown: normalizes ci-fix-* stems to ci-fix and counts revisions",
  () => {
    const rows = buildPhaseBreakdown([
      {
        name: "20260806T050000-ci-fix-wf_abc123.usage.json",
        usage: {
          durationMs: 0,
          models: [{
            model: "m",
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
          }],
        },
      },
      {
        name: "20260806T160000-ci-fix-wf_xyz789.usage.json",
        usage: {
          durationMs: 0,
          models: [{
            model: "m",
            input: 20,
            output: 8,
            cacheRead: 0,
            cacheWrite: 0,
          }],
        },
      },
    ]);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].key, "ci-fix");
    assertEquals(rows[0].revisions, 2);
    assertEquals(rows[0].tokens, 43);
  },
);

Deno.test("buildPhaseBreakdown: sums turns across files in a group", () => {
  const rows = buildPhaseBreakdown([
    {
      name: "20260806T050000-implementation.usage.json",
      usage: {
        durationMs: 0,
        turns: 4,
        models: [{
          model: "m",
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
        }],
      },
    },
    {
      name: "20260806T160000-implementation.usage.json",
      usage: {
        durationMs: 0,
        turns: 6,
        models: [{
          model: "m",
          input: 20,
          output: 8,
          cacheRead: 0,
          cacheWrite: 0,
        }],
      },
    },
  ]);
  assertEquals(rows[0].turns, 10);
});

Deno.test("buildPhaseBreakdown: turns is null when no file in the group defines it", () => {
  const rows = buildPhaseBreakdown([
    {
      name: "20260806T050000-intake.usage.json",
      usage: {
        durationMs: 0,
        models: [{
          model: "m",
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
        }],
      },
    },
  ]);
  assertEquals(rows[0].turns, null);
});

Deno.test(
  "buildPhaseBreakdown: files without turns contribute 0 when a sibling defines it",
  () => {
    const rows = buildPhaseBreakdown([
      {
        name: "20260806T050000-implementation.usage.json",
        usage: {
          durationMs: 0,
          turns: 4,
          models: [{
            model: "m",
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
          }],
        },
      },
      {
        name: "20260806T160000-implementation.usage.json",
        usage: {
          durationMs: 0,
          models: [{
            model: "m",
            input: 20,
            output: 8,
            cacheRead: 0,
            cacheWrite: 0,
          }],
        },
      },
    ]);
    assertEquals(rows[0].turns, 4);
  },
);

Deno.test(
  "buildPhaseBreakdown: orders pipeline phases before background phases before unknown",
  () => {
    const rows = buildPhaseBreakdown([
      {
        name: "20260806T160000-ci-fix-wf_x.usage.json",
        usage: {
          durationMs: 0,
          models: [{
            model: "m",
            input: 5,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
          }],
        },
      },
      {
        name: "20260806T050000-intake.usage.json",
        usage: {
          durationMs: 0,
          models: [{
            model: "m",
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
          }],
        },
      },
      {
        name: "20260806T070000-custom-phase.usage.json",
        usage: {
          durationMs: 0,
          models: [{
            model: "m",
            input: 3,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
          }],
        },
      },
    ]);
    assertEquals(rows[0].key, "intake");
    assertEquals(rows[1].key, "ci-fix");
    assertEquals(rows[2].key, "custom-phase");
  },
);

Deno.test(
  "buildPhaseBreakdown: orders FULL_PHASE_SEQUENCE phases in their canonical order",
  () => {
    const rows = buildPhaseBreakdown([
      {
        name: "20260806T160000-spec.usage.json",
        usage: {
          durationMs: 0,
          models: [{
            model: "m",
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
          }],
        },
      },
      {
        name: "20260806T050000-intake.usage.json",
        usage: {
          durationMs: 0,
          models: [{
            model: "m",
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
          }],
        },
      },
      {
        name: "20260806T070000-enrichment.usage.json",
        usage: {
          durationMs: 0,
          models: [{
            model: "m",
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
          }],
        },
      },
    ]);
    assertEquals(rows.map((r) => r.key), ["intake", "enrichment", "spec"]);
  },
);

// ── formatPhaseBreakdown ───────────────────────────────────────────────────────

Deno.test("formatPhaseBreakdown: emits Phases: header and one row per entry", () => {
  const rows: PhaseRow[] = [
    { key: "intake", tokens: 88400, turns: 4, revisions: 1 },
  ];
  const out = formatPhaseBreakdown(rows);
  assert(out.startsWith("Phases:"));
  assertStringIncludes(out, "intake");
});

Deno.test("formatPhaseBreakdown: shows turn count and singular revision", () => {
  const rows: PhaseRow[] = [
    { key: "intake", tokens: 88400, turns: 4, revisions: 1 },
  ];
  const out = formatPhaseBreakdown(rows);
  assertStringIncludes(out, "4 turns");
  assertStringIncludes(out, "1 revision");
  assertFalse(out.includes("1 revisions"));
});

Deno.test("formatPhaseBreakdown: shows em-dash for turns when null", () => {
  const rows: PhaseRow[] = [
    { key: "intake", tokens: 88400, turns: null, revisions: 1 },
  ];
  const out = formatPhaseBreakdown(rows);
  assertStringIncludes(out, "—");
});

Deno.test("formatPhaseBreakdown: shows plural revisions for N > 1", () => {
  const rows: PhaseRow[] = [
    { key: "implementation", tokens: 500000, turns: 10, revisions: 2 },
  ];
  const out = formatPhaseBreakdown(rows);
  assertStringIncludes(out, "2 revisions");
});

Deno.test("formatPhaseBreakdown: right-aligns tokens in a 6-character field", () => {
  const rows: PhaseRow[] = [
    { key: "intake", tokens: 88400, turns: 4, revisions: 1 },
    { key: "enrichment", tokens: 675100, turns: 23, revisions: 1 },
  ];
  const out = formatPhaseBreakdown(rows);
  const lines = out.split("\n");
  assertStringIncludes(lines[1], " 88.4k");
  assertStringIncludes(lines[2], "675.1k");
});

Deno.test("formatPhaseBreakdown: returns empty string for empty input", () => {
  assertEquals(formatPhaseBreakdown([]), "");
});

// ── formatDetailView (phase breakdown) ───────────────────────────────────────

Deno.test(
  "formatDetailView: appends Phases section after existing fields when breakdown is provided",
  () => {
    const ticket = makeTicket({ phase: "spec", status: "running" });
    const rows: PhaseRow[] = [
      { key: "intake", tokens: 88400, turns: 4, revisions: 1 },
      { key: "enrichment", tokens: 675100, turns: 23, revisions: 1 },
    ];
    const out = formatDetailView(
      ticket,
      763500,
      { cost: null, partial: false },
      null,
      rows,
    );
    assertStringIncludes(out, "Phases:");
    assertStringIncludes(out, "intake");
    assertStringIncludes(out, "enrichment");
  },
);

Deno.test("formatDetailView: omits Phases section when phaseBreakdown is null", () => {
  const ticket = makeTicket({});
  const out = formatDetailView(
    ticket,
    null,
    { cost: null, partial: false },
    null,
    null,
  );
  assertFalse(out.includes("Phases:"));
});

Deno.test(
  "formatDetailView: omits Phases section when phaseBreakdown is empty array",
  () => {
    const ticket = makeTicket({});
    const out = formatDetailView(
      ticket,
      null,
      { cost: null, partial: false },
      null,
      [],
    );
    assertFalse(out.includes("Phases:"));
  },
);

Deno.test(
  "formatDetailView: omits Phases section when phaseBreakdown is not passed",
  () => {
    const ticket = makeTicket({});
    const out = formatDetailView(ticket, null, { cost: null, partial: false });
    assertFalse(out.includes("Phases:"));
  },
);

Deno.test(
  "formatDetailView: Phases section appears after Reason line when both are present",
  () => {
    const ticket = makeTicket({ status: "needs-attention" });
    const rows: PhaseRow[] = [
      { key: "intake", tokens: 100, turns: 2, revisions: 1 },
    ];
    const out = formatDetailView(
      ticket,
      null,
      { cost: null, partial: false },
      "2026-08-06T00:00:00Z: needs-attention: reason=clone-failed",
      rows,
    );
    const reasonIdx = out.indexOf("Reason");
    const phasesIdx = out.indexOf("Phases:");
    assertGreater(phasesIdx, reasonIdx);
  },
);

// ── readAllTicketUsage ────────────────────────────────────────────────────────

Deno.test(
  "readAllTicketUsage: returns null for all fields when no usage files exist",
  async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      const result = await readAllTicketUsage(tempDir);
      assertEquals(result.tokens, null);
      assertEquals(result.costResult, { cost: null, partial: false });
      assertEquals(result.phaseBreakdown, null);
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "readAllTicketUsage: computes tokens, cost, and breakdown from one scan",
  async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(tempDir, "20260806T050000-intake.usage.json"),
        JSON.stringify({
          durationMs: 1000,
          turns: 4,
          models: [{
            model: "claude-sonnet-4-6",
            input: 10,
            output: 5,
            cacheRead: 100,
            cacheWrite: 50,
            costUsd: 0.10,
          }],
        }),
      );
      await Deno.writeTextFile(
        join(tempDir, "20260806T160000-enrichment.usage.json"),
        JSON.stringify({
          durationMs: 2000,
          turns: 23,
          models: [{
            model: "claude-sonnet-4-6",
            input: 20,
            output: 8,
            cacheRead: 200,
            cacheWrite: 30,
            costUsd: 0.15,
          }],
        }),
      );
      const result = await readAllTicketUsage(tempDir);
      assertEquals(
        result.tokens,
        10 + 5 + 100 + 50 + 20 + 8 + 200 + 30,
      );
      assertEquals(result.costResult, { cost: 0.25, partial: false });
      assertEquals(result.phaseBreakdown?.length, 2);
      assertEquals(result.phaseBreakdown?.[0].key, "intake");
      assertEquals(result.phaseBreakdown?.[0].turns, 4);
      assertEquals(result.phaseBreakdown?.[1].key, "enrichment");
      assertEquals(result.phaseBreakdown?.[1].turns, 23);
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "readAllTicketUsage: partial cost when only some files have costUsd",
  async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(tempDir, "20260806T050000-intake.usage.json"),
        JSON.stringify({
          durationMs: 1000,
          models: [{
            model: "claude-sonnet-4-6",
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            costUsd: 0.10,
          }],
        }),
      );
      await Deno.writeTextFile(
        join(tempDir, "20260806T160000-enrichment.usage.json"),
        JSON.stringify({
          durationMs: 2000,
          models: [{
            model: "claude-sonnet-4-6",
            input: 20,
            output: 8,
            cacheRead: 0,
            cacheWrite: 0,
          }],
        }),
      );
      const result = await readAllTicketUsage(tempDir);
      assertEquals(result.costResult, { cost: 0.10, partial: true });
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "readAllTicketUsage: phaseBreakdown is null when directory scan fails",
  async () => {
    const result = await readAllTicketUsage("/nonexistent/path");
    assertEquals(result.tokens, null);
    assertEquals(result.phaseBreakdown, null);
  },
);

// ── formatStatusRow color ─────────────────────────────────────────────────────

Deno.test("formatStatusRow: running status uses green foreground color", () => {
  const row = formatStatusRow(
    " ",
    "github/a/repo/1",
    "intake",
    "running",
    [],
    "0",
    "t",
  );
  assertStringIncludes(row, green("running".padEnd(17)));
  assertStringIncludes(stripAnsiCode(row), "running");
});

Deno.test("formatStatusRow: waiting status uses yellow foreground color", () => {
  const row = formatStatusRow(
    " ",
    "github/a/repo/1",
    "intake",
    "waiting",
    [],
    "0",
    "t",
  );
  assertStringIncludes(row, yellow("waiting".padEnd(17)));
  assertStringIncludes(stripAnsiCode(row), "waiting");
});

Deno.test("formatStatusRow: needs-attention status uses red foreground color", () => {
  const row = formatStatusRow(
    " ",
    "github/a/repo/1",
    "intake",
    "needs-attention",
    [],
    "0",
    "t",
  );
  assertStringIncludes(row, red("needs-attention".padEnd(17)));
  assertStringIncludes(stripAnsiCode(row), "needs-attention");
});

Deno.test("formatStatusRow: new, revising, done statuses are not colored", () => {
  for (const s of ["new", "revising", "done"]) {
    const row = formatStatusRow(
      " ",
      "github/a/repo/1",
      "intake",
      s,
      [],
      "0",
      "t",
    );
    assertStringIncludes(row, s.padEnd(17));
    assertEquals(row, stripAnsiCode(row));
  }
});

// ── formatBrokenRow ───────────────────────────────────────────────────────────

Deno.test("formatBrokenRow: id is padded to 36 chars in red", () => {
  const row = formatBrokenRow("github/a/repo/1", "invalid phase");
  assertStringIncludes(row, red("github/a/repo/1".padEnd(36)));
});

Deno.test("formatBrokenRow: message follows the red id", () => {
  const row = formatBrokenRow("github/a/repo/1", "invalid phase");
  assertStringIncludes(
    stripAnsiCode(row),
    "github/a/repo/1".padEnd(36) + " invalid phase",
  );
});

Deno.test("formatBrokenRow: long id is not truncated", () => {
  const id = "github/jackjennings/lazyboy/515";
  const row = formatBrokenRow(id, "parse error");
  assertStringIncludes(stripAnsiCode(row), id);
});
