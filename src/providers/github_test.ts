import {
  assert,
  assertEquals,
  assertFalse,
  assertLess,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { formatGitHubApiError, GitHubProvider } from "./github.ts";
import { compareSortKeys } from "./types.ts";
import { HttpClient } from "../http-client.ts";

function fixedResolver(token: string, login: string) {
  return (_slug: string) => ({ token, login });
}

Deno.test("fetchNew filters out known IDs", async () => {
  const provider = new GitHubProvider({
    repos: ["jackjennings/lazyboy"],
    accountResolver: fixedResolver("fake", "jackjennings"),
    http: new HttpClient((_url, _init) =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            {
              number: 1,
              title: "One",
              body: "desc",
              html_url: "https://github.com/jackjennings/lazyboy/issues/1",
            },
            {
              number: 2,
              title: "Two",
              body: "desc2",
              html_url: "https://github.com/jackjennings/lazyboy/issues/2",
            },
          ]),
          { status: 200 },
        ),
      )
    ),
  });
  const items = await provider.fetchNew(
    new Set(["github/jackjennings/lazyboy/1"]),
  );
  assertEquals(items.length, 1);
  assertEquals(items[0].id, "github/jackjennings/lazyboy/2");
  assertEquals(items[0].provider, "github");
  assertEquals(items[0].title, "Two");
});

Deno.test("fetchNew does not re-create an issue tracked under its legacy gh-<n> id", async () => {
  const provider = new GitHubProvider({
    repos: ["jackjennings/lazyboy"],
    accountResolver: fixedResolver("fake", "jackjennings"),
    http: new HttpClient((_url, _init) =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            {
              number: 18,
              title: "Retry subcommand",
              body: "desc",
              html_url: "https://github.com/jackjennings/lazyboy/issues/18",
            },
          ]),
          { status: 200 },
        ),
      )
    ),
  });
  const items = await provider.fetchNew(new Set(["gh-18"]));
  assertEquals(items.length, 0);
});

Deno.test("fetchNew returns all when knownIds is empty", async () => {
  const provider = new GitHubProvider({
    repos: ["jackjennings/lazyboy"],
    accountResolver: fixedResolver("fake", "jackjennings"),
    http: new HttpClient((_url, _init) =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            {
              number: 1,
              title: "One",
              body: "desc",
              html_url: "https://github.com/jackjennings/lazyboy/issues/1",
            },
          ]),
          { status: 200 },
        ),
      )
    ),
  });
  const items = await provider.fetchNew(new Set());
  assertEquals(items.length, 1);
  assertEquals(items[0].id, "github/jackjennings/lazyboy/1");
});

Deno.test("fetchNew passes slug-resolved token and login to http.get", async () => {
  const receivedArgs: Array<{ url: string; token: string }> = [];
  const provider = new GitHubProvider({
    repos: ["jackjennings/lazyboy", "workorg/app"],
    accountResolver: (slug) => {
      if (slug === "jackjennings/lazyboy") {
        return { token: "tok_personal", login: "jack" };
      }
      if (slug === "workorg/app") {
        return { token: "tok_work", login: "work-user" };
      }
      return { token: "tok_default", login: "default" };
    },
    http: new HttpClient((url, init) => {
      const authHeader =
        (init?.headers as Record<string, string>)?.["Authorization"] ?? "";
      receivedArgs.push({
        url: url as string,
        token: authHeader.replace("Bearer ", ""),
      });
      return Promise.resolve(
        new Response(JSON.stringify([]), { status: 200 }),
      );
    }),
  });
  await provider.fetchNew(new Set());
  assertEquals(receivedArgs.length, 2);
  assertEquals(receivedArgs[0].token, "tok_personal");
  assertStringIncludes(receivedArgs[0].url, "assignee=jack");
  assertEquals(receivedArgs[1].token, "tok_work");
  assertStringIncludes(receivedArgs[1].url, "assignee=work-user");
});

const POISONED_URL =
  'https://api.github.com/repos/jackjennings/lazyboy/issues?assignee={\r\n  "message": "Requires authentication",\r\n  "status": "401"\r\n}&state=open&per_page=50';

Deno.test("formatGitHubApiError: 401 surfaces body message and an auth hint", () => {
  const msg = formatGitHubApiError(
    401,
    "https://api.github.com/repos/jackjennings/lazyboy/issues",
    JSON.stringify({ message: "Requires authentication" }),
  );
  assertStringIncludes(msg, "401");
  assertStringIncludes(msg, "Requires authentication");
  assertStringIncludes(msg, "GITHUB_TOKEN");
});

