import { join } from "@std/path";
import type { TickAction } from "./types.ts";
import { isApproved } from "../state/types.ts";
import type { TicketState, WorktreeInfo } from "../state/types.ts";
import { parseEnrichmentScope, resolveGitHubSlug } from "../worktree.ts";

export interface ReviseScopeDeps {
  roots: string[];
  canonicalSlugFor: (slug: string) => string;
  findLocalRepo: (roots: string[], slug: string) => Promise<string | null>;
  createWorktree: (
    repoPath: string,
    ticketId: string,
    slug: string,
  ) => Promise<WorktreeInfo>;
  removeWorktree: (wt: WorktreeInfo) => Promise<void>;
  cloneRemoteRepo: (slug: string) => Promise<string>;
  applyWorktreeInclude: (
    worktreePath: string,
    sourcePath: string,
  ) => Promise<void>;
  writeTicket: (stateDir: string, t: TicketState) => Promise<void>;
  appendLog: (stateDir: string, id: string, entry: object) => Promise<void>;
  readEnrichmentOutput: (ticketDir: string) => Promise<string | null>;
}

export function reviseScopeAction(deps: ReviseScopeDeps): TickAction {
  return {
    label: "Revising scope",
    applies(ticket: TicketState): boolean {
      return (
        ticket.phase === "enrichment" &&
        ticket.status === "waiting" &&
        isApproved(ticket) &&
        Object.keys(ticket.worktrees).length > 0
      );
    },
    async run(
      ticket: TicketState,
      stateDir: string,
    ): Promise<TicketState | null> {
      const now = Temporal.Now.instant().toString();
      const ticketDir = join(stateDir, ticket.id);

      const enrichmentContent = await deps.readEnrichmentOutput(ticketDir);
      if (enrichmentContent === null) return null;

      const scopeEntries = parseEnrichmentScope(enrichmentContent);
      if (scopeEntries.length === 0) return null;

      const revisedSlugs = new Set<string>();
      for (const { entry } of scopeEntries) {
        if (entry.startsWith("/") || entry.startsWith("~/")) continue;
        const slug = resolveGitHubSlug(entry);
        if (slug) {
          revisedSlugs.add(deps.canonicalSlugFor(slug));
        }
      }

      if (revisedSlugs.size === 0) return null;

      const existingKeys = new Set(Object.keys(ticket.worktrees));
      const slugsToAdd = [...revisedSlugs].filter((s) => !existingKeys.has(s));
      const slugsToRemove = [...existingKeys].filter((s) =>
        !revisedSlugs.has(s)
      );

      if (slugsToAdd.length === 0 && slugsToRemove.length === 0) return null;

      const slugsToRemoveSet = new Set(slugsToRemove);
      const blockedPr = (ticket.prs ?? []).find(
        (pr) =>
          !pr.merged &&
          pr.worktreeKey !== undefined &&
          slugsToRemoveSet.has(pr.worktreeKey),
      );
      if (blockedPr) {
        const parked: TicketState = {
          ...ticket,
          status: "needs-attention",
          updated: now,
        };
        await deps.writeTicket(stateDir, parked);
        await deps.appendLog(stateDir, ticket.id, {
          event: "needs-attention",
          reason: "scope-revision-blocked-by-open-pr",
          prUrl: blockedPr.url,
          worktreeKey: blockedPr.worktreeKey,
        });
        return parked;
      }

      const resolvedRepos: Array<{ slug: string; repoPath: string }> = [];
      for (const slug of slugsToAdd) {
        const localPath = await deps.findLocalRepo(deps.roots, slug);
        if (localPath) {
          resolvedRepos.push({ slug, repoPath: localPath });
        } else {
          try {
            const clonedPath = await deps.cloneRemoteRepo(slug);
            resolvedRepos.push({ slug, repoPath: clonedPath });
          } catch (e) {
            const parked: TicketState = {
              ...ticket,
              status: "needs-attention",
              updated: now,
            };
            await deps.writeTicket(stateDir, parked);
            await deps.appendLog(stateDir, ticket.id, {
              event: "needs-attention",
              reason: "clone-failed",
              slug,
              message: String(e),
            });
            return parked;
          }
        }
      }

      const newWorktrees: Record<string, WorktreeInfo> = {};
      try {
        for (const { slug, repoPath } of resolvedRepos) {
          newWorktrees[slug] = await deps.createWorktree(
            repoPath,
            ticket.id,
            slug,
          );
          try {
            await deps.applyWorktreeInclude(newWorktrees[slug].path, repoPath);
          } catch (e) {
            await deps.appendLog(stateDir, ticket.id, {
              event: "worktree-include-failed",
              slug,
              message: String(e),
            });
          }
        }
      } catch {
        const parked: TicketState = {
          ...ticket,
          status: "needs-attention",
          updated: now,
        };
        await deps.writeTicket(stateDir, parked);
        await deps.appendLog(stateDir, ticket.id, {
          event: "needs-attention",
          reason: "worktree-creation-failed",
        });
        return parked;
      }

      for (const slug of slugsToRemove) {
        const wt = ticket.worktrees[slug];
        if (wt) {
          try {
            await deps.removeWorktree(wt);
          } catch (e) {
            await deps.appendLog(stateDir, ticket.id, {
              event: "error",
              context: "reviseScope",
              message: String(e),
            });
          }
        }
      }

      const updatedWorktrees: Record<string, WorktreeInfo> = {
        ...ticket.worktrees,
      };
      for (const slug of slugsToRemove) {
        delete updatedWorktrees[slug];
      }
      for (const [slug, wt] of Object.entries(newWorktrees)) {
        updatedWorktrees[slug] = wt;
      }

      const localPathEntries = ticket.scope.filter(
        (s) => s.startsWith("/") || s.startsWith("~/"),
      );
      const newScope = [...localPathEntries, ...Array.from(revisedSlugs)];

      const updated: TicketState = {
        ...ticket,
        scope: newScope,
        worktrees: updatedWorktrees,
        updated: now,
      };
      await deps.writeTicket(stateDir, updated);
      await deps.appendLog(stateDir, ticket.id, {
        event: "scope-revised",
        removed: slugsToRemove,
        added: slugsToAdd,
      });
      return updated;
    },
  };
}
