import type { TickAction } from "./types.ts";
import { isApproved } from "../state/types.ts";
import type { TicketState } from "../state/types.ts";

export interface CreateRemoteRepoDeps {
  createRepo: (slug: string) => Promise<string>;
  isPhaseAlive: (ticketId: string) => boolean;
  writeTicket: (stateDir: string, t: TicketState) => Promise<void>;
  appendLog: (stateDir: string, id: string, entry: object) => Promise<void>;
  runGit: (
    args: string[],
    cwd: string,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export function createRemoteRepoAction(
  deps: CreateRemoteRepoDeps,
): TickAction {
  return {
    label: "Creating remote repository",
    usesAgent: false,
    applies(ticket: TicketState): boolean {
      return (
        ticket.phase === "plan" &&
        ticket.status === "waiting" &&
        isApproved(ticket) &&
        (ticket.newRepos?.length ?? 0) > 0 &&
        !deps.isPhaseAlive(ticket.id)
      );
    },
    async run(
      ticket: TicketState,
      stateDir: string,
    ): Promise<TicketState | null> {
      const now = Temporal.Now.instant().toString();
      const remaining = [...(ticket.newRepos ?? [])];

      for (const slug of ticket.newRepos ?? []) {
        const remoteUrl = `https://github.com/${slug}`;

        try {
          await deps.createRepo(slug);
        } catch (e) {
          const updated = {
            ...ticket,
            status: "needs-attention" as const,
            newRepos: remaining,
            updated: now,
          };
          await deps.writeTicket(stateDir, updated);
          await deps.appendLog(stateDir, ticket.id, {
            event: "needs-attention",
            reason: "repo-creation-failed",
            slug,
            message: String(e),
          });
          return updated;
        }

        const worktreeInfo = ticket.worktrees[slug];
        if (worktreeInfo) {
          const { stdout: gitCommonDir } = await deps.runGit(
            ["rev-parse", "--git-common-dir"],
            worktreeInfo.path,
          );
          const repoPath = gitCommonDir.replace(/[/\\]\.git$/, "");

          const { code: addCode } = await deps.runGit(
            ["remote", "add", "origin", remoteUrl],
            repoPath,
          );
          if (addCode !== 0) {
            const updated = {
              ...ticket,
              status: "needs-attention" as const,
              newRepos: remaining,
              updated: now,
            };
            await deps.writeTicket(stateDir, updated);
            await deps.appendLog(stateDir, ticket.id, {
              event: "needs-attention",
              reason: "repo-creation-failed",
              slug,
              message: "git remote add origin failed",
            });
            return updated;
          }

          const { code: pushCode } = await deps.runGit(
            ["push", "origin", "main"],
            repoPath,
          );
          if (pushCode !== 0) {
            const updated = {
              ...ticket,
              status: "needs-attention" as const,
              newRepos: remaining,
              updated: now,
            };
            await deps.writeTicket(stateDir, updated);
            await deps.appendLog(stateDir, ticket.id, {
              event: "needs-attention",
              reason: "repo-creation-failed",
              slug,
              message: "git push origin main failed",
            });
            return updated;
          }
        }

        remaining.splice(remaining.indexOf(slug), 1);
      }

      const updated: TicketState = {
        ...ticket,
        newRepos: remaining.length > 0 ? remaining : undefined,
        updated: now,
      };
      await deps.writeTicket(stateDir, updated);
      return updated;
    },
  };
}
