import { assertEquals, assertRejects } from "@std/assert";
import { HttpClient } from "../../http-client.ts";
import { githubGraphQL } from "./graphql.ts";

Deno.test(
  "githubGraphQL: POSTs to GraphQL endpoint with auth, content-type, and accept headers",
  async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const http = new HttpClient((url, init) => {
      capturedUrl = url as string;
      capturedInit = init;
      return Promise.resolve(
        new Response(JSON.stringify({ data: {} }), { status: 200 }),
      );
    });
    await githubGraphQL(http, "my-token", "{ viewer { login } }", {});
    assertEquals(capturedUrl, "https://api.github.com/graphql");
    const h = capturedInit?.headers as Record<string, string>;
    assertEquals(h["Authorization"], "Bearer my-token");
    assertEquals(h["Content-Type"], "application/json");
    assertEquals(h["Accept"], "application/vnd.github+json");
  },
);

Deno.test("githubGraphQL: sends query and variables as POST body", async () => {
  let capturedBody: unknown;
  const http = new HttpClient((_url, init) => {
    capturedBody = JSON.parse(init?.body as string);
    return Promise.resolve(
      new Response(JSON.stringify({ data: {} }), { status: 200 }),
    );
  });
  await githubGraphQL(http, "tok", "myquery", { owner: "foo", name: "bar" });
  assertEquals(capturedBody, {
    query: "myquery",
    variables: { owner: "foo", name: "bar" },
  });
});

Deno.test("githubGraphQL: throws on non-2xx HTTP status", async () => {
  const http = new HttpClient(() =>
    Promise.resolve(new Response("", { status: 500 }))
  );
  await assertRejects(() => githubGraphQL(http, "tok", "q", {}), Error);
});

Deno.test(
  "githubGraphQL: throws with first error message when errors array is non-empty",
  async () => {
    const body = JSON.stringify({
      data: null,
      errors: [{ message: "Not found" }],
    });
    const http = new HttpClient(() =>
      Promise.resolve(new Response(body, { status: 200 }))
    );
    await assertRejects(
      () => githubGraphQL(http, "tok", "q", {}),
      Error,
      "Not found",
    );
  },
);

Deno.test("githubGraphQL: returns data field on success", async () => {
  const http = new HttpClient(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({ data: { viewer: { login: "jack" } } }),
        { status: 200 },
      ),
    )
  );
  const result = await githubGraphQL(
    http,
    "tok",
    "q",
    {},
  ) as { viewer: { login: string } };
  assertEquals(result.viewer.login, "jack");
});
