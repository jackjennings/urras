import { join } from "@std/path";
import type { CommandRunner } from "../apfel.ts";
import type { TickAction } from "./types.ts";
import { isApproved } from "../state/types.ts";
import type { TicketState, WorktreeInfo } from "../state/types.ts";
import { extractIntakeArtifacts } from "../extract-artifacts.ts";
import {
  extractGitHubSlug,
  parseIntakeScope,
  resolveGitHubSlug,
} from "../worktree.ts";

export interface CreateWorktreeDeps {
  roots: string[];
  run: CommandRunner;
  canonicalSlugFor: (slug: string) => string;
  findLocalRepo: (roots: string[], slug: string) => Promise<string | null>;
  createWorktree: (
    repoPath: string,
    ticketId: string,
    slug: string,
  ) => Promise<WorktreeInfo>;
  writeTicket: (stateDir: string, t: TicketState) => Promise<void>;
  readIntakeOutput: (ticketDir: string) => Promise<string | null>;
  cloneRemoteRepo: (slug: string) => Promise<string>;
  initLocalRepo: (slug: string) => Promise<string>;
  stat: (path: string) => Promise<boolean>;
  appendLog: (stateDir: string, id: string, entry: object) => Promise<void>;
  applyWorktreeInclude: (
    worktreePath: string,
    sourcePath: string,
  ) => Promise<void>;
}

