import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { jiraDoneAction } from "./jira-done.ts";
import type { TicketState } from "../state/types.ts";
import { makeTicket } from "../test-support.ts";
import { HttpClient } from "../http-client.ts";

function makeAction(
  overrides: Partial<Parameters<typeof jiraDoneAction>[0]> = {},
) {
  return jiraDoneAction({
    baseUrl: "https://myorg.atlassian.net",
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    targetStatusName: "Done",
    writeTicket: () => Promise.resolve(),
    appendLog: () => Promise.resolve(),
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

const successFetch = makeIssueFetch("To Do", [
  { id: "41", to: { name: "Done" } },
]);

const BASE = {
  id: "jira/PROJ-42",
  provider: "jira" as const,
  url: "https://myorg.atlassian.net/browse/PROJ-42",
  phase: "merge" as const,
  status: "done" as const,
  created: "2026-07-01T00:00:00Z",
  updated: "2026-07-01T00:00:00Z",
};

Deno.test("jiraDoneAction: applies when provider jira, phase merge, status done, providerDone not set", () => {
  assert(makeAction().applies(makeTicket(BASE)));
});

Deno.test("jiraDoneAction: does not apply when providerDone is true", () => {
  assertFalse(
    makeAction().applies(makeTicket({ ...BASE, providerDone: true })),
  );
});

Deno.test("jiraDoneAction: does not apply when provider is not jira", () => {
  assertFalse(
    makeAction().applies(makeTicket({ ...BASE, provider: "github" })),
  );
});

Deno.test("jiraDoneAction: does not apply when phase is not merge", () => {
  assertFalse(
    makeAction().applies(
      makeTicket({ ...BASE, phase: "implementation" as const }),
    ),
  );
});

Deno.test("jiraDoneAction: does not apply when status is not done", () => {
  assertFalse(
    makeAction().applies(makeTicket({ ...BASE, status: "waiting" })),
  );
});

Deno.test("jiraDoneAction: does not apply when ticket project key does not match configured project", () => {
  assertFalse(
    makeAction({ project: "ACME" }).applies(makeTicket(BASE)),
  );
});

Deno.test("jiraDoneAction: applies when ticket project key matches configured project", () => {
  assert(makeAction({ project: "PROJ" }).applies(makeTicket(BASE)));
});

Deno.test("jiraDoneAction: run returns ticket with providerDone: true on success", async () => {
  const result = await makeAction({ http: new HttpClient(successFetch) }).run(
    makeTicket(BASE),
    "/state",
  );
  assert(result?.providerDone);
});

Deno.test("jiraDoneAction: run calls writeTicket with providerDone: true on success", async () => {
  const written: Partial<TicketState>[] = [];
  await makeAction({
    http: new HttpClient(successFetch),
    writeTicket: (_dir, t) => {
      written.push({ id: t.id, providerDone: t.providerDone });
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assertEquals(written.length, 1);
  assertEquals(written[0].id, "jira/PROJ-42");
  assert(written[0].providerDone);
});

Deno.test("jiraDoneAction: run calls GET issue endpoint then POST with done id for correct issue key", async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  await makeAction({
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
              { id: "41", to: { name: "Done" } },
            ],
          }),
          { status: 200 },
        ),
      );
    }),
  }).run(makeTicket(BASE), "/state");
  assertStringIncludes(calls[0].url, "/issue/PROJ-42?");
  assertStringIncludes(calls[0].url, "fields=status");
  assertEquals(calls[0].method, "GET");
  assertEquals(calls[1].method, "POST");
  assertEquals(
    JSON.parse(calls[1].body!),
    { transition: { id: "41" } },
  );
});

Deno.test("jiraDoneAction: run skips POST when issue is already in Done", async () => {
  const calls: Array<{ method: string }> = [];
  const result = await makeAction({
    http: new HttpClient((_url, init) => {
      calls.push({ method: init?.method ?? "GET" });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            fields: { status: { name: "Done" } },
            transitions: [{ id: "41", to: { name: "Done" } }],
          }),
          { status: 200 },
        ),
      );
    }),
  }).run(makeTicket(BASE), "/state");
  assert(result?.providerDone);
  assertEquals(calls.filter((c) => c.method === "POST").length, 0);
});

Deno.test("jiraDoneAction: run logs error and returns null when transition throws", async () => {
  const logged: object[] = [];
  const result = await makeAction({
    http: new HttpClient((_url, _init) =>
      Promise.resolve(new Response("Error", { status: 500 }))
    ),
    appendLog: (_stateDir, _id, entry) => {
      logged.push(entry);
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assertEquals(result, null);
  assertEquals(logged.length, 1);
  assertEquals((logged[0] as Record<string, string>).event, "error");
  assertEquals((logged[0] as Record<string, string>).context, "jiraDone");
});

Deno.test("jiraDoneAction: run does not call writeTicket when transition throws", async () => {
  const written: unknown[] = [];
  await makeAction({
    http: new HttpClient((_url, _init) =>
      Promise.resolve(new Response("Error", { status: 500 }))
    ),
    writeTicket: (_dir, t) => {
      written.push(t);
      return Promise.resolve();
    },
  }).run(makeTicket(BASE), "/state");
  assertEquals(written.length, 0);
});

Deno.test("jiraDoneAction: run transitions to the configured status name", async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  await makeAction({
    targetStatusName: "Resolved",
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
            transitions: [{ id: "99", to: { name: "Resolved" } }],
          }),
          { status: 200 },
        ),
      );
    }),
  }).run(makeTicket(BASE), "/state");
  assertEquals(JSON.parse(calls[1].body!), { transition: { id: "99" } });
});
