import type { TickAction } from "./types.ts";
import type { TicketState, WorktreeInfo } from "../state/types.ts";
import { parsePrUrl, slugOf } from "../providers/github/identity.ts";

export interface CreateBranchWorktreesDeps {
  findLocalRepo: (roots: string[], slug: string) => Promise<string | null>;
  createWorktree: (
    repoPath: string,
    ticketId: string,
    slug: string,
    branch: string,
  ) => Promise<WorktreeInfo>;
  writeTicket: (stateDir: string, t: TicketState) => Promise<void>;
  appendLog: (stateDir: string, id: string, entry: object) => Promise<void>;
  isProcessAlive: (ticketId: string) => boolean;
  roots: string[];
}

function needsBranchWorktree(ticket: TicketState): boolean {
  return (ticket.prs ?? []).some(
    (pr) =>
      !pr.merged &&
      pr.branch !== undefined &&
      ticket.worktrees[`${slugOf(parsePrUrl(pr.url)!)}:${pr.branch}`] ===
        undefined,
  );
}

export function createBranchWorktreesAction(
  deps: CreateBranchWorktreesDeps,
): TickAction {
  return {
    label: "Creating branch worktrees",
    applies(ticket: TicketState): boolean {
      return (
        (ticket.prs ?? []).length > 0 &&
        ticket.status !== "running" &&
        ticket.status !== "needs-attention" &&
        !deps.isProcessAlive(ticket.id) &&
        needsBranchWorktree(ticket)
      );
    },
    async run(
      ticket: TicketState,
      stateDir: string,
    ): Promise<TicketState | null> {
      const now = Temporal.Now.instant().toString();
      const worktrees = { ...ticket.worktrees };
      const prs = ticket.prs!.map((pr) => ({ ...pr }));
      let created = 0;

      for (const pr of prs) {
        if (pr.merged || pr.branch === undefined) continue;
        const parsed = parsePrUrl(pr.url);
        if (!parsed) continue;
        const slug = slugOf(parsed);
        const key = `${slug}:${pr.branch}`;
        if (worktrees[key]) continue;

        const repoPath = await deps.findLocalRepo(deps.roots, slug);
        if (!repoPath) {
          const parked: TicketState = {
            ...ticket,
            status: "needs-attention",
            updated: now,
          };
          await deps.writeTicket(stateDir, parked);
          await deps.appendLog(stateDir, ticket.id, {
            event: "needs-attention",
            reason: "no-local-repo",
            slug,
          });
          return parked;
        }

        let wt: WorktreeInfo;
        try {
          wt = await deps.createWorktree(repoPath, ticket.id, slug, pr.branch);
        } catch (e) {
          const parked: TicketState = {
            ...ticket,
            status: "needs-attention",
            updated: now,
          };
          await deps.writeTicket(stateDir, parked);
          await deps.appendLog(stateDir, ticket.id, {
            event: "needs-attention",
            reason: "worktree-creation-failed",
            slug,
            message: String(e),
          });
          return parked;
        }

        worktrees[key] = wt;
        pr.worktreeKey = key;
        created++;
      }

      if (created === 0) return null;

      const updated: TicketState = { ...ticket, worktrees, prs, updated: now };
      await deps.writeTicket(stateDir, updated);
      await deps.appendLog(stateDir, ticket.id, {
        event: "branch-worktrees-created",
        count: created,
      });
      return updated;
    },
  };
}