Deno.test("formatGitHubApiError: strips the query string from the endpoint", () => {
  const msg = formatGitHubApiError(401, POISONED_URL, "");
  assertStringIncludes(
    msg,
    "https://api.github.com/repos/jackjennings/lazyboy/issues",
  );
  assertFalse(msg.includes("assignee="));
  assertFalse(msg.includes("\n"));
});

Deno.test("formatGitHubApiError: non-JSON body does not crash or add a detail", () => {
  const msg = formatGitHubApiError(500, "https://api.github.com/x", "<html>");
  assertStringIncludes(msg, "500");
  assertFalse(msg.includes("<html>"));
});

Deno.test("formatGitHubApiError: unknown status omits the hint", () => {
  const msg = formatGitHubApiError(500, "https://api.github.com/x", "");
  assertFalse(msg.includes("authentication failed"));
});

Deno.test("GitHubProvider.close calls http.patch with correct API URL and body", async () => {
  let patchedUrl = "";
  let patchedBody: unknown;
  const provider = new GitHubProvider({
    repos: [],
    accountResolver: fixedResolver("fake", "user"),
    http: new HttpClient((url, init) => {
      patchedUrl = url as string;
      patchedBody = JSON.parse(init?.body as string);
      return Promise.resolve(new Response(null, { status: 204 }));
    }),
  });
  await provider.close("https://github.com/myorg/myrepo/issues/42");
  assertEquals(
    patchedUrl,
    "https://api.github.com/repos/myorg/myrepo/issues/42",
  );
  assertEquals(patchedBody, { state: "closed", state_reason: "completed" });
});

Deno.test("GitHubProvider.close passes slug-resolved token to http.patch", async () => {
  let receivedToken = "";
  const provider = new GitHubProvider({
    repos: [],
    accountResolver: (slug) => ({
      token: slug.split("/")[0] === "myorg" ? "tok_org" : "tok_default",
      login: "user",
    }),
    http: new HttpClient((_url, init) => {
      const authHeader =
        (init?.headers as Record<string, string>)?.["Authorization"] ?? "";
      receivedToken = authHeader.replace("Bearer ", "");
      return Promise.resolve(new Response(null, { status: 204 }));
    }),
  });
  await provider.close("https://github.com/myorg/myrepo/issues/42");
  assertEquals(receivedToken, "tok_org");
});

Deno.test("GitHubProvider.close throws on unrecognized URL", async () => {
  const provider = new GitHubProvider({
    repos: [],
    accountResolver: fixedResolver("fake", "user"),
    http: new HttpClient(),
  });
  await assertRejects(
    () => provider.close("https://example.com/not-a-github-issue"),
    Error,
  );
});

Deno.test("GitHubProvider.close propagates http.patch error", async () => {
  const provider = new GitHubProvider({
    repos: [],
    accountResolver: fixedResolver("fake", "user"),
    http: new HttpClient(async () => {
      return await Promise.reject(new Error("network failure"));
    }),
  });
  await assertRejects(
    () => provider.close("https://github.com/myorg/myrepo/issues/42"),
    Error,
    "network failure",
  );
});

Deno.test("toSortable: github/org/repo/3 returns [3]", () => {
  assertEquals(GitHubProvider.toSortable("github/jackjennings/lazyboy/3"), [3]);
});

Deno.test("toSortable: github/org/repo/12 returns [12]", () => {
  assertEquals(GitHubProvider.toSortable("github/jackjennings/lazyboy/12"), [
    12,
  ]);
});

Deno.test("toSortable: issue 3 sorts before issue 12 via compareSortKeys", () => {
  assertLess(
    compareSortKeys(
      GitHubProvider.toSortable("github/jackjennings/lazyboy/3"),
      GitHubProvider.toSortable("github/jackjennings/lazyboy/12"),
    ),
    0,
  );
});

Deno.test("GitHubProvider.isPRMerged: returns true for HTTP 204", async () => {
  const provider = new GitHubProvider({
    repos: [],
    accountResolver: fixedResolver("fake", "user"),
    http: new HttpClient((_url, _init) =>
      Promise.resolve(new Response(null, { status: 204 }))
    ),
  });
  assert(await provider.isPRMerged("https://github.com/myorg/myrepo/pull/42"));
});

