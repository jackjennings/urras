import { assertEquals } from "@std/assert";
import {
  acknowledgeInbox,
  publishInboxEvent,
  readPendingInbox,
} from "../inbox.ts";
import { withUrrasDir } from "../test-support.ts";
import { waitForInboxBatch } from "./wait.ts";

const statusChange = {
  event: "status-change" as const,
  ticket: "jira/PROJ-1",
  phase: "spec",
  status: "waiting",
  previousPhase: "spec",
  previousStatus: "running",
  approver: "",
  reason: "",
};

function eventNames(
  batch: Awaited<ReturnType<typeof waitForInboxBatch>>,
): string[] {
  return batch.map((entry) => entry.event.event);
}

Deno.test("waitForInboxBatch: returns a batch that is already waiting, through tick-end", async () => {
  using _urras = withUrrasDir();
  await publishInboxEvent({ event: "tick-start" });
  await publishInboxEvent(statusChange);
  await publishInboxEvent({ event: "tick-end" });
  const batch = await waitForInboxBatch({ idleMilliseconds: 50 });
  assertEquals(eventNames(batch), ["tick-start", "status-change", "tick-end"]);
  assertEquals(await readPendingInbox(), []);
});

Deno.test("waitForInboxBatch: blocks until a status change arrives", async () => {
  using _urras = withUrrasDir();
  const waiting = waitForInboxBatch({ idleMilliseconds: 50 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await publishInboxEvent(statusChange);
  await publishInboxEvent({ event: "tick-end" });
  assertEquals(eventNames(await waiting), ["status-change", "tick-end"]);
});

Deno.test("waitForInboxBatch: keeps waiting through a tick that changed nothing", async () => {
  using _urras = withUrrasDir();
  await publishInboxEvent({ event: "tick-start" });
  await publishInboxEvent({ event: "tick-end" });
  const waiting = waitForInboxBatch({ idleMilliseconds: 50 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await publishInboxEvent({ event: "tick-start" });
  await publishInboxEvent(statusChange);
  await publishInboxEvent({ event: "tick-end" });
  assertEquals(eventNames(await waiting), [
    "tick-start",
    "status-change",
    "tick-end",
  ]);
  assertEquals(await readPendingInbox(), []);
});

Deno.test("waitForInboxBatch: returns status changes after the idle window when no tick-end follows", async () => {
  using _urras = withUrrasDir();
  await publishInboxEvent(statusChange);
  const batch = await waitForInboxBatch({ idleMilliseconds: 100 });
  assertEquals(eventNames(batch), ["status-change"]);
});

Deno.test("waitForInboxBatch: leaves events after the last tick-end for the next batch", async () => {
  using _urras = withUrrasDir();
  await publishInboxEvent(statusChange);
  await publishInboxEvent({ event: "tick-end" });
  await publishInboxEvent({ event: "tick-start" });
  const batch = await waitForInboxBatch({ idleMilliseconds: 50 });
  assertEquals(eventNames(batch), ["status-change", "tick-end"]);
  assertEquals(
    (await readPendingInbox()).map((entry) => entry.event.event),
    ["tick-start"],
  );
});

Deno.test("waitForInboxBatch: does not return events that were already handled", async () => {
  using _urras = withUrrasDir();
  await publishInboxEvent(statusChange);
  await publishInboxEvent({ event: "tick-end" });
  await acknowledgeInbox((await readPendingInbox()).map((e) => e.name));
  const waiting = waitForInboxBatch({ idleMilliseconds: 50 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await publishInboxEvent({
    ...statusChange,
    ticket: "jira/PROJ-2",
  });
  await publishInboxEvent({ event: "tick-end" });
  const batch = await waiting;
  assertEquals(
    batch.map((entry) =>
      entry.event.event === "status-change" ? entry.event.ticket : null
    ),
    ["jira/PROJ-2", null],
  );
});
