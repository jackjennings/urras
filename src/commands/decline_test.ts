import {
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { join } from "@std/path";
import { writeTicket } from "../state/store.ts";
import { makeTicket } from "../test-support.ts";
import { performDecline } from "./decline.ts";

Deno.test("performDecline: transitions ticket to wont-do/done", async () => {
  const ticket = makeTicket({ phase: "plan", status: "waiting" });
  const stateDir = await Deno.makeTempDir();
  await writeTicket(stateDir, ticket);
  const commitFn = spy(() => Promise.resolve());
  try {
    await performDecline(stateDir, ticket.id, undefined, { commitFn });
    const meta = await Deno.readTextFile(
      join(stateDir, ticket.id, "meta.md"),
    );
    assertStringIncludes(meta, "phase: wont-do");
    assertStringIncludes(meta, "status: done");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("performDecline: does not write approved key", async () => {
  const ticket = makeTicket({
    phase: "implementation",
    status: "running",
    approvals: [{
      timestamp: "2026-01-01T00:00:00Z",
      actor: "human",
      phase: "implementation",
    }],
  });
  const stateDir = await Deno.makeTempDir();
  await writeTicket(stateDir, ticket);
  const commitFn = spy(() => Promise.resolve());
  try {
    await performDecline(stateDir, ticket.id, undefined, { commitFn });
    const meta = await Deno.readTextFile(
      join(stateDir, ticket.id, "meta.md"),
    );
    assertFalse(meta.includes("approved:"));
    assertFalse(meta.includes("pid:"));
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("performDecline: appends phase-transition log entry", async () => {
  const ticket = makeTicket({ phase: "enrichment", status: "waiting" });
  const stateDir = await Deno.makeTempDir();
  await writeTicket(stateDir, ticket);
  const commitFn = spy(() => Promise.resolve());
  try {
    await performDecline(stateDir, ticket.id, undefined, { commitFn });
    const log = await Deno.readTextFile(
      join(stateDir, ticket.id, "log.ndjson"),
    );
    const entries = log.trim().split("\n").map((l) => JSON.parse(l));
    const transition = entries.find((e) => e.event === "phase-transition");
    assertEquals(transition?.from, "enrichment");
    assertEquals(transition?.to, "wont-do");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test(
  "performDecline: calls commitFn with stateDir, id, and decline message",
  async () => {
    const ticket = makeTicket();
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const commitFn = spy(() => Promise.resolve());
    try {
      await performDecline(stateDir, ticket.id, undefined, { commitFn });
      assertSpyCalls(commitFn, 1);
      assertEquals(commitFn.calls[0].args, [
        stateDir,
        ticket.id,
        `decline: ${ticket.id}`,
      ]);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test("performDecline: without reason leaves body unchanged", async () => {
  const ticket = makeTicket({ body: "Original body" });
  const stateDir = await Deno.makeTempDir();
  await writeTicket(stateDir, ticket);
  const commitFn = spy(() => Promise.resolve());
  try {
    await performDecline(stateDir, ticket.id, undefined, { commitFn });
    const meta = await Deno.readTextFile(
      join(stateDir, ticket.id, "meta.md"),
    );
    assertStringIncludes(meta, "Original body");
    assertFalse(meta.includes("Declined:"));
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("performDecline: with reason appends to body", async () => {
  const ticket = makeTicket({ body: "Original body" });
  const stateDir = await Deno.makeTempDir();
  await writeTicket(stateDir, ticket);
  const commitFn = spy(() => Promise.resolve());
  try {
    await performDecline(
      stateDir,
      ticket.id,
      "requires manual design review",
      { commitFn },
    );
    const meta = await Deno.readTextFile(
      join(stateDir, ticket.id, "meta.md"),
    );
    assertStringIncludes(meta, "Original body");
    assertStringIncludes(meta, "Declined: requires manual design review");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("performDecline: returns original phase", async () => {
  const ticket = makeTicket({ phase: "spec", status: "waiting" });
  const stateDir = await Deno.makeTempDir();
  await writeTicket(stateDir, ticket);
  const commitFn = spy(() => Promise.resolve());
  try {
    const result = await performDecline(
      stateDir,
      ticket.id,
      undefined,
      { commitFn },
    );
    assertEquals(result.from, "spec");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test(
  "performDecline: calls killFn with PID when run.pid is present and alive",
  async () => {
    const ticket = makeTicket({ phase: "implementation", status: "running" });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const ticketDir = join(stateDir, ticket.id);
    await Deno.writeTextFile(join(ticketDir, "run.pid"), Deno.pid.toString());
    const commitFn = spy(() => Promise.resolve());
    const killFn = spy((_pid: number) => {});
    try {
      await performDecline(stateDir, ticket.id, undefined, {
        commitFn,
        killFn,
      });
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
  "performDecline: does not call killFn when run.pid is absent",
  async () => {
    const ticket = makeTicket({ phase: "plan", status: "waiting" });
    const stateDir = await Deno.makeTempDir();
    await writeTicket(stateDir, ticket);
    const commitFn = spy(() => Promise.resolve());
    const killFn = spy((_pid: number) => {});
    try {
      await performDecline(stateDir, ticket.id, undefined, {
        commitFn,
        killFn,
      });
      assertSpyCalls(killFn, 0);
      const meta = await Deno.readTextFile(
        join(stateDir, ticket.id, "meta.md"),
      );
      assertStringIncludes(meta, "phase: wont-do");
      assertStringIncludes(meta, "status: done");
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "performDecline: completes normally when killFn throws",
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
      await performDecline(stateDir, ticket.id, undefined, {
        commitFn,
        killFn,
      });
      const meta = await Deno.readTextFile(
        join(stateDir, ticket.id, "meta.md"),
      );
      assertStringIncludes(meta, "phase: wont-do");
      assertStringIncludes(meta, "status: done");
      await assertRejects(
        () => Deno.stat(join(ticketDir, "run.pid")),
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);
