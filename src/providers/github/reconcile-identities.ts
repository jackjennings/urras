import { HttpClient } from "../../http-client.ts";
import { canonicalSlugFor, type RepoIdentityTable } from "./repo-identity.ts";
import { githubGraphQL } from "./graphql.ts";
import {
  canonicalLoginFor,
  type OrgIdentityTable,
} from "./org-identity.ts";

export interface ReconcileRepoIdentitiesDeps {
  http: HttpClient;
  accountResolver: (slug: string) => { token: string; login: string };
  readTable: () => Promise<RepoIdentityTable>;
  writeTable: (table: RepoIdentityTable) => Promise<void>;
  log: (event: string, data?: unknown) => void;
  notify: (title: string, body: string) => Promise<void>;
  repos: string[];
}

export async function reconcileRepoIdentities(
  deps: ReconcileRepoIdentitiesDeps,
): Promise<
  { confirmed: Map<string, { repoId: number; currentSlug: string }> }
> {
  const confirmed = new Map<string, { repoId: number; currentSlug: string }>();
  const table = await deps.readTable();
  let dirty = false;

  const authHeader = (slug: string) => {
    const { token } = deps.accountResolver(slug);
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    };
  };

  // Step 1: Confirm null-repoId entries before resolving new config slugs
  for (const [canonical, entry] of Object.entries(table)) {
    if (entry.repoId !== null) continue;
    try {
      const res = await deps.http.get(
        `https://api.github.com/repos/${canonical}`,
        { headers: authHeader(canonical) },
      );
      if (!res.ok) {
        deps.log("repo-identity-reconcile-failed", {
          slug: canonical,
          status: res.status,
        });
        continue;
      }
      const data = await res.json() as {
        id: number;
        full_name: string;
        created_at: string;
      };
      const seenBefore = entry.seenBefore;
      if (seenBefore && data.created_at > seenBefore) {
        if (entry.blockedBy !== data.id) {
          table[canonical] = { ...entry, blockedBy: data.id };
          dirty = true;
          await deps.notify(
            "Repo identity collision",
            `${canonical}: ${data.full_name} was re-registered`,
          ).catch(() => {});
          deps.log("repo-identity-collision", {
            canonical,
            squatterId: data.id,
          });
        }
        continue;
      }
      const newAliases = entry.aliases.includes(data.full_name)
        ? entry.aliases
        : [...entry.aliases, data.full_name];
      table[canonical] = {
        ...entry,
        repoId: data.id,
        currentSlug: data.full_name,
        aliases: newAliases,
      };
      dirty = true;
      confirmed.set(canonical, {
        repoId: data.id,
        currentSlug: data.full_name,
      });
    } catch (e) {
      deps.log("repo-identity-reconcile-failed", {
        slug: canonical,
        error: String(e),
      });
    }
  }

  // Step 2: Refresh entries with a known repoId
  for (const [canonical, entry] of Object.entries(table)) {
    if (entry.repoId === null) continue;
    try {
      const res = await deps.http.get(
        `https://api.github.com/repositories/${entry.repoId}`,
        { headers: authHeader(canonical) },
      );
      if (res.status === 404) {
        deps.log("repo-identity-reconcile-failed", {
          slug: canonical,
          status: 404,
        });
        continue;
      }
      if (!res.ok) {
        deps.log("repo-identity-reconcile-failed", {
          slug: canonical,
          status: res.status,
        });
        continue;
      }
      const data = await res.json() as { full_name: string };
      if (data.full_name !== entry.currentSlug) {
        const newAliases = entry.aliases.includes(data.full_name)
          ? entry.aliases
          : [...entry.aliases, data.full_name];
        table[canonical] = {
          ...entry,
          currentSlug: data.full_name,
          aliases: newAliases,
        };
        dirty = true;
        await deps.notify(
          "Repo renamed",
          `${canonical} → ${data.full_name}`,
        ).catch(() => {});
        deps.log("repo-renamed", {
          canonical,
          from: entry.currentSlug,
          to: data.full_name,
        });
      }
      confirmed.set(canonical, {
        repoId: entry.repoId,
        currentSlug: table[canonical].currentSlug,
      });
    } catch (e) {
      deps.log("repo-identity-reconcile-failed", {
        slug: canonical,
        error: String(e),
      });
    }
  }

  // Step 3: Resolve config slugs, check for squatters on existing canonical keys
  for (const slug of deps.repos) {
    if (table[slug]) {
      // Exact canonical key exists — check for squatter when repoId is known and not yet blocked
      const entry = table[slug];
      if (entry.repoId !== null && entry.blockedBy === null) {
        try {
          const res = await deps.http.get(
            `https://api.github.com/repos/${slug}`,
            { headers: authHeader(slug) },
          );
          if (res.ok) {
            const data = await res.json() as { id: number; full_name: string };
            if (data.id !== entry.repoId) {
              table[slug] = { ...entry, blockedBy: data.id };
              dirty = true;
              await deps.notify(
                "Repo identity collision",
                `${slug}: freed name re-registered by repo ${data.id}`,
              ).catch(() => {});
              deps.log("repo-identity-collision", {
                canonical: slug,
                squatterId: data.id,
              });
            }
          }
        } catch (e) {
          deps.log("repo-identity-reconcile-failed", {
            slug,
            error: String(e),
          });
        }
      }
      continue;
    }

    // Not a canonical key — check if already tracked as alias of another entry
    const existingCanonical = canonicalSlugFor(table, slug);
    if (existingCanonical !== slug) {
      // Already tracked as alias; no new entry needed
      continue;
    }

    // Not in table at all — resolve via API
    try {
      const res = await deps.http.get(
        `https://api.github.com/repos/${slug}`,
        { headers: authHeader(slug) },
      );
      if (res.status === 404) continue;
      if (!res.ok) {
        deps.log("repo-identity-reconcile-failed", {
          slug,
          status: res.status,
        });
        continue;
      }
      const data = await res.json() as { id: number; full_name: string };
      const canonicalForId = Object.entries(table).find(
        ([, e]) => e.repoId === data.id,
      )?.[0];
      if (canonicalForId) {
        if (!table[canonicalForId].aliases.includes(slug)) {
          table[canonicalForId] = {
            ...table[canonicalForId],
            aliases: [...table[canonicalForId].aliases, slug],
          };
          dirty = true;
        }
      } else {
        table[slug] = {
          repoId: data.id,
          currentSlug: data.full_name,
          aliases: [slug],
          blockedBy: null,
        };
        dirty = true;
      }
    } catch (e) {
      deps.log("repo-identity-reconcile-failed", { slug, error: String(e) });
    }
  }

  if (dirty) {
    try {
      await deps.writeTable(table);
    } catch (e) {
      deps.log("repo-identity-reconcile-failed", {
        context: "write",
        error: String(e),
      });
    }
  }

  return { confirmed };
}

