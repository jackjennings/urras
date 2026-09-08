import { assert, assertEquals, assertFalse } from "@std/assert";
import { pickupWorkItemAction } from "./pickup-work-item.ts";
import type { TicketState } from "../state/types.ts";
import { makeTicket } from "../test-support.ts";

const BASE = {
  id: "jira/PROJ-42",
  provider: "jira" as const,
  url: "https://myorg.atlassian.net/browse/PROJ-42",
  created: "2026-07-01T00:00:00Z",
  updated: "2026-07-01T00:00:00Z",
};

function makeAction(
  overrides: Partial<Parameters<typeof pickupWorkItemAction>[0]> = {},
) {
  return pickupWorkItemAction({
    pickupWorkItem: () => Promise.resolve(),
    writeTicket: () => Promise.resolve(),
    appendLog: () => Promise.resolve(),
    ...overrides,
  });
}

Deno.test(
  "pickupWorkItemAction: applies when status is new and providerPickedUp not set",
  () => {
    assert(makeAction().applies(makeTicket(BASE)));
  },
);

Deno.test("pickupWorkItemAction: does not apply when providerPickedUp is true", () => {
  assertFalse(
    makeAction().applies(makeTicket({ ...BASE, providerPickedUp: true })),
  );
});

Deno.test("pickupWorkItemAction: does not apply when status is not new", () => {
  assertFalse(
    makeAction().applies(makeTicket({ ...BASE, status: "running" })),
  );
});

Deno.test(
  "pickupWorkItemAction: run calls pickupWorkItem with ticket url and provider",
  async () => {
    const calls: Array<{ url: string; provider: string }> = [];
    await makeAction({
      pickupWorkItem: (url: string, provider: string) => {
        calls.push({ url, provider });
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");
    assertEquals(calls, [{ url: BASE.url, provider: "jira" }]);
  },
);

Deno.test(
  "pickupWorkItemAction: run writes ticket with providerPickedUp: true on success",
  async () => {
    const written: TicketState[] = [];
    await makeAction({
      writeTicket: (_dir: string, t: TicketState) => {
        written.push(t);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");
    assertEquals(written.length, 1);
    assert(written[0].providerPickedUp);
  },
);

Deno.test(
  "pickupWorkItemAction: run returns ticket with providerPickedUp: true on success",
  async () => {
    const result = await makeAction().run(makeTicket(BASE), "/state");
    assert(result?.providerPickedUp);
  },
);

Deno.test(
  "pickupWorkItemAction: run logs error and returns null when pickupWorkItem throws",
  async () => {
    const logged: object[] = [];
    const result = await makeAction({
      pickupWorkItem: () => Promise.reject(new Error("pickup failed")),
      appendLog: (_stateDir: string, _id: string, entry: object) => {
        logged.push(entry);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");
    assertEquals(result, null);
    assertEquals(logged.length, 1);
    assertEquals((logged[0] as Record<string, string>).event, "error");
    assertEquals(
      (logged[0] as Record<string, string>).context,
      "pickupWorkItem",
    );
  },
);

Deno.test(
  "pickupWorkItemAction: run does not write ticket when pickupWorkItem throws",
  async () => {
    const written: unknown[] = [];
    await makeAction({
      pickupWorkItem: () => Promise.reject(new Error("pickup failed")),
      writeTicket: (_dir: string, t: TicketState) => {
        written.push(t);
        return Promise.resolve();
      },
    }).run(makeTicket(BASE), "/state");
    assertEquals(written.length, 0);
  },
);
