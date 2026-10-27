import { assertEquals, assertFalse } from "@std/assert";
import { join } from "@std/path";
import {
  acknowledgeInbox,
  inboxDir,
  publishInboxEvent,
  readPendingInbox,
  sweepInbox,
} from "./inbox.ts";
import { withUrrasDir } from "./test-support.ts";

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

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true, () => false);
}

async function plantEvent(
  opts: { directory: "tmp" | "new" | "cur"; ageHours: number },
): Promise<string> {
  const name = `${
    String(Temporal.Now.instant().epochMilliseconds - opts.ageHours * 3_600_000)
      .padStart(13, "0")
  }-0001-planted.json`;
  await Deno.mkdir(join(inboxDir(), opts.directory), { recursive: true });
  await Deno.writeTextFile(
    join(inboxDir(), opts.directory, name),
    '{"event":"tick-end","ts":"2026-01-01T00:00:00Z"}\n',
  );
  return name;
}

Deno.test("publishInboxEvent: events are read back in publication order", async () => {
  using _urras = withUrrasDir();
  await publishInboxEvent({ event: "tick-start" });
  await publishInboxEvent(statusChange);
  await publishInboxEvent({ event: "tick-end" });
  const pending = await readPendingInbox();
  assertEquals(pending.map((entry) => entry.event.event), [
    "tick-start",
    "status-change",
    "tick-end",
  ]);
  assertEquals(pending[1].event, {
    ...statusChange,
    ts: pending[1].event.ts,
  });
});

Deno.test("publishInboxEvent: leaves nothing behind in tmp", async () => {
  using _urras = withUrrasDir();
  await publishInboxEvent({ event: "tick-end" });
  const leftovers = [];
  for await (const entry of Deno.readDir(join(inboxDir(), "tmp"))) {
    leftovers.push(entry.name);
  }
  assertEquals(leftovers, []);
});

Deno.test("readPendingInbox: is empty when nothing was ever published", async () => {
  using _urras = withUrrasDir();
  assertEquals(await readPendingInbox(), []);
});

Deno.test("acknowledgeInbox: moves handled events out of the pending set", async () => {
  using _urras = withUrrasDir();
  await publishInboxEvent({ event: "tick-start" });
  await publishInboxEvent({ event: "tick-end" });
  const [first, second] = await readPendingInbox();
  await acknowledgeInbox([first.name]);
  assertEquals((await readPendingInbox()).map((entry) => entry.name), [
    second.name,
  ]);
  assertEquals(await exists(join(inboxDir(), "cur", first.name)), true);
});

Deno.test("sweepInbox: deletes expired events per directory and keeps recent ones", async () => {
  using _urras = withUrrasDir();
  const staleTemporary = await plantEvent({ directory: "tmp", ageHours: 40 });
  const freshTemporary = await plantEvent({ directory: "tmp", ageHours: 1 });
  const staleHandled = await plantEvent({
    directory: "cur",
    ageHours: 8 * 24,
  });
  const freshHandled = await plantEvent({ directory: "cur", ageHours: 24 });
  const staleUnread = await plantEvent({
    directory: "new",
    ageHours: 31 * 24,
  });
  const freshUnread = await plantEvent({ directory: "new", ageHours: 8 * 24 });

  const result = await sweepInbox({ now: Temporal.Now.instant() });

  assertEquals(result, { droppedUnread: 1 });
  assertFalse(await exists(join(inboxDir(), "tmp", staleTemporary)));
  assertEquals(await exists(join(inboxDir(), "tmp", freshTemporary)), true);
  assertFalse(await exists(join(inboxDir(), "cur", staleHandled)));
  assertEquals(await exists(join(inboxDir(), "cur", freshHandled)), true);
  assertFalse(await exists(join(inboxDir(), "new", staleUnread)));
  assertEquals(await exists(join(inboxDir(), "new", freshUnread)), true);
});

Deno.test("sweepInbox: honours configured retention windows", async () => {
  using _urras = withUrrasDir();
  const unread = await plantEvent({ directory: "new", ageHours: 3 * 24 });
  const handled = await plantEvent({ directory: "cur", ageHours: 3 * 24 });
  const result = await sweepInbox({
    now: Temporal.Now.instant(),
    windows: { handledDays: 2, unreadDays: 2 },
  });
  assertEquals(result, { droppedUnread: 1 });
  assertFalse(await exists(join(inboxDir(), "new", unread)));
  assertFalse(await exists(join(inboxDir(), "cur", handled)));
});

Deno.test("sweepInbox: succeeds when the inbox does not exist yet", async () => {
  using _urras = withUrrasDir();
  assertEquals(await sweepInbox({ now: Temporal.Now.instant() }), {
    droppedUnread: 0,
  });
});
