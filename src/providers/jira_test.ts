import {
  assertEquals,
  assertFalse,
  assertLess,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { JiraProvider } from "./jira.ts";
import { compareSortKeys } from "./types.ts";
import { HttpClient } from "../http-client.ts";

const BASE_URL = "https://myorg.atlassian.net";

function makeIssue(
  key: string,
  summary: string,
  description: unknown = null,
  parentKey?: string,
) {
  const fields: {
    summary: string;
    description: unknown;
    parent?: { key: string; fields: { summary: string } };
  } = { summary, description };
  if (parentKey) fields.parent = { key: parentKey, fields: { summary: "" } };
  return { id: "10001", key, fields };
}

function adfText(text: string) {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

Deno.test("fetchNew returns all items when knownIds is empty", async () => {
  const provider = new JiraProvider({
    baseUrl: BASE_URL,
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    doneStatusName: "Done",
    http: new HttpClient((_url, _init) =>
      Promise.resolve(
        new Response(
          JSON.stringify({ issues: [makeIssue("PROJ-1", "Issue One")] }),
          { status: 200 },
        ),
      )
    ),
  });
  const items = await provider.fetchNew(new Set());
  assertEquals(items.length, 1);
  assertEquals(items[0].id, "jira/PROJ-1");
  assertEquals(items[0].provider, "jira");
  assertEquals(items[0].title, "Issue One");
  assertEquals(items[0].url, `${BASE_URL}/browse/PROJ-1`);
});

Deno.test("fetchNew filters known IDs", async () => {
  const provider = new JiraProvider({
    baseUrl: BASE_URL,
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    doneStatusName: "Done",
    http: new HttpClient((_url, _init) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            issues: [
              makeIssue("PROJ-1", "One"),
              makeIssue("PROJ-2", "Two"),
            ],
          }),
          { status: 200 },
        ),
      )
    ),
  });
  const items = await provider.fetchNew(new Set(["jira/PROJ-1"]));
  assertEquals(items.length, 1);
  assertEquals(items[0].id, "jira/PROJ-2");
});

Deno.test("fetchNew does not re-create an issue tracked under its legacy jira-<KEY> id", async () => {
  const provider = new JiraProvider({
    baseUrl: BASE_URL,
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    doneStatusName: "Done",
    http: new HttpClient((_url, _init) =>
      Promise.resolve(
        new Response(
          JSON.stringify({ issues: [makeIssue("PROJ-1", "One")] }),
          { status: 200 },
        ),
      )
    ),
  });
  const items = await provider.fetchNew(new Set(["jira-PROJ-1"]));
  assertEquals(items.length, 0);
});

Deno.test("fetchNew uses POST to /rest/api/3/search/jql", async () => {
  let capturedUrl = "";
  let capturedMethod = "";
  const provider = new JiraProvider({
    baseUrl: BASE_URL,
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    doneStatusName: "Done",
    http: new HttpClient((url, init) => {
      capturedUrl = url as string;
      capturedMethod = init?.method ?? "GET";
      return Promise.resolve(
        new Response(JSON.stringify({ issues: [] }), { status: 200 }),
      );
    }),
  });
  await provider.fetchNew(new Set());
  assertEquals(capturedUrl, `${BASE_URL}/rest/api/3/search/jql`);
  assertEquals(capturedMethod, "POST");
});

Deno.test("fetchNew throws on non-2xx response", async () => {
  const provider = new JiraProvider({
    baseUrl: BASE_URL,
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    doneStatusName: "Done",
    http: new HttpClient((_url, _init) =>
      Promise.resolve(new Response("Unauthorized", { status: 401 }))
    ),
  });
  await assertRejects(
    () => provider.fetchNew(new Set()),
    Error,
    "Jira API error: 401",
  );
});

Deno.test("fetchNew skips issues with missing fields", async () => {
  const provider = new JiraProvider({
    baseUrl: BASE_URL,
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    doneStatusName: "Done",
    http: new HttpClient((_url, _init) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            issues: [
              { id: "1", key: "PROJ-1" },
              makeIssue("PROJ-2", "Valid"),
            ],
          }),
          { status: 200 },
        ),
      )
    ),
  });
  const items = await provider.fetchNew(new Set());
  assertEquals(items.length, 1);
  assertEquals(items[0].id, "jira/PROJ-2");
});