Deno.test("GitHubProvider.isPRMerged: returns false for HTTP 404", async () => {
  const provider = new GitHubProvider({
    repos: [],
    accountResolver: fixedResolver("fake", "user"),
    http: new HttpClient((_url, _init) =>
      Promise.resolve(new Response(null, { status: 404 }))
    ),
  });
  assertFalse(
    await provider.isPRMerged("https://github.com/myorg/myrepo/pull/42"),
  );
});

Deno.test("GitHubProvider.isPRMerged: throws on unexpected status code", async () => {
  const provider = new GitHubProvider({
    repos: [],
    accountResolver: fixedResolver("fake", "user"),
    http: new HttpClient((_url, _init) =>
      Promise.resolve(new Response(null, { status: 500 }))
    ),
  });
  await assertRejects(
    () => provider.isPRMerged("https://github.com/myorg/myrepo/pull/42"),
    Error,
    "Unexpected GitHub API status",
  );
});

Deno.test("GitHubProvider.isPRMerged: throws on unrecognized PR URL", async () => {
  const provider = new GitHubProvider({
    repos: [],
    accountResolver: fixedResolver("fake", "user"),
    http: new HttpClient((_url, _init) =>
      Promise.resolve(new Response(null, { status: 204 }))
    ),
  });
  await assertRejects(
    () => provider.isPRMerged("https://example.com/not-a-pr"),
    Error,
    "Cannot parse PR URL",
  );
});

Deno.test("GitHubProvider.isPRMerged: calls http.get for merge check endpoint", async () => {
  let calledUrl = "";
  const provider = new GitHubProvider({
    repos: [],
    accountResolver: fixedResolver("fake", "user"),
    http: new HttpClient((url, _init) => {
      calledUrl = url as string;
      return Promise.resolve(new Response(null, { status: 204 }));
    }),
  });
  await provider.isPRMerged("https://github.com/myorg/myrepo/pull/42");
  assertEquals(
    calledUrl,
    "https://api.github.com/repos/myorg/myrepo/pulls/42/merge",
  );
});

Deno.test("GitHubProvider.prState: returns merged when the PR is merged", async () => {
  const provider = new GitHubProvider({
    repos: [],
    accountResolver: fixedResolver("fake", "user"),
    http: new HttpClient((_url, _init) =>
      Promise.resolve(
        new Response(JSON.stringify({ merged: true, state: "closed" }), {
          status: 200,
        }),
      )
    ),
  });
  assertEquals(
    await provider.prState("https://github.com/myorg/myrepo/pull/42"),
    "merged",
  );
});

Deno.test("GitHubProvider.prState: returns closed when the PR is closed unmerged", async () => {
  const provider = new GitHubProvider({
    repos: [],
    accountResolver: fixedResolver("fake", "user"),
    http: new HttpClient((_url, _init) =>
      Promise.resolve(
        new Response(JSON.stringify({ merged: false, state: "closed" }), {
          status: 200,
        }),
      )
    ),
  });
  assertEquals(
    await provider.prState("https://github.com/myorg/myrepo/pull/42"),
    "closed",
  );
});

Deno.test("GitHubProvider.prState: returns open when the PR is still open", async () => {
  const provider = new GitHubProvider({
    repos: [],
    accountResolver: fixedResolver("fake", "user"),
    http: new HttpClient((_url, _init) =>
      Promise.resolve(
        new Response(JSON.stringify({ merged: false, state: "open" }), {
          status: 200,
        }),
      )
    ),
  });
  assertEquals(
    await provider.prState("https://github.com/myorg/myrepo/pull/42"),
    "open",
  );
});

Deno.test("GitHubProvider.prState: calls http.get for PR state endpoint", async () => {
  let calledUrl = "";
  const provider = new GitHubProvider({
    repos: [],
    accountResolver: fixedResolver("fake", "user"),
    http: new HttpClient((url, _init) => {
      calledUrl = url as string;
      return Promise.resolve(
        new Response(JSON.stringify({ merged: true, state: "closed" }), {
          status: 200,
        }),
      );
    }),
  });
  await provider.prState("https://github.com/myorg/myrepo/pull/42");
  assertEquals(calledUrl, "https://api.github.com/repos/myorg/myrepo/pulls/42");
});

