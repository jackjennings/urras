import type { TickAction } from "./types.ts";
import type { TicketState, WorktreeInfo } from "../state/types.ts";

export interface CleanOrphanedWorktreesDeps {
  isProcessAlive: (ticketId: string) => boolean;
  cleanupWorktree: (wt: WorktreeInfo) => Promise<void>;
  writeTicket: (stateDir: string, t: TicketState) => Promise<void>;
  appendLog: (stateDir: string, id: string, entry: object) => Promise<void>;
}

function orphanedKeys(ticket: TicketState): string[] {
  const liveKeys = new Set(
    (ticket.prs ?? [])
      .filter((pr) => !pr.merged && pr.closed !== true)
      .map((pr) => pr.worktreeKey)
      .filter((k): k is string => k !== undefined),
  );
  return Object.keys(ticket.worktrees).filter((k) => !liveKeys.has(k));
}

export function cleanOrphanedWorktreesAction(
  deps: CleanOrphanedWorktreesDeps,
): TickAction {
  return {
    label: "Cleaning worktrees",
    usesAgent: false,
    applies(ticket: TicketState): boolean {
      return (
        ticket.prs !== undefined &&
        orphanedKeys(ticket).length > 0 &&
        !deps.isProcessAlive(ticket.id)
      );
    },
    async run(
      ticket: TicketState,
      stateDir: string,
    ): Promise<TicketState | null> {
      const keys = orphanedKeys(ticket);
      if (keys.length === 0) return null;

      const worktrees = { ...ticket.worktrees };
      for (const k of keys) {
        const wt = worktrees[k];
        try {
          await deps.cleanupWorktree(wt);
        } catch (e) {
          await deps.appendLog(stateDir, ticket.id, {
            event: "error",
            context: "cleanOrphanedWorktrees",
            message: String(e),
          });
        }
        delete worktrees[k];
        await deps.appendLog(stateDir, ticket.id, {
          event: "orphaned-worktree-removed",
          worktreeKey: k,
          branch: wt.branch,
        });
      }

      const updated: TicketState = {
        ...ticket,
        worktrees,
        updated: Temporal.Now.instant().toString(),
      };
      await deps.writeTicket(stateDir, updated);
      return updated;
    },
  };
}