Deno.test("fetchNew description is empty string when fields.description is null", async () => {
  const provider = new JiraProvider({
    baseUrl: BASE_URL,
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    doneStatusName: "Done",
    http: new HttpClient((_url, _init) =>
      Promise.resolve(
        new Response(
          JSON.stringify({ issues: [makeIssue("PROJ-1", "T", null)] }),
          { status: 200 },
        ),
      )
    ),
  });
  const items = await provider.fetchNew(new Set());
  assertEquals(items[0].description, "");
});

Deno.test("fetchNew description is empty string when fields.description is undefined", async () => {
  const provider = new JiraProvider({
    baseUrl: BASE_URL,
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    doneStatusName: "Done",
    http: new HttpClient((_url, _init) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            issues: [{ id: "1", key: "PROJ-1", fields: { summary: "T" } }],
          }),
          { status: 200 },
        ),
      )
    ),
  });
  const items = await provider.fetchNew(new Set());
  assertEquals(items[0].description, "");
});

Deno.test("close transitions the issue to the done status category", async () => {
  const requests: Array<{ url: string; method?: string; body?: string }> = [];
  const provider = new JiraProvider({
    baseUrl: BASE_URL,
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    doneStatusName: "Done",
    http: new HttpClient((url, init) => {
      requests.push({
        url: url as string,
        method: init?.method,
        body: init?.body as string,
      });
      if (init?.method !== "POST") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              fields: { status: { name: "To Do" } },
              transitions: [
                { id: "31", to: { name: "Done" } },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }),
  });
  await provider.close(`${BASE_URL}/browse/PROJ-1`);
  assertStringIncludes(
    requests[0].url,
    `/rest/api/3/issue/PROJ-1?`,
  );
  assertEquals(requests[1].method, "POST");
  assertEquals(JSON.parse(requests[1].body!), { transition: { id: "31" } });
});

Deno.test("close throws on unrecognized URL", async () => {
  const provider = new JiraProvider({
    baseUrl: BASE_URL,
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    doneStatusName: "Done",
    http: new HttpClient(),
  });
  await assertRejects(
    () => provider.close("https://example.com/not-a-jira-issue"),
    Error,
  );
});

Deno.test("fetchNew description is Markdown when fields.description is an ADF object", async () => {
  const desc = {
    type: "doc",
    version: 1,
    content: [{
      type: "paragraph",
      content: [{ type: "text", text: "Hello world" }],
    }],
  };
  const provider = new JiraProvider({
    baseUrl: BASE_URL,
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    doneStatusName: "Done",
    http: new HttpClient((_url, _init) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            issues: [makeIssue("PROJ-1", "T", desc)],
          }),
          { status: 200 },
        ),
      )
    ),
  });
  const items = await provider.fetchNew(new Set());
  assertEquals(items[0].description, "Hello world");
});

Deno.test("toSortable: jira/PROJ-3 returns [PROJ, 3]", () => {
  assertEquals(JiraProvider.toSortable("jira/PROJ-3"), ["PROJ", 3]);
});

Deno.test("toSortable: issue 3 sorts before issue 12 via compareSortKeys", () => {
  assertLess(
    compareSortKeys(
      JiraProvider.toSortable("jira/PROJ-3"),
      JiraProvider.toSortable("jira/PROJ-12"),
    ),
    0,
  );
});

Deno.test("toSortable: different projects sort by key first", () => {
  assertLess(
    compareSortKeys(
      JiraProvider.toSortable("jira/ABC-100"),
      JiraProvider.toSortable("jira/PROJ-1"),
    ),
    0,
  );
});

Deno.test("toSortable: malformed id falls back to [id]", () => {
  assertEquals(JiraProvider.toSortable("jira/malformed"), ["jira/malformed"]);
});

