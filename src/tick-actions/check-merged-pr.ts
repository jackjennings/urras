import type { TickAction } from "./types.ts";
import type { TicketState, WorktreeInfo } from "../state/types.ts";

export interface CheckMergedPRDeps {
  isPRMerged: (prUrl: string) => Promise<boolean>;
  cleanupWorktree: (wt: WorktreeInfo) => Promise<void>;
  writeTicket: (stateDir: string, t: TicketState) => Promise<void>;
  appendLog: (stateDir: string, id: string, entry: object) => Promise<void>;
  closeWorkItem: (url: string) => Promise<void>;
}

export function checkMergedPRAction(deps: CheckMergedPRDeps): TickAction {
  return {
    label: "Checking merged PRs",
    applies(ticket: TicketState): boolean {
      return (
        (ticket.phase === "merge" || ticket.phase === "implementation") &&
        ticket.status === "waiting" &&
        ticket.prs !== undefined &&
        ticket.prs.length > 0
      );
    },
    async run(
      ticket: TicketState,
      stateDir: string,
    ): Promise<TicketState | null> {
      const prs = ticket.prs!.map((pr) => ({ ...pr }));
      const worktrees = { ...ticket.worktrees };
      const mergedUrls = new Set(
        prs.filter((pr) => pr.merged).map((pr) => pr.url),
      );
      const initialMergedCount = mergedUrls.size;

      for (const pr of prs) {
        if (pr.merged) continue;
        if (pr.dependsOn.some((dep) => !mergedUrls.has(dep))) continue;

        let merged: boolean;
        try {
          merged = await deps.isPRMerged(pr.url);
        } catch (e) {
          await deps.appendLog(stateDir, ticket.id, {
            event: "error",
            context: "checkMergedPR",
            message: String(e),
          });
          return null;
        }

        if (!merged) continue;

        pr.merged = true;
        mergedUrls.add(pr.url);

        if (pr.worktreeKey !== undefined && worktrees[pr.worktreeKey]) {
          try {
            await deps.cleanupWorktree(worktrees[pr.worktreeKey]);
          } catch (e) {
            await deps.appendLog(stateDir, ticket.id, {
              event: "error",
              context: "checkMergedPR",
              message: String(e),
            });
          }
          delete worktrees[pr.worktreeKey];
        }
      }

      const now = Temporal.Now.instant().toString();

      if (mergedUrls.size === prs.length) {
        const updated: TicketState = {
          ...ticket,
          phase: "merge",
          status: "done",
          prs,
          worktrees,
          updated: now,
        };
        await deps.writeTicket(stateDir, updated);
        await deps.appendLog(stateDir, ticket.id, {
          event: "phase-transition",
          from: "waiting-merge",
          to: "done",
        });
        try {
          await deps.closeWorkItem(ticket.url);
        } catch (e) {
          await deps.appendLog(stateDir, ticket.id, {
            event: "error",
            context: "checkMergedPR",
            message: String(e),
          });
        }
        return updated;
      }

      if (mergedUrls.size > initialMergedCount) {
        const updated: TicketState = {
          ...ticket,
          phase: "merge",
          status: "waiting",
          prs,
          worktrees,
          updated: now,
        };
        await deps.writeTicket(stateDir, updated);
        return updated;
      }

      return null;
    },
  };
}
