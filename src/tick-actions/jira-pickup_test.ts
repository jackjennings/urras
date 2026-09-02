import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { jiraPickupAction } from "./jira-pickup.ts";
import { makeTicket } from "../test-support.ts";
import { HttpClient } from "../http-client.ts";

function makeAction(
  overrides: Partial<Parameters<typeof jiraPickupAction>[0]> = {},
) {
  return jiraPickupAction({
    baseUrl: "https://myorg.atlassian.net",
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    targetStatusName: "In Progress",
    appendLog: () => Promise.resolve(),
    writeTicket: () => Promise.resolve(),
    http: new HttpClient(),
    ...overrides,
  });
}

function makeIssueFetch(
  currentStatusName: string,
  transitions: Array<{ id: string; to: { name: string } }>,
) {
  return (
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (init?.method === "POST") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          fields: { status: { name: currentStatusName } },
          transitions,
        }),
        { status: 200 },
      ),
    );
  };
}

const BASE = {
  id: "jira/PROJ-42",
  provider: "jira" as const,
  url: "https://myorg.atlassian.net/browse/PROJ-42",
  created: "2026-07-01T00:00:00Z",
  updated: "2026-07-01T00:00:00Z",
};

Deno.test("jiraPickupAction: applies when provider is jira and status is new", () => {
  assert(makeAction().applies(makeTicket(BASE)));
});

Deno.test("jiraPickupAction: does not apply when provider is not jira", () => {
  assertFalse(
    makeAction().applies(makeTicket({ ...BASE, provider: "github" })),
  );
});

Deno.test("jiraPickupAction: does not apply when status is not new", () => {
  assertFalse(
    makeAction().applies(makeTicket({ ...BASE, status: "running" })),
  );
});

Deno.test("jiraPickupAction: does not apply when providerPickedUp is true", () => {
  assertFalse(
    makeAction().applies(makeTicket({ ...BASE, providerPickedUp: true })),
  );
});

Deno.test("jiraPickupAction: does not apply when ticket project key does not match configured project", () => {
  assertFalse(
    makeAction({ project: "ACME" }).applies(makeTicket(BASE)),
  );
});

Deno.test("jiraPickupAction: applies when ticket project key matches configured project", () => {
  assert(makeAction({ project: "PROJ" }).applies(makeTicket(BASE)));
});

Deno.test("jiraPickupAction: run calls GET issue endpoint then POST with in-progress id for correct issue key", async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const result = await makeAction({
    http: new HttpClient((url, init) => {
      calls.push({
        url: url as string,
        method: init?.method ?? "GET",
        body: init?.body as string | undefined,
      });
      if (init?.method === "POST") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            fields: { status: { name: "To Do" } },
            transitions: [
              { id: "31", to: { name: "In Progress" } },
            ],
          }),
          { status: 200 },
        ),
      );
    }),
  }).run(makeTicket(BASE), "/state");
  assert(result?.providerPickedUp);
  assertEquals(calls.length, 2);
  assertStringIncludes(calls[0].url, "/issue/PROJ-42?");
  assertStringIncludes(calls[0].url, "fields=status");
  assertEquals(calls[0].method, "GET");
  assertStringIncludes(calls[1].url, "/issue/PROJ-42/transitions");
  assertEquals(calls[1].method, "POST");
  assertEquals(
    JSON.parse(calls[1].body!),
    { transition: { id: "31" } },
  );
});

Deno.test("jiraPickupAction: run returns ticket with providerPickedUp: true on success", async () => {
  const result = await makeAction({
    http: new HttpClient(makeIssueFetch("To Do", [
      { id: "31", to: { name: "In Progress" } },
    ])),
  }).run(makeTicket(BASE), "/state");
  assert(result?.providerPickedUp);
});

Deno.test("jiraPickupAction: run calls writeTicket with providerPickedUp: true on success", async () => {
  const written: Array<{ id: string; providerPickedUp?: boolean }> = [];
  await makeAction({
    http: new HttpClient(makeIssueFetch("To Do", [
      { id: "31", to: { name: "In Progress" } },
    ])),
    writeTicket: (_dir, t) => {
      written.push({ id: t.id, providerPickedUp: t.providerPickedUp });
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assertEquals(written.length, 1);
  assertEquals(written[0].id, "jira/PROJ-42");
  assert(written[0].providerPickedUp);
});

Deno.test("jiraPickupAction: run skips POST when issue is already in In Progress", async () => {
  const calls: Array<{ method: string }> = [];
  const result = await makeAction({
    http: new HttpClient((_url, init) => {
      calls.push({ method: init?.method ?? "GET" });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            fields: { status: { name: "In Progress" } },
            transitions: [{ id: "31", to: { name: "In Progress" } }],
          }),
          { status: 200 },
        ),
      );
    }),
  }).run(makeTicket(BASE), "/state");
  assert(result?.providerPickedUp);
  assertEquals(calls.filter((c) => c.method === "POST").length, 0);
});

Deno.test("jiraPickupAction: run logs error and returns null when transition throws", async () => {
  const logged: object[] = [];
  const result = await makeAction({
    http: new HttpClient((_url, _init) =>
      Promise.resolve(new Response("Forbidden", { status: 403 }))
    ),
    appendLog: (_stateDir, _id, entry) => {
      logged.push(entry);
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assertEquals(result, null);
  assertEquals(logged.length, 1);
  assertEquals((logged[0] as Record<string, string>).event, "error");
  assertEquals((logged[0] as Record<string, string>).context, "jiraPickup");
});

Deno.test("jiraPickupAction: run logs error when no matching transition found", async () => {
  const logged: object[] = [];
  await makeAction({
    http: new HttpClient(makeIssueFetch("To Do", [
      { id: "10", to: { name: "Done" } },
    ])),
    appendLog: (_stateDir, _id, entry) => {
      logged.push(entry);
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assertEquals((logged[0] as Record<string, string>).event, "error");
  assertEquals((logged[0] as Record<string, string>).context, "jiraPickup");
});

Deno.test("jiraPickupAction: run transitions to the configured status name", async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  await makeAction({
    targetStatusName: "In Review",
    http: new HttpClient((url, init) => {
      calls.push({
        url: url as string,
        method: init?.method ?? "GET",
        body: init?.body as string | undefined,
      });
      if (init?.method === "POST") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            fields: { status: { name: "To Do" } },
            transitions: [{ id: "55", to: { name: "In Review" } }],
          }),
          { status: 200 },
        ),
      );
    }),
  }).run(makeTicket(BASE), "/state");
  assertEquals(JSON.parse(calls[1].body!), { transition: { id: "55" } });
});