Deno.test("fetchNew appends parent context when issue has one parent", async () => {
  const provider = new JiraProvider({
    baseUrl: BASE_URL,
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    doneStatusName: "Done",
    http: new HttpClient((url, _init) => {
      if ((url as string) === `${BASE_URL}/rest/api/3/search/jql`) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              issues: [makeIssue("PROJ-1", "Sub-task", null, "STORY-10")],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            fields: { summary: "The Story", description: null },
          }),
          { status: 200 },
        ),
      );
    }),
  });
  const items = await provider.fetchNew(new Set());
  assertEquals(items.length, 1);
  assertStringIncludes(items[0].description, "\n\n---\n\n");
  assertStringIncludes(
    items[0].description,
    "## Parent context: STORY-10 — The Story",
  );
});

Deno.test(
  "fetchNew appends parent and grandparent context for two-level ancestor chain",
  async () => {
    const provider = new JiraProvider({
      baseUrl: BASE_URL,
      email: "test@example.com",
      apiToken: "token",
      project: "PROJ",
      doneStatusName: "Done",
      http: new HttpClient((url, _init) => {
        if ((url as string) === `${BASE_URL}/rest/api/3/search/jql`) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                issues: [makeIssue("PROJ-1", "Sub-task", null, "STORY-10")],
              }),
              { status: 200 },
            ),
          );
        }
        if ((url as string).includes("/issue/STORY-10")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                fields: {
                  summary: "The Story",
                  description: null,
                  parent: { key: "EPIC-5" },
                },
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              fields: { summary: "The Epic", description: null },
            }),
            { status: 200 },
          ),
        );
      }),
    });
    const items = await provider.fetchNew(new Set());
    assertEquals(items.length, 1);
    assertStringIncludes(
      items[0].description,
      "## Parent context: STORY-10 — The Story",
    );
    assertStringIncludes(
      items[0].description,
      "## Parent context: EPIC-5 — The Epic",
    );
    const separatorCount = (items[0].description.match(/\n---\n/g) ?? [])
      .length;
    assertEquals(separatorCount, 1);
  },
);

Deno.test("fetchNew description is unchanged when issue has no parent", async () => {
  const provider = new JiraProvider({
    baseUrl: BASE_URL,
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    doneStatusName: "Done",
    http: new HttpClient((_url, _init) =>
      Promise.resolve(
        new Response(
          JSON.stringify({ issues: [makeIssue("PROJ-1", "Issue One")] }),
          { status: 200 },
        ),
      )
    ),
  });
  const items = await provider.fetchNew(new Set());
  assertEquals(items[0].description, "");
});

Deno.test(
  "fetchNew ingests issue normally when parent fetch returns 404",
  async () => {
    const provider = new JiraProvider({
      baseUrl: BASE_URL,
      email: "test@example.com",
      apiToken: "token",
      project: "PROJ",
      doneStatusName: "Done",
      http: new HttpClient((url, _init) => {
        if ((url as string) === `${BASE_URL}/rest/api/3/search/jql`) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                issues: [makeIssue("PROJ-1", "Sub-task", null, "STORY-10")],
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }),
    });
    const items = await provider.fetchNew(new Set());
    assertEquals(items.length, 1);
    assertFalse(items[0].description.includes("Parent context"));
    assertFalse(items[0].description.includes("---"));
  },
);

Deno.test(
  "fetchNew ingests issue normally when parent fetch returns 403",
  async () => {
    const provider = new JiraProvider({
      baseUrl: BASE_URL,
      email: "test@example.com",
      apiToken: "token",
      project: "PROJ",
      doneStatusName: "Done",
      http: new HttpClient((url, _init) => {
        if ((url as string) === `${BASE_URL}/rest/api/3/search/jql`) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                issues: [makeIssue("PROJ-1", "Sub-task", null, "STORY-10")],
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("Forbidden", { status: 403 }));
      }),
    });
    const items = await provider.fetchNew(new Set());
    assertEquals(items.length, 1);
    assertFalse(items[0].description.includes("Parent context"));
  },
);

