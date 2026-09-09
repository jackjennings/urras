import type { HttpClient } from "../../http-client.ts";

export async function githubGraphQL(
  http: HttpClient,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const res = await http.post("https://api.github.com/graphql", {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`GitHub GraphQL API error: HTTP ${res.status}`);
  }
  const body = await res.json() as {
    data: unknown;
    errors?: Array<{ message: string }>;
  };
  if (body.errors && body.errors.length > 0) {
    throw new Error(body.errors[0].message);
  }
  return body.data;
}