export function createWorktreeAction(deps: CreateWorktreeDeps): TickAction {
  return {
    label: "Creating worktree",
    applies(ticket: TicketState): boolean {
      return (
        ticket.phase === "intake" &&
        ticket.status === "waiting" &&
        isApproved(ticket) &&
        Object.keys(ticket.worktrees).length === 0 &&
        ticket.artifacts.includes("code")
      );
    },
    async run(
      ticket: TicketState,
      stateDir: string,
    ): Promise<TicketState | null> {
      const now = Temporal.Now.instant().toString();
      const ticketDir = join(stateDir, ticket.id);

      const intakeContent = await deps.readIntakeOutput(ticketDir);
      const scopeEntries = intakeContent !== null
        ? parseIntakeScope(intakeContent)
        : [];

      let correctedTicket = ticket;
      if (intakeContent !== null) {
        const parsedArtifacts = await extractIntakeArtifacts(
          intakeContent,
          deps.run,
        );
        if (parsedArtifacts.length > 0) {
          const differs = parsedArtifacts.length !== ticket.artifacts.length ||
            parsedArtifacts.some((a) => !ticket.artifacts.includes(a));
          if (differs) {
            correctedTicket = {
              ...ticket,
              artifacts: parsedArtifacts,
              updated: now,
            };
            await deps.writeTicket(stateDir, correctedTicket);
            await deps.appendLog(stateDir, ticket.id, {
              event: "artifact-corrected",
              artifacts: parsedArtifacts,
            });
          }
        } else {
          await deps.appendLog(stateDir, ticket.id, {
            event: "artifact-defaulted",
            artifacts: ["code"],
          });
        }
      }

      if (!correctedTicket.artifacts.includes("code")) {
        return correctedTicket;
      }

      const resolvedLocalPaths: string[] = [];
      const resolvedScopeSlugs: string[] = [];
      const githubSlugs = new Set<string>();
      const newRepoSlugs: string[] = [];

      if (correctedTicket.provider === "github") {
        try {
          githubSlugs.add(
            deps.canonicalSlugFor(extractGitHubSlug(correctedTicket.url)),
          );
        } catch {
          const updated = {
            ...correctedTicket,
            status: "needs-attention" as const,
            updated: now,
          };
          await deps.writeTicket(stateDir, updated);
          await deps.appendLog(stateDir, ticket.id, {
            event: "needs-attention",
            reason: "github-slug-extraction-failed",
          });
          return updated;
        }
      }

      for (const { entry, isNew } of scopeEntries) {
        if (entry.startsWith("/") || entry.startsWith("~/")) {
          if (isNew) {
            const updated = {
              ...correctedTicket,
              status: "needs-attention" as const,
              updated: now,
            };
            await deps.writeTicket(stateDir, updated);
            await deps.appendLog(stateDir, ticket.id, {
              event: "needs-attention",
              reason: "new-marker-on-local-path",
            });
            return updated;
          }
          const expanded = entry.startsWith("~/")
            ? join(Deno.env.get("HOME")!, entry.slice(2))
            : entry;
          if (await deps.stat(expanded)) resolvedLocalPaths.push(expanded);
        } else {
          const slug = resolveGitHubSlug(entry);
          if (slug) {
            const canonical = deps.canonicalSlugFor(slug);
            githubSlugs.add(canonical);
            resolvedScopeSlugs.push(canonical);
            if (isNew) newRepoSlugs.push(canonical);
          }
        }
      }

      if (correctedTicket.provider !== "github" && githubSlugs.size === 0) {
        const updated = {
          ...correctedTicket,
          status: "needs-attention" as const,
          updated: now,
        };
        await deps.writeTicket(stateDir, updated);
        await deps.appendLog(stateDir, ticket.id, {
          event: "needs-attention",
          reason: "no-github-repos",
        });
        return updated;
      }

      const resolvedRepos: Array<{ slug: string; repoPath: string }> = [];
      for (const slug of githubSlugs) {
        if (newRepoSlugs.includes(slug)) {
          try {
            const initedPath = await deps.initLocalRepo(slug);
            resolvedRepos.push({ slug, repoPath: initedPath });
          } catch (e) {
            const updated = {
              ...correctedTicket,
              status: "needs-attention" as const,
              updated: now,
            };
            await deps.writeTicket(stateDir, updated);
            await deps.appendLog(stateDir, ticket.id, {
              event: "needs-attention",
              reason: "local-repo-init-failed",
              slug,
              message: String(e),
            });
            return updated;
          }
        } else {
          const localPath = await deps.findLocalRepo(deps.roots, slug);
          if (localPath) {
            resolvedRepos.push({ slug, repoPath: localPath });
          } else {
            try {
              const clonedPath = await deps.cloneRemoteRepo(slug);
              resolvedRepos.push({ slug, repoPath: clonedPath });
            } catch (e) {
              const updated = {
                ...correctedTicket,
                status: "needs-attention" as const,
                updated: now,
              };
              await deps.writeTicket(stateDir, updated);
              await deps.appendLog(stateDir, ticket.id, {
                event: "needs-attention",
                reason: "clone-failed",
                slug,
                message: String(e),
              });
              return updated;
            }
          }
        }
      }

      const worktrees: Record<string, WorktreeInfo> = {};
      try {
        for (const { slug, repoPath } of resolvedRepos) {
          worktrees[slug] = await deps.createWorktree(
            repoPath,
            ticket.id,
            slug,
          );
          try {
            await deps.applyWorktreeInclude(worktrees[slug].path, repoPath);
          } catch (e) {
            await deps.appendLog(stateDir, ticket.id, {
              event: "worktree-include-failed",
              slug,
              message: String(e),
            });
          }
        }
      } catch {
        const updated = {
          ...correctedTicket,
          status: "needs-attention" as const,
          updated: now,
        };
        await deps.writeTicket(stateDir, updated);
        await deps.appendLog(stateDir, ticket.id, {
          event: "needs-attention",
          reason: "worktree-creation-failed",
        });
        return updated;
      }

      const updated = {
        ...correctedTicket,
        scope: [...resolvedLocalPaths, ...resolvedScopeSlugs],
        worktrees,
        ...(newRepoSlugs.length > 0 ? { newRepos: newRepoSlugs } : {}),
        updated: now,
      };
      await deps.writeTicket(stateDir, updated);
      return updated;
    },
  };
}