Deno.test("fetchNew fetches comments from the Jira comment endpoint", async () => {
  const commentUrls: string[] = [];
  const provider = new JiraProvider({
    baseUrl: BASE_URL,
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    doneStatusName: "Done",
    http: new HttpClient((url, _init) => {
      const urlStr = url as string;
      if (urlStr.includes("/rest/api/3/search")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ issues: [makeIssue("PROJ-1", "Issue")] }),
            { status: 200 },
          ),
        );
      }
      if (urlStr.includes("/comment")) {
        commentUrls.push(urlStr);
      }
      return Promise.resolve(
        new Response(JSON.stringify({ comments: [] }), { status: 200 }),
      );
    }),
    run: (_args) => Promise.resolve({ code: 1, stdout: "" }),
  });
  await provider.fetchNew(new Set());
  assertEquals(commentUrls.length, 1);
  assertEquals(
    commentUrls[0],
    `${BASE_URL}/rest/api/3/issue/PROJ-1/comment?maxResults=50`,
  );
});

Deno.test("fetchNew appends kept comments to description", async () => {
  const provider = new JiraProvider({
    baseUrl: BASE_URL,
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    doneStatusName: "Done",
    http: new HttpClient((url, _init) => {
      const urlStr = url as string;
      if (urlStr.includes("/rest/api/3/search")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ issues: [makeIssue("PROJ-1", "Issue")] }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            comments: [{
              author: { displayName: "Alice" },
              body: adfText("Useful technical info"),
              created: "2025-01-15T10:30:00Z",
            }],
          }),
          { status: 200 },
        ),
      );
    }),
    run: (args) =>
      Promise.resolve(
        args[0] === "apfel" ? { code: 0, stdout: "KEEP" } : {
          code: 1,
          stdout: "",
        },
      ),
  });
  const items = await provider.fetchNew(new Set());
  assertStringIncludes(items[0].description, "---\n\n## Comments");
  assertStringIncludes(items[0].description, "**Alice** (2025-01-15)");
  assertStringIncludes(items[0].description, "Useful technical info");
});

Deno.test("fetchNew omits rejected comments from description", async () => {
  const provider = new JiraProvider({
    baseUrl: BASE_URL,
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    doneStatusName: "Done",
    http: new HttpClient((url, _init) => {
      const urlStr = url as string;
      if (urlStr.includes("/rest/api/3/search")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ issues: [makeIssue("PROJ-1", "Issue")] }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            comments: [{
              author: { displayName: "Bob" },
              body: adfText("Any update on this?"),
              created: "2025-01-15T10:30:00Z",
            }],
          }),
          { status: 200 },
        ),
      );
    }),
    run: (args) =>
      Promise.resolve(
        args[0] === "apfel"
          ? { code: 0, stdout: JSON.stringify({ verdict: "SKIP" }) }
          : { code: 1, stdout: "" },
      ),
  });
  const items = await provider.fetchNew(new Set());
  assertFalse(items[0].description.includes("## Comments"));
  assertFalse(items[0].description.includes("Any update on this?"));
});

Deno.test("fetchNew appends no Comments section when issue has no comments", async () => {
  const provider = new JiraProvider({
    baseUrl: BASE_URL,
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    doneStatusName: "Done",
    http: new HttpClient((url, _init) => {
      const urlStr = url as string;
      if (urlStr.includes("/rest/api/3/search")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ issues: [makeIssue("PROJ-1", "Issue")] }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ comments: [] }), { status: 200 }),
      );
    }),
    run: (_args) => Promise.resolve({ code: 1, stdout: "" }),
  });
  const items = await provider.fetchNew(new Set());
  assertFalse(items[0].description.includes("## Comments"));
});

Deno.test("fetchNew formats comment date as YYYY-MM-DD", async () => {
  const provider = new JiraProvider({
    baseUrl: BASE_URL,
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    doneStatusName: "Done",
    http: new HttpClient((url, _init) => {
      const urlStr = url as string;
      if (urlStr.includes("/rest/api/3/search")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ issues: [makeIssue("PROJ-1", "Issue")] }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            comments: [{
              author: { displayName: "Alice" },
              body: adfText("Some comment"),
              created: "2025-06-20T14:55:00.000Z",
            }],
          }),
          { status: 200 },
        ),
      );
    }),
    run: (args) =>
      Promise.resolve(
        args[0] === "apfel" ? { code: 0, stdout: "KEEP" } : {
          code: 1,
          stdout: "",
        },
      ),
  });
  const items = await provider.fetchNew(new Set());
  assertStringIncludes(items[0].description, "(2025-06-20)");
});

