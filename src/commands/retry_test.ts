import {
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { join } from "@std/path";
import { readTicket, StaleTicketWriteError, writeTicket } from "../state/store.ts";
import type { TicketState } from "../state/types.ts";
import { makeTicket } from "../test-support.ts";
import { performRetry } from "./retry.ts";

Deno.test(
  "performRetry: throws when ticket is not in needs-attention",
  async () => {
    const ticket = makeTicket({ phase: "spec", status: "waiting" });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    try {
      await assertRejects(
        () => performRetry(stateDir, ticket.id),
        Error,
        "needs-attention",
      );
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "performRetry: throws when ticket is running",
  async () => {
    const ticket = makeTicket({ phase: "plan", status: "running" });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    try {
      await assertRejects(
        () => performRetry(stateDir, ticket.id),
        Error,
        "needs-attention",
      );
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "performRetry: resets spec/needs-attention to spec/waiting",
  async () => {
    const ticket = makeTicket({ phase: "spec", status: "needs-attention" });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const commitFn = spy(() => Promise.resolve());
    try {
      await performRetry(stateDir, ticket.id, { commitFn });
      const meta = await Deno.readTextFile(
        join(stateDir, ticket.id, "meta.md"),
      );
      assertStringIncludes(meta, "status: waiting");
      assertStringIncludes(meta, "phase: spec");
      assertFalse(meta.includes("pid:"));
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "performRetry: resets intake/needs-attention to intake/new",
  async () => {
    const ticket = makeTicket({ phase: "intake", status: "needs-attention" });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const commitFn = spy(() => Promise.resolve());
    try {
      await performRetry(stateDir, ticket.id, { commitFn });
      const meta = await Deno.readTextFile(
        join(stateDir, ticket.id, "meta.md"),
      );
      assertStringIncludes(meta, "status: new");
      assertStringIncludes(meta, "phase: intake");
      assertFalse(meta.includes("pid:"));
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "performRetry: preserves approvals through retry",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "needs-attention",
      approvals: [
        {
          timestamp: "2026-01-01T00:00:00Z",
          actor: "human",
          phase: "implementation",
        },
      ],
    });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const commitFn = spy(() => Promise.resolve());
    try {
      await performRetry(stateDir, ticket.id, { commitFn });
      const meta = await Deno.readTextFile(
        join(stateDir, ticket.id, "meta.md"),
      );
      assertFalse(meta.includes("approved:"));
      assertStringIncludes(meta, "actor: human");
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "performRetry: appends status-transition log entry",
  async () => {
    const ticket = makeTicket({ phase: "plan", status: "needs-attention" });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const commitFn = spy(() => Promise.resolve());
    try {
      await performRetry(stateDir, ticket.id, { commitFn });
      const log = await Deno.readTextFile(
        join(stateDir, ticket.id, "log.ndjson"),
      );
      const entry = JSON.parse(log.trim().split("\n").at(-1)!);
      assertEquals(entry.event, "status-transition");
      assertEquals(entry.phase, "plan");
      assertEquals(entry.from, "needs-attention");
      assertEquals(entry.to, "waiting");
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "performRetry: appends log with 'new' as target for intake phase",
  async () => {
    const ticket = makeTicket({ phase: "intake", status: "needs-attention" });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const commitFn = spy(() => Promise.resolve());
    try {
      await performRetry(stateDir, ticket.id, { commitFn });
      const log = await Deno.readTextFile(
        join(stateDir, ticket.id, "log.ndjson"),
      );
      const entry = JSON.parse(log.trim().split("\n").at(-1)!);
      assertEquals(entry.event, "status-transition");
      assertEquals(entry.phase, "intake");
      assertEquals(entry.from, "needs-attention");
      assertEquals(entry.to, "new");
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "performRetry: calls commitFn with stateDir, id, and retry message",
  async () => {
    const ticket = makeTicket({
      phase: "enrichment",
      status: "needs-attention",
    });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const commitFn = spy(() => Promise.resolve());
    try {
      await performRetry(stateDir, ticket.id, { commitFn });
      assertSpyCalls(commitFn, 1);
      assertEquals(commitFn.calls[0].args, [
        stateDir,
        ticket.id,
        `retry: ${ticket.id}`,
      ]);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test("performRetry: retries once on StaleTicketWriteError", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    await writeTicket(stateDir, makeTicket({ id: "gh-1", phase: "spec", status: "needs-attention" }));
    const fresh = await readTicket(stateDir, "gh-1");
    let callCount = 0;
    const writeStub = spy(async (_sd: string, _t: TicketState) => {
      callCount++;
      if (callCount === 1) throw new StaleTicketWriteError("stale");
    });
    await performRetry(stateDir, "gh-1", {
      commitFn: spy(() => Promise.resolve()),
      writeTicketFn: writeStub,
      readTicketFn: () => Promise.resolve(fresh),
    });
    assertSpyCalls(writeStub, 2);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("performRetry: throws on second StaleTicketWriteError", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    await writeTicket(stateDir, makeTicket({ id: "gh-1", phase: "spec", status: "needs-attention" }));
    const fresh = await readTicket(stateDir, "gh-1");
    await assertRejects(
      () =>
        performRetry(stateDir, "gh-1", {
          commitFn: spy(() => Promise.resolve()),
          writeTicketFn: spy(async (_sd: string, _t: TicketState) => {
            throw new StaleTicketWriteError("stale");
          }),
          readTicketFn: () => Promise.resolve(fresh),
        }),
      StaleTicketWriteError,
    );
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});