Deno.test("GitHubProvider.prState: throws on unrecognized PR URL", async () => {
  const provider = new GitHubProvider({
    repos: [],
    accountResolver: fixedResolver("fake", "user"),
    http: new HttpClient((_url, _init) =>
      Promise.resolve(
        new Response(JSON.stringify({ merged: false, state: "open" }), {
          status: 200,
        }),
      )
    ),
  });
  await assertRejects(
    () => provider.prState("https://example.com/not-a-pr"),
    Error,
    "Cannot parse PR URL",
  );
});

Deno.test("GitHubProvider.isPRMerged: passes slug-resolved token to http.get merge check", async () => {
  let receivedToken = "";
  const provider = new GitHubProvider({
    repos: [],
    accountResolver: (slug) => ({
      token: slug.split("/")[0] === "myorg" ? "tok_org" : "tok_default",
      login: "user",
    }),
    http: new HttpClient((_url, init) => {
      const authHeader =
        (init?.headers as Record<string, string>)?.["Authorization"] ?? "";
      receivedToken = authHeader.replace("Bearer ", "");
      return Promise.resolve(new Response(null, { status: 204 }));
    }),
  });
  await provider.isPRMerged("https://github.com/myorg/myrepo/pull/42");
  assertEquals(receivedToken, "tok_org");
});

Deno.test("GitHubProvider.prMetadata: passes slug-resolved token and correct endpoint", async () => {
  let receivedToken = "";
  let calledUrl = "";
  const provider = new GitHubProvider({
    repos: [],
    accountResolver: (slug) => ({
      token: slug.split("/")[0] === "myorg" ? "tok_org" : "tok_default",
      login: "user",
    }),
    http: new HttpClient((url, init) => {
      calledUrl = url as string;
      const authHeader =
        (init?.headers as Record<string, string>)?.["Authorization"] ?? "";
      receivedToken = authHeader.replace("Bearer ", "");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            html_url: "https://github.com/myorg/myrepo/pull/42",
            title: "feat: x",
            base: { ref: "main" },
            head: { ref: "gh-42" },
          }),
          { status: 200 },
        ),
      );
    }),
  });
  const meta = await provider.prMetadata(
    "https://github.com/myorg/myrepo/pull/42",
  );
  assertEquals(receivedToken, "tok_org");
  assertEquals(calledUrl, "https://api.github.com/repos/myorg/myrepo/pulls/42");
  assertEquals(meta.headRefName, "gh-42");
});

Deno.test("GitHubProvider.prMetadata: throws on unrecognized PR URL", async () => {
  const provider = new GitHubProvider({
    repos: [],
    accountResolver: fixedResolver("fake", "user"),
    http: new HttpClient((_url, _init) =>
      Promise.resolve(
        new Response(JSON.stringify({}), { status: 200 }),
      )
    ),
  });
  await assertRejects(
    () => provider.prMetadata("https://example.com/not-a-pr"),
    Error,
    "Cannot parse PR URL",
  );
});

Deno.test("toSortable: non-numeric suffix falls back to [id]", () => {
  assertEquals(
    GitHubProvider.toSortable("github/jackjennings/lazyboy/abc"),
    ["github/jackjennings/lazyboy/abc"],
  );
});

Deno.test("GitHubProvider.clone: calls _clone with slug, destDir, cwd, and resolved token", async () => {
  let captured:
    | { slug: string; destDir: string; cwd: string; token: string }
    | undefined;
  const provider = new GitHubProvider({
    repos: [],
    accountResolver: (slug) => ({
      token: slug.split("/")[0] === "myorg" ? "tok_org" : "tok_default",
      login: "user",
    }),
    http: new HttpClient(),
    _clone: (slug, destDir, cwd, token) => {
      captured = { slug, destDir, cwd, token };
      return Promise.resolve();
    },
  });
  await provider.clone("myorg/myrepo", "myrepo", "/tmp/org");
  assertEquals(captured, {
    slug: "myorg/myrepo",
    destDir: "myrepo",
    cwd: "/tmp/org",
    token: "tok_org",
  });
});

Deno.test("GitHubProvider.clone: propagates _clone error", async () => {
  const provider = new GitHubProvider({
    repos: [],
    accountResolver: fixedResolver("fake", "user"),
    http: new HttpClient(),
    _clone: () => Promise.reject(new Error("clone failed")),
  });
  await assertRejects(
    () => provider.clone("myorg/myrepo", "myrepo", "/tmp"),
    Error,
    "clone failed",
  );
});