Deno.test("fetchNew separates multiple kept comments with blank lines", async () => {
  const provider = new JiraProvider({
    baseUrl: BASE_URL,
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    doneStatusName: "Done",
    http: new HttpClient((url, _init) => {
      const urlStr = url as string;
      if (urlStr.includes("/rest/api/3/search")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ issues: [makeIssue("PROJ-1", "Issue")] }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            comments: [
              {
                author: { displayName: "Alice" },
                body: adfText("First comment"),
                created: "2025-01-10T00:00:00Z",
              },
              {
                author: { displayName: "Bob" },
                body: adfText("Second comment"),
                created: "2025-01-11T00:00:00Z",
              },
            ],
          }),
          { status: 200 },
        ),
      );
    }),
    run: (args) =>
      Promise.resolve(
        args[0] === "apfel" ? { code: 0, stdout: "KEEP" } : {
          code: 1,
          stdout: "",
        },
      ),
  });
  const items = await provider.fetchNew(new Set());
  assertStringIncludes(
    items[0].description,
    "**Alice** (2025-01-10)\n\nFirst comment\n\n**Bob** (2025-01-11)\n\nSecond comment",
  );
});

Deno.test("fetchNew fail-open: includes all comments when judge throws", async () => {
  const provider = new JiraProvider({
    baseUrl: BASE_URL,
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    doneStatusName: "Done",
    http: new HttpClient((url, _init) => {
      const urlStr = url as string;
      if (urlStr.includes("/rest/api/3/search")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ issues: [makeIssue("PROJ-1", "Issue")] }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            comments: [{
              author: { displayName: "Alice" },
              body: adfText("Relevant info"),
              created: "2025-01-15T00:00:00Z",
            }],
          }),
          { status: 200 },
        ),
      );
    }),
    run: (_args) => Promise.reject(new Error("judge unavailable")),
  });
  const items = await provider.fetchNew(new Set());
  assertStringIncludes(items[0].description, "## Comments");
  assertStringIncludes(items[0].description, "Relevant info");
});

Deno.test(
  "fetchNew fail-open: includes all comments when both judge calls return non-zero",
  async () => {
    const provider = new JiraProvider({
      baseUrl: BASE_URL,
      email: "test@example.com",
      apiToken: "token",
      project: "PROJ",
      doneStatusName: "Done",
      http: new HttpClient((url, _init) => {
        const urlStr = url as string;
        if (urlStr.includes("/rest/api/3/search")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ issues: [makeIssue("PROJ-1", "Issue")] }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              comments: [{
                author: { displayName: "Alice" },
                body: adfText("Relevant info"),
                created: "2025-01-15T00:00:00Z",
              }],
            }),
            { status: 200 },
          ),
        );
      }),
      run: (_args) => Promise.resolve({ code: 1, stdout: "" }),
    });
    const items = await provider.fetchNew(new Set());
    assertStringIncludes(items[0].description, "## Comments");
    assertStringIncludes(items[0].description, "Relevant info");
  },
);

function makeCommentHttp() {
  return new HttpClient((url, _init) => {
    const urlStr = url as string;
    if (urlStr.includes("/rest/api/3/search")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ issues: [makeIssue("PROJ-1", "Issue")] }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          comments: [{
            author: { displayName: "Alice" },
            body: adfText("Useful technical info"),
            created: "2025-01-15T00:00:00Z",
          }],
        }),
        { status: 200 },
      ),
    );
  });
}

Deno.test(
  "fetchNew appends kept comments via claude JSON schema when apfel unavailable",
  async () => {
    const provider = new JiraProvider({
      baseUrl: BASE_URL,
      email: "test@example.com",
      apiToken: "token",
      project: "PROJ",
      doneStatusName: "Done",
      http: makeCommentHttp(),
      run: (args) =>
        args[0] === "apfel"
          ? Promise.resolve({ code: 1, stdout: "" })
          : Promise.resolve({
            code: 0,
            stdout: JSON.stringify({ structured_output: { verdict: "KEEP" } }),
          }),
    });
    const items = await provider.fetchNew(new Set());
    assertStringIncludes(items[0].description, "## Comments");
    assertStringIncludes(items[0].description, "Useful technical info");
  },
);