export interface ReconcileOrgIdentitiesDeps {
  http: HttpClient;
  accountResolver: (slug: string) => { token: string; login: string };
  readTable: () => Promise<OrgIdentityTable>;
  writeTable: (table: OrgIdentityTable) => Promise<void>;
  log: (event: string, data?: unknown) => void;
  notify: (title: string, body: string) => Promise<void>;
  orgs: string[];
}

const ORG_LOOKUP_QUERY =
  `query($login: String!) { organization(login: $login) { databaseId login } }`;

export async function reconcileOrgIdentities(
  deps: ReconcileOrgIdentitiesDeps,
): Promise<void> {
  const table = await deps.readTable();
  let dirty = false;

  for (const [canonical, entry] of Object.entries(table)) {
    try {
      const { token } = deps.accountResolver(canonical);
      const res = await deps.http.get(
        `https://api.github.com/organizations/${entry.orgId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
          },
        },
      );
      if (!res.ok) {
        deps.log("org-identity-reconcile-failed", {
          org: canonical,
          status: res.status,
        });
        continue;
      }
      const data = await res.json() as { login: string };
      if (data.login !== entry.currentLogin) {
        const newAliases = entry.aliases.includes(data.login)
          ? entry.aliases
          : [...entry.aliases, data.login];
        table[canonical] = {
          ...entry,
          currentLogin: data.login,
          aliases: newAliases,
        };
        dirty = true;
        await deps.notify("Org renamed", `${canonical} → ${data.login}`).catch(
          () => {},
        );
        deps.log("org-renamed", {
          canonical,
          from: entry.currentLogin,
          to: data.login,
        });
      }
    } catch (e) {
      deps.log("org-identity-reconcile-failed", {
        org: canonical,
        error: String(e),
      });
    }
  }

  for (const org of deps.orgs) {
    if (table[canonicalLoginFor(table, org)]) continue;
    try {
      const { token } = deps.accountResolver(org);
      const data = await githubGraphQL(deps.http, token, ORG_LOOKUP_QUERY, {
        login: org,
      }) as { organization: { databaseId: number; login: string } | null };
      if (!data.organization) {
        deps.log("org-identity-reconcile-failed", { org, reason: "not-found" });
        continue;
      }
      table[org] = {
        orgId: data.organization.databaseId,
        currentLogin: data.organization.login,
        aliases: [data.organization.login],
      };
      dirty = true;
    } catch (e) {
      deps.log("org-identity-reconcile-failed", { org, error: String(e) });
    }
  }

  if (dirty) {
    try {
      await deps.writeTable(table);
    } catch (e) {
      deps.log("org-identity-reconcile-failed", {
        context: "write",
        error: String(e),
      });
    }
  }
}