Deno.test(
  "GitHubProvider.fetchNew: builds id from canonical, requests current",
  async () => {
    const requested: string[] = [];
    const http = new HttpClient((url) => {
      requested.push(url as string);
      return Promise.resolve(
        new Response(
          JSON.stringify([{
            number: 1,
            title: "T",
            body: "B",
            html_url: "https://github.com/org/new/issues/1",
          }]),
          { status: 200 },
        ),
      );
    });
    const provider = new GitHubProvider({
      repos: ["org/old"],
      accountResolver: () => ({ token: "t", login: "user" }),
      resolveRepo: (slug) =>
        slug === "org/old"
          ? { canonical: "org/old", current: "org/new" }
          : null,
      http,
    });
    const items = await provider.fetchNew(new Set());
    assertEquals(items.length, 1);
    assertEquals(items[0].id, "github/org/old/1");
    assert(requested.some((u) => u.includes("/repos/org/new/issues")));
    assertFalse(requested.some((u) => u.includes("/repos/org/old/issues")));
  },
);

Deno.test(
  "GitHubProvider.fetchNew: null resolveRepo skips that repository",
  async () => {
    const provider = new GitHubProvider({
      repos: ["blocked/repo", "fine/repo"],
      accountResolver: () => ({ token: "t", login: "user" }),
      resolveRepo: (slug) =>
        slug === "blocked/repo" ? null : { canonical: slug, current: slug },
      http: new HttpClient((url) => {
        if ((url as string).includes("fine/repo")) {
          return Promise.resolve(
            new Response(
              JSON.stringify([{
                number: 2,
                title: "T",
                body: "B",
                html_url: "https://github.com/fine/repo/issues/2",
              }]),
              { status: 200 },
            ),
          );
        }
        throw new Error("should not call blocked/repo");
      }),
    });
    const items = await provider.fetchNew(new Set());
    assertEquals(items.length, 1);
    assertEquals(items[0].id, "github/fine/repo/2");
  },
);

Deno.test(
  "GitHubProvider.fetchCurrent: returns title and body for a valid issue",
  async () => {
    const provider = new GitHubProvider({
      repos: [],
      accountResolver: fixedResolver("tok", "user"),
      http: new HttpClient((_url, _init) =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              number: 42,
              title: "The issue title",
              body: "The issue body",
              html_url: "https://github.com/myorg/myrepo/issues/42",
            }),
            { status: 200 },
          ),
        )
      ),
    });
    const result = await provider.fetchCurrent(
      "github/myorg/myrepo/42",
    );
    assertEquals(result, { title: "The issue title", body: "The issue body" });
  },
);

Deno.test(
  "GitHubProvider.fetchCurrent: normalizes null body to empty string",
  async () => {
    const provider = new GitHubProvider({
      repos: [],
      accountResolver: fixedResolver("tok", "user"),
      http: new HttpClient((_url, _init) =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              number: 1,
              title: "Title",
              body: null,
              html_url: "https://github.com/org/repo/issues/1",
            }),
            { status: 200 },
          ),
        )
      ),
    });
    const result = await provider.fetchCurrent("github/org/repo/1");
    assertEquals(result, { title: "Title", body: "" });
  },
);

Deno.test(
  "GitHubProvider.fetchCurrent: returns null on non-ok response",
  async () => {
    const provider = new GitHubProvider({
      repos: [],
      accountResolver: fixedResolver("tok", "user"),
      http: new HttpClient((_url, _init) =>
        Promise.resolve(new Response("Not found", { status: 404 }))
      ),
    });
    const result = await provider.fetchCurrent("github/org/repo/99");
    assertEquals(result, null);
  },
);

Deno.test(
  "GitHubProvider.fetchCurrent: calls correct API endpoint with resolved token",
  async () => {
    let capturedUrl = "";
    let capturedAuth = "";
    const provider = new GitHubProvider({
      repos: [],
      accountResolver: fixedResolver("my-token", "user"),
      http: new HttpClient((url, init) => {
        capturedUrl = url as string;
        capturedAuth = (init?.headers as Record<string, string>)
          ?.Authorization ?? "";
        return Promise.resolve(
          new Response(
            JSON.stringify({
              number: 5,
              title: "T",
              body: "B",
              html_url: "https://github.com/org/r/issues/5",
            }),
            { status: 200 },
          ),
        );
      }),
    });
    await provider.fetchCurrent("github/org/r/5");
    assertEquals(
      capturedUrl,
      "https://api.github.com/repos/org/r/issues/5",
    );
    assertEquals(capturedAuth, "Bearer my-token");
  },
);