Deno.test(
  "fetchNew omits rejected comments via claude JSON schema when apfel unavailable",
  async () => {
    const provider = new JiraProvider({
      baseUrl: BASE_URL,
      email: "test@example.com",
      apiToken: "token",
      project: "PROJ",
      doneStatusName: "Done",
      http: makeCommentHttp(),
      run: (args) =>
        args[0] === "apfel"
          ? Promise.resolve({ code: 1, stdout: "" })
          : Promise.resolve({
            code: 0,
            stdout: JSON.stringify({ verdict: "SKIP" }),
          }),
    });
    const items = await provider.fetchNew(new Set());
    assertFalse(items[0].description.includes("## Comments"));
  },
);

Deno.test("close uses configured done status name", async () => {
  const requests: Array<{ url: string; method?: string; body?: string }> = [];
  const provider = new JiraProvider({
    baseUrl: BASE_URL,
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    doneStatusName: "Closed",
    http: new HttpClient((url, init) => {
      requests.push({
        url: url as string,
        method: init?.method,
        body: init?.body as string,
      });
      if (init?.method !== "POST") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              fields: { status: { name: "To Do" } },
              transitions: [{ id: "41", to: { name: "Closed" } }],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }),
  });
  await provider.close(`${BASE_URL}/browse/PROJ-1`);
  assertEquals(JSON.parse(requests[1].body!), { transition: { id: "41" } });
});

Deno.test("JiraProvider.fetchCurrent: returns title and body for a valid issue", async () => {
  const provider = new JiraProvider({
    baseUrl: BASE_URL,
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    doneStatusName: "Done",
    http: new HttpClient((_url, _init) =>
      Promise.resolve(
        new Response(
          JSON.stringify(makeIssue("PROJ-1", "The title", adfText("The body"))),
          { status: 200 },
        ),
      )
    ),
  });
  const result = await provider.fetchCurrent("jira/PROJ-1");
  assertEquals(result?.title, "The title");
  assertStringIncludes(result?.body ?? "", "The body");
});

Deno.test("JiraProvider.fetchCurrent: returns null on non-ok response", async () => {
  const provider = new JiraProvider({
    baseUrl: BASE_URL,
    email: "test@example.com",
    apiToken: "token",
    project: "PROJ",
    doneStatusName: "Done",
    http: new HttpClient((_url, _init) =>
      Promise.resolve(new Response("Not found", { status: 404 }))
    ),
  });
  const result = await provider.fetchCurrent("jira/PROJ-1");
  assertEquals(result, null);
});

Deno.test(
  "JiraProvider.fetchCurrent: calls correct single-issue endpoint",
  async () => {
    const capturedUrls: string[] = [];
    const provider = new JiraProvider({
      baseUrl: BASE_URL,
      email: "test@example.com",
      apiToken: "token",
      project: "PROJ",
      doneStatusName: "Done",
      http: new HttpClient((url, _init) => {
        capturedUrls.push(url as string);
        return Promise.resolve(
          new Response(
            JSON.stringify(makeIssue("PROJ-5", "T")),
            { status: 200 },
          ),
        );
      }),
    });
    await provider.fetchCurrent("jira/PROJ-5");
    assertEquals(
      capturedUrls[0],
      `${BASE_URL}/rest/api/3/issue/PROJ-5?fields=summary,description,parent`,
    );
  },
);

Deno.test(
  "JiraProvider.fetchCurrent: null description returns empty body",
  async () => {
    const provider = new JiraProvider({
      baseUrl: BASE_URL,
      email: "test@example.com",
      apiToken: "token",
      project: "PROJ",
      doneStatusName: "Done",
      http: new HttpClient((_url, _init) =>
        Promise.resolve(
          new Response(
            JSON.stringify(makeIssue("PROJ-1", "Title", null)),
            { status: 200 },
          ),
        )
      ),
    });
    const result = await provider.fetchCurrent("jira/PROJ-1");
    assertEquals(result?.title, "Title");
    assertEquals(result?.body, "");
  },
);
