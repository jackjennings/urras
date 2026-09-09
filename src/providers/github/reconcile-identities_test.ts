import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertFalse,
} from "@std/assert";
import { HttpClient } from "../../http-client.ts";
import {
  CorruptRepoIdentitiesError,
  type RepoIdentityTable,
} from "./repo-identity.ts";
import {
  reconcileOrgIdentities,
  reconcileRepoIdentities,
} from "./reconcile-identities.ts";
import type { OrgIdentityTable } from "./org-identity.ts";

function makeHttp(handler: typeof fetch): HttpClient {
  return new HttpClient(handler);
}

function makeDeps(
  overrides: Partial<Parameters<typeof reconcileRepoIdentities>[0]> = {},
): Parameters<typeof reconcileRepoIdentities>[0] {
  return {
    http: makeHttp(() => Promise.resolve(new Response("", { status: 404 }))),
    accountResolver: () => ({ token: "tok", login: "user" }),
    readTable: () => Promise.resolve({}),
    writeTable: () => Promise.resolve(),
    log: () => {},
    notify: () => Promise.resolve(),
    repos: [],
    ...overrides,
  };
}

Deno.test(
  "reconcileRepoIdentities: rename detected via /repositories/<repoId>",
  async () => {
    const table: RepoIdentityTable = {
      "foo/bar": {
        repoId: 42,
        currentSlug: "foo/bar",
        aliases: ["foo/bar"],
        blockedBy: null,
      },
    };
    const written: RepoIdentityTable[] = [];
    const notifyTitles: string[] = [];
    const { confirmed } = await reconcileRepoIdentities(makeDeps({
      readTable: () => Promise.resolve({ ...table }),
      writeTable: (t) => {
        written.push(t);
        return Promise.resolve();
      },
      notify: (title) => {
        notifyTitles.push(title);
        return Promise.resolve();
      },
      http: makeHttp((url) => {
        if ((url as string).includes("/repositories/42")) {
          return Promise.resolve(
            new Response(JSON.stringify({ full_name: "foo/baz" }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      }),
    }));
    assertEquals(written.length, 1);
    assertEquals(written[0]["foo/bar"].currentSlug, "foo/baz");
    assertArrayIncludes(written[0]["foo/bar"].aliases, ["foo/bar", "foo/baz"]);
    assertEquals(notifyTitles.length, 1);
    assert(confirmed.has("foo/bar"));
    assertEquals(confirmed.get("foo/bar")!.currentSlug, "foo/baz");
  },
);

Deno.test(
  "reconcileRepoIdentities: re-run on updated table does not re-notify",
  async () => {
    const table: RepoIdentityTable = {
      "foo/bar": {
        repoId: 42,
        currentSlug: "foo/baz",
        aliases: ["foo/bar", "foo/baz"],
        blockedBy: null,
      },
    };
    const notifyTitles: string[] = [];
    await reconcileRepoIdentities(makeDeps({
      readTable: () => Promise.resolve({ ...table }),
      notify: (title) => {
        notifyTitles.push(title);
        return Promise.resolve();
      },
      http: makeHttp((url) => {
        if ((url as string).includes("/repositories/42")) {
          return Promise.resolve(
            new Response(JSON.stringify({ full_name: "foo/baz" }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      }),
    }));
    assertEquals(notifyTitles.length, 0);
  },
);

Deno.test(
  "reconcileRepoIdentities: config slug matching known repoId appends alias, leaves canonical unchanged",
  async () => {
    const table: RepoIdentityTable = {
      "foo/bar": {
        repoId: 99,
        currentSlug: "foo/baz",
        aliases: ["foo/bar", "foo/baz"],
        blockedBy: null,
      },
    };
    const written: RepoIdentityTable[] = [];
    await reconcileRepoIdentities(makeDeps({
      repos: ["foo/baz-renamed"],
      readTable: () => Promise.resolve({ ...table }),
      writeTable: (t) => {
        written.push(t);
        return Promise.resolve();
      },
      http: makeHttp((url) => {
        if ((url as string).includes("/repositories/99")) {
          return Promise.resolve(
            new Response(JSON.stringify({ full_name: "foo/baz" }), {
              status: 200,
            }),
          );
        }
        if ((url as string).includes("/repos/foo/baz-renamed")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ id: 99, full_name: "foo/baz" }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      }),
    }));
    const result = written[written.length - 1] ?? table;
    assertEquals(Object.keys(result).includes("foo/bar"), true);
    assertEquals(Object.keys(result).includes("foo/baz-renamed"), false);
    assertArrayIncludes(result["foo/bar"].aliases, ["foo/baz-renamed"]);
  },
);

Deno.test(
  "reconcileRepoIdentities: null-repoId entry confirmed before new config slug resolved",
  async () => {
    const callOrder: string[] = [];
    const table: RepoIdentityTable = {
      "foo/old": {
        repoId: null,
        currentSlug: "foo/old",
        aliases: ["foo/old"],
        seenBefore: "2026-01-01T00:00:00Z",
        blockedBy: null,
      },
    };
    await reconcileRepoIdentities(makeDeps({
      repos: ["foo/new"],
      readTable: () => Promise.resolve({ ...table }),
      http: makeHttp((url) => {
        if ((url as string).includes("/repos/foo/old")) {
          callOrder.push("confirm-null");
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: 7,
                full_name: "foo/old",
                created_at: "2025-01-01T00:00:00Z",
              }),
              { status: 200 },
            ),
          );
        }
        if ((url as string).includes("/repos/foo/new")) {
          callOrder.push("resolve-new");
          return Promise.resolve(
            new Response(
              JSON.stringify({ id: 8, full_name: "foo/new" }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      }),
    }));
    assert(
      callOrder.indexOf("confirm-null") < callOrder.indexOf("resolve-new"),
    );
  },
);

Deno.test(
  "reconcileRepoIdentities: seeded entry with created_at > seenBefore is blocked",
  async () => {
    const table: RepoIdentityTable = {
      "foo/old": {
        repoId: null,
        currentSlug: "foo/old",
        aliases: ["foo/old"],
        seenBefore: "2024-01-01T00:00:00Z",
        blockedBy: null,
      },
    };
    const written: RepoIdentityTable[] = [];
    await reconcileRepoIdentities(makeDeps({
      readTable: () => Promise.resolve({ ...table }),
      writeTable: (t) => {
        written.push(t);
        return Promise.resolve();
      },
      http: makeHttp((url) => {
        if ((url as string).includes("/repos/foo/old")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: 5,
                full_name: "foo/old",
                created_at: "2025-06-01T00:00:00Z",
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      }),
    }));
    const result = written[written.length - 1];
    assert(result !== undefined);
    assertEquals(result["foo/old"].blockedBy, 5);
    assertEquals(result["foo/old"].repoId, null);
  },
);

Deno.test(
  "reconcileRepoIdentities: 404 on /repositories/<id> leaves table unwritten",
  async () => {
    const table: RepoIdentityTable = {
      "foo/bar": {
        repoId: 1,
        currentSlug: "foo/bar",
        aliases: ["foo/bar"],
        blockedBy: null,
      },
    };
    const written: RepoIdentityTable[] = [];
    await reconcileRepoIdentities(makeDeps({
      readTable: () => Promise.resolve({ ...table }),
      writeTable: (t) => {
        written.push(t);
        return Promise.resolve();
      },
      http: makeHttp(() => Promise.resolve(new Response("", { status: 404 }))),
    }));
    assertEquals(written.length, 0);
  },
);

Deno.test(
  "reconcileRepoIdentities: network error leaves table unwritten",
  async () => {
    const table: RepoIdentityTable = {
      "foo/bar": {
        repoId: 1,
        currentSlug: "foo/bar",
        aliases: ["foo/bar"],
        blockedBy: null,
      },
    };
    const written: RepoIdentityTable[] = [];
    await reconcileRepoIdentities(makeDeps({
      readTable: () => Promise.resolve({ ...table }),
      writeTable: (t) => {
        written.push(t);
        return Promise.resolve();
      },
      http: makeHttp(() => Promise.reject(new Error("network down"))),
    }));
    assertEquals(written.length, 0);
  },
);

Deno.test(
  "reconcileRepoIdentities: collision sets blockedBy, notifies once, does not re-notify",
  async () => {
    const table: RepoIdentityTable = {
      "foo/bar": {
        repoId: 1,
        currentSlug: "foo/bar",
        aliases: ["foo/bar"],
        blockedBy: null,
      },
    };
    const notifyTitles: string[] = [];
    await reconcileRepoIdentities(makeDeps({
      repos: ["foo/bar"],
      readTable: () => Promise.resolve({ ...table }),
      notify: (title) => {
        notifyTitles.push(title);
        return Promise.resolve();
      },
      http: makeHttp((url) => {
        if ((url as string).includes("/repositories/1")) {
          return Promise.resolve(
            new Response(JSON.stringify({ full_name: "foo/bar" }), {
              status: 200,
            }),
          );
        }
        if ((url as string).includes("/repos/foo/bar")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ id: 99, full_name: "foo/bar" }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      }),
    }));
    assertEquals(notifyTitles.length, 1);

    const blockedTable: RepoIdentityTable = {
      "foo/bar": {
        repoId: 1,
        currentSlug: "foo/bar",
        aliases: ["foo/bar"],
        blockedBy: 99,
      },
    };
    const notifyTitles2: string[] = [];
    await reconcileRepoIdentities(makeDeps({
      repos: ["foo/bar"],
      readTable: () => Promise.resolve({ ...blockedTable }),
      notify: (title) => {
        notifyTitles2.push(title);
        return Promise.resolve();
      },
      http: makeHttp((url) => {
        if ((url as string).includes("/repositories/1")) {
          return Promise.resolve(
            new Response(JSON.stringify({ full_name: "foo/bar" }), {
              status: 200,
            }),
          );
        }
        if ((url as string).includes("/repos/foo/bar")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ id: 99, full_name: "foo/bar" }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      }),
    }));
    assertEquals(notifyTitles2.length, 0);
  },
);

// Suppress unused import lint warning
const _unused = CorruptRepoIdentitiesError;
assertFalse(_unused === undefined);

function makeOrgDeps(
  overrides: Partial<Parameters<typeof reconcileOrgIdentities>[0]> = {},
): Parameters<typeof reconcileOrgIdentities>[0] {
  return {
    http: makeHttp(() => Promise.resolve(new Response("{}", { status: 404 }))),
    accountResolver: () => ({ token: "tok", login: "user" }),
    readTable: () => Promise.resolve({}),
    writeTable: () => Promise.resolve(),
    log: () => {},
    notify: () => Promise.resolve(),
    orgs: [],
    ...overrides,
  };
}

Deno.test(
  "reconcileOrgIdentities: registers a new bare-org entry keyed by its login",
  async () => {
    const written: OrgIdentityTable[] = [];
    await reconcileOrgIdentities(makeOrgDeps({
      orgs: ["hellboxpy"],
      writeTable: (t) => {
        written.push(t);
        return Promise.resolve();
      },
      http: makeHttp((_url, init) => {
        const body = JSON.parse((init as RequestInit)?.body as string ?? "{}");
        if (body.query?.includes("organization")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  organization: { databaseId: 99, login: "hellboxpy" },
                },
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("{}", { status: 404 }));
      }),
    }));
    assertEquals(written.length, 1);
    assertEquals(written[0]["hellboxpy"].orgId, 99);
    assertEquals(written[0]["hellboxpy"].currentLogin, "hellboxpy");
    assertArrayIncludes(written[0]["hellboxpy"].aliases, ["hellboxpy"]);
  },
);

Deno.test(
  "reconcileOrgIdentities: detects org rename via /organizations/<orgId>",
  async () => {
    const table: OrgIdentityTable = {
      hellboxpy: {
        orgId: 42,
        currentLogin: "hellboxpy",
        aliases: ["hellboxpy"],
      },
    };
    const written: OrgIdentityTable[] = [];
    const notifyTitles: string[] = [];
    const loggedEvents: string[] = [];
    await reconcileOrgIdentities(makeOrgDeps({
      readTable: () => Promise.resolve({ ...table }),
      writeTable: (t) => {
        written.push(t);
        return Promise.resolve();
      },
      notify: (title) => {
        notifyTitles.push(title);
        return Promise.resolve();
      },
      log: (event) => {
        loggedEvents.push(event);
      },
      http: makeHttp((url) => {
        if ((url as string).includes("/organizations/42")) {
          return Promise.resolve(
            new Response(JSON.stringify({ login: "hellbox" }), { status: 200 }),
          );
        }
        return Promise.resolve(new Response("{}", { status: 404 }));
      }),
    }));
    assertEquals(written.length, 1);
    assertEquals(written[0]["hellboxpy"].currentLogin, "hellbox");
    assertArrayIncludes(written[0]["hellboxpy"].aliases, [
      "hellboxpy",
      "hellbox",
    ]);
    assertEquals(notifyTitles.length, 1);
    assertArrayIncludes(loggedEvents, ["org-renamed"]);
  },
);

Deno.test(
  "reconcileOrgIdentities: non-ok response on refresh logs failure and leaves table unwritten",
  async () => {
    const table: OrgIdentityTable = {
      hellboxpy: {
        orgId: 42,
        currentLogin: "hellboxpy",
        aliases: ["hellboxpy"],
      },
    };
    const loggedEvents: string[] = [];
    const written: OrgIdentityTable[] = [];
    await reconcileOrgIdentities(makeOrgDeps({
      readTable: () => Promise.resolve({ ...table }),
      writeTable: (t) => {
        written.push(t);
        return Promise.resolve();
      },
      log: (event) => {
        loggedEvents.push(event);
      },
      http: makeHttp(() =>
        Promise.resolve(new Response("{}", { status: 500 }))
      ),
    }));
    assertEquals(written.length, 0);
    assertArrayIncludes(loggedEvents, ["org-identity-reconcile-failed"]);
  },
);

Deno.test(
  "reconcileOrgIdentities: does not re-register an org already in the table",
  async () => {
    const table: OrgIdentityTable = {
      hellboxpy: {
        orgId: 42,
        currentLogin: "hellboxpy",
        aliases: ["hellboxpy"],
      },
    };
    const orgLookupCalls: string[] = [];
    await reconcileOrgIdentities(makeOrgDeps({
      orgs: ["hellboxpy"],
      readTable: () => Promise.resolve({ ...table }),
      http: makeHttp((url, init) => {
        const body = JSON.parse((init as RequestInit)?.body as string ?? "{}");
        if (body.query?.includes("organization")) {
          orgLookupCalls.push("org-lookup");
        }
        if ((url as string).includes("/organizations/42")) {
          return Promise.resolve(
            new Response(JSON.stringify({ login: "hellboxpy" }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(new Response("{}", { status: 404 }));
      }),
    }));
    assertEquals(orgLookupCalls.length, 0);
  },
);
