import {
  assert,
  assertEquals,
  assertExists,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { join } from "@std/path";
import { readTicket, StaleTicketWriteError, writeTicket } from "../state/store.ts";
import type { TicketState } from "../state/types.ts";
import { makeTicket } from "../test-support.ts";
import { performRewind } from "./rewind.ts";

Deno.test(
  "performRewind: throws when target phase is after current phase",
  async () => {
    const ticket = makeTicket({ phase: "spec", status: "waiting" });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    try {
      await assertRejects(
        () => performRewind(stateDir, ticket.id, "plan"),
        Error,
        "Cannot rewind: target phase plan is after current phase spec",
      );
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "performRewind: throws when ticket has one PR",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "waiting",
      prs: [{
        url: "https://github.com/org/repo/pull/1",
        title: "PR",
        dependsOn: [],
        merged: false,
      }],
    });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    try {
      await assertRejects(
        () => performRewind(stateDir, ticket.id, "spec"),
        Error,
        "Cannot rewind: ticket has 1 PR(s). Close PRs before rewinding.",
      );
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "performRewind: throws when ticket has multiple PRs",
  async () => {
    const pr = {
      url: "https://github.com/org/repo/pull/1",
      title: "PR",
      dependsOn: [],
      merged: false,
    };
    const ticket = makeTicket({
      phase: "implementation",
      status: "waiting",
      prs: [pr, { ...pr, url: "https://github.com/org/repo/pull/2" }],
    });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    try {
      await assertRejects(
        () => performRewind(stateDir, ticket.id, "spec"),
        Error,
        "Cannot rewind: ticket has 2 PR(s). Close PRs before rewinding.",
      );
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "performRewind: same-phase rewind is valid",
  async () => {
    const ticket = makeTicket({ phase: "spec", status: "waiting" });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const commitFn = spy(() => Promise.resolve());
    try {
      const result = await performRewind(stateDir, ticket.id, "spec", {
        commitFn,
      });
      assertEquals(result.to, "spec");
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "performRewind: resets to intake/new when targetPhase is intake",
  async () => {
    const ticket = makeTicket({ phase: "spec", status: "waiting" });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const commitFn = spy(() => Promise.resolve());
    try {
      await performRewind(stateDir, ticket.id, "intake", { commitFn });
      const meta = await Deno.readTextFile(
        join(stateDir, ticket.id, "meta.md"),
      );
      assertStringIncludes(meta, "phase: intake");
      assertStringIncludes(meta, "status: new");
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "performRewind: resets to spec/waiting when targetPhase is spec",
  async () => {
    const ticket = makeTicket({ phase: "implementation", status: "waiting" });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const commitFn = spy(() => Promise.resolve());
    try {
      await performRewind(stateDir, ticket.id, "spec", { commitFn });
      const meta = await Deno.readTextFile(
        join(stateDir, ticket.id, "meta.md"),
      );
      assertStringIncludes(meta, "phase: spec");
      assertStringIncludes(meta, "status: waiting");
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "performRewind: truncates approvals to phases strictly before target",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "waiting",
      approvals: [
        { timestamp: "2026-01-01T00:00:00Z", actor: "human", phase: "intake" },
        {
          timestamp: "2026-01-02T00:00:00Z",
          actor: "agent",
          phase: "enrichment",
        },
        { timestamp: "2026-01-03T00:00:00Z", actor: "human", phase: "spec" },
        { timestamp: "2026-01-04T00:00:00Z", actor: "human", phase: "plan" },
        {
          timestamp: "2026-01-05T00:00:00Z",
          actor: "human",
          phase: "implementation",
        },
      ],
    });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const commitFn = spy(() => Promise.resolve());
    try {
      await performRewind(stateDir, ticket.id, "spec", { commitFn });
      const meta = await Deno.readTextFile(
        join(stateDir, ticket.id, "meta.md"),
      );
      assertStringIncludes(meta, "2026-01-01T00:00:00");
      assertStringIncludes(meta, "2026-01-02T00:00:00");
      assertFalse(meta.includes("2026-01-03T00:00:00"));
      assertFalse(meta.includes("2026-01-04T00:00:00"));
      assertFalse(meta.includes("2026-01-05T00:00:00"));
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "performRewind: clears phaseSessionIds for target and later phases",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "waiting",
      phaseSessionIds: {
        intake: "session-intake",
        enrichment: "session-enrichment",
        spec: "session-spec",
        implementation: "session-impl",
      },
    });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const commitFn = spy(() => Promise.resolve());
    try {
      await performRewind(stateDir, ticket.id, "spec", { commitFn });
      const meta = await Deno.readTextFile(
        join(stateDir, ticket.id, "meta.md"),
      );
      assertStringIncludes(meta, "session-intake");
      assertStringIncludes(meta, "session-enrichment");
      assertFalse(meta.includes("session-spec"));
      assertFalse(meta.includes("session-impl"));
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "performRewind: clears outputRetries and notifiedNeedsAttention",
  async () => {
    const ticket = makeTicket({
      phase: "spec",
      status: "needs-attention",
      outputRetries: 1,
      notifiedNeedsAttention: true,
    });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const commitFn = spy(() => Promise.resolve());
    try {
      await performRewind(stateDir, ticket.id, "spec", { commitFn });
      const meta = await Deno.readTextFile(
        join(stateDir, ticket.id, "meta.md"),
      );
      assertFalse(meta.includes("outputRetries"));
      assertFalse(meta.includes("notifiedNeedsAttention"));
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "performRewind: archives phase output files for target and later phases",
  async () => {
    const ticket = makeTicket({ phase: "implementation", status: "waiting" });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const ticketDir = join(stateDir, ticket.id);

    const filesToArchive = [
      "20260818T174532-spec.md",
      "20260818T174532-spec.md.exit",
      "20260818T174532-spec.md.session",
      "20260818T174532-spec.usage.json",
      "20260818T174532-spec-self-review.md",
      "20260818T174532-spec-feedback.md",
      "20260818T175320-plan.md",
      "20260818T180000-implementation.md",
    ];
    const filesToKeep = [
      "20260818T170955-enrichment.md",
      "20260818T164927-intake.md",
    ];

    for (const f of [...filesToArchive, ...filesToKeep]) {
      await Deno.writeTextFile(join(ticketDir, f), "content");
    }

    const commitFn = spy(() => Promise.resolve());
    try {
      await performRewind(stateDir, ticket.id, "spec", { commitFn });

      for (const f of filesToArchive) {
        await assertRejects(
          () => Deno.stat(join(ticketDir, f)),
          Deno.errors.NotFound,
        );
        assertExists(await Deno.stat(join(ticketDir, `${f}.rewound`)));
      }

      for (const f of filesToKeep) {
        assertExists(await Deno.stat(join(ticketDir, f)));
        await assertRejects(
          () => Deno.stat(join(ticketDir, `${f}.rewound`)),
          Deno.errors.NotFound,
        );
      }
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "performRewind: calls killFn when run.pid is present",
  async () => {
    const ticket = makeTicket({
      phase: "implementation",
      status: "running",
    });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const ticketDir = join(stateDir, ticket.id);
    await Deno.writeTextFile(join(ticketDir, "run.pid"), Deno.pid.toString());
    const commitFn = spy(() => Promise.resolve());
    const killFn = spy((_pid: number) => {});
    try {
      await performRewind(stateDir, ticket.id, "spec", { commitFn, killFn });
      assertSpyCalls(killFn, 1);
      assertEquals(killFn.calls[0].args[0], Deno.pid);
      await assertRejects(
        () => Deno.stat(join(ticketDir, "run.pid")),
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "performRewind: does not call killFn when run.pid is absent",
  async () => {
    const ticket = makeTicket({ phase: "spec", status: "waiting" });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const commitFn = spy(() => Promise.resolve());
    const killFn = spy((_pid: number) => {});
    try {
      await performRewind(stateDir, ticket.id, "spec", { commitFn, killFn });
      assertSpyCalls(killFn, 0);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "performRewind: returns from and to phases",
  async () => {
    const ticket = makeTicket({ phase: "implementation", status: "waiting" });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const commitFn = spy(() => Promise.resolve());
    try {
      const result = await performRewind(stateDir, ticket.id, "spec", {
        commitFn,
      });
      assertEquals(result.from, "implementation");
      assertEquals(result.to, "spec");
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "performRewind: appends phase-transition log entry",
  async () => {
    const ticket = makeTicket({ phase: "plan", status: "waiting" });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const commitFn = spy(() => Promise.resolve());
    try {
      await performRewind(stateDir, ticket.id, "spec", { commitFn });
      const log = await Deno.readTextFile(
        join(stateDir, ticket.id, "log.ndjson"),
      );
      const entry = JSON.parse(log.trim().split("\n").at(-1)!);
      assertEquals(entry.event, "phase-transition");
      assertEquals(entry.from, "plan");
      assertEquals(entry.to, "spec");
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "performRewind: calls commitFn with stateDir, id, and rewind message",
  async () => {
    const ticket = makeTicket({ phase: "implementation", status: "waiting" });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const commitFn = spy(() => Promise.resolve());
    try {
      await performRewind(stateDir, ticket.id, "spec", { commitFn });
      assertSpyCalls(commitFn, 1);
      assertEquals(commitFn.calls[0].args, [
        stateDir,
        ticket.id,
        `rewind: ${ticket.id}`,
      ]);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "performRewind: allows rewind from merge phase to implementation",
  async () => {
    const ticket = makeTicket({ phase: "merge", status: "waiting" });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const commitFn = spy(() => Promise.resolve());
    try {
      const result = await performRewind(
        stateDir,
        ticket.id,
        "implementation",
        { commitFn },
      );
      assertEquals(result.from, "merge");
      assertEquals(result.to, "implementation");
      const meta = await Deno.readTextFile(
        join(stateDir, ticket.id, "meta.md"),
      );
      assertStringIncludes(meta, "phase: implementation");
      assertStringIncludes(meta, "status: waiting");
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "performRewind: completes normally when killFn throws",
  async () => {
    const ticket = makeTicket({ phase: "implementation", status: "running" });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const ticketDir = join(stateDir, ticket.id);
    await Deno.writeTextFile(join(ticketDir, "run.pid"), Deno.pid.toString());
    const commitFn = spy(() => Promise.resolve());
    const killFn = spy((_pid: number) => {
      throw new Error("process already dead");
    });
    try {
      await performRewind(stateDir, ticket.id, "spec", { commitFn, killFn });
      const meta = await Deno.readTextFile(
        join(stateDir, ticket.id, "meta.md"),
      );
      assertStringIncludes(meta, "phase: spec");
      assert(true);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test("performRewind: retries once on StaleTicketWriteError", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    await writeTicket(stateDir, makeTicket({ id: "gh-1", phase: "implementation", status: "waiting" }));
    const fresh = await readTicket(stateDir, "gh-1");
    let callCount = 0;
    const writeStub = spy(async (_sd: string, _t: TicketState) => {
      callCount++;
      if (callCount === 1) throw new StaleTicketWriteError("stale");
    });
    await performRewind(stateDir, "gh-1", "spec", {
      commitFn: spy(() => Promise.resolve()),
      writeTicketFn: writeStub,
      readTicketFn: () => Promise.resolve(fresh),
    });
    assertSpyCalls(writeStub, 2);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("performRewind: throws on second StaleTicketWriteError", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    await writeTicket(stateDir, makeTicket({ id: "gh-1", phase: "implementation", status: "waiting" }));
    const fresh = await readTicket(stateDir, "gh-1");
    await assertRejects(
      () =>
        performRewind(stateDir, "gh-1", "spec", {
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
