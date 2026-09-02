import { join } from "@std/path";
import type { TickAction } from "./types.ts";
import type { TicketState } from "../state/types.ts";

export interface CheckConflictsDeps {
  runGit: (
    args: string[],
    cwd: string,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  isProcessAlive: (ticketId: string) => boolean;
  worktreeExists: (path: string) => boolean;
  writeTicket: (stateDir: string, t: TicketState) => Promise<void>;
  appendLog: (stateDir: string, id: string, entry: object) => Promise<void>;
  spawn: (opts: {
    worktreePath: string;
    branch: string;
    ticketDir: string;
    contextFile: string;
    conflictedFiles: string[];
    rebaseStderr: string;
    model: string;
    thinking: string;
  }) => Promise<void>;
  writeContextFile: (
    ticketDir: string,
    branch: string,
    content: string,
  ) => Promise<string>;
  resolveModelConfig: (
    ticket: TicketState,
  ) => { model: string; thinking: string };
}

export function sanitizeBranchForFilename(branch: string): string {
  return encodeURIComponent(branch);
}

export function checkConflictsAction(deps: CheckConflictsDeps): TickAction {
  const fetchQueue = new Map<string, Promise<unknown>>();
  return {
    label: "Checking conflicts",
    applies(ticket: TicketState): boolean {
      return (
        ticket.status !== "needs-attention" &&
        ticket.status !== "running" &&
        Object.values(ticket.worktrees).some((wt) =>
          deps.worktreeExists(wt.path)
        ) &&
        !deps.isProcessAlive(ticket.id)
      );
    },
    async run(
      ticket: TicketState,
      stateDir: string,
    ): Promise<TicketState | null> {
      const now = Temporal.Now.instant().toString();
      const ticketDir = join(stateDir, ticket.id);

      type ConflictResult =
        | {
          kind: "conflict";
          wt: { path: string; branch: string };
          conflictedFiles: string[];
          rebaseStderr: string;
          contextFilename: string;
        }
        | {
          kind: "blocked";
          wt: { path: string; branch: string };
          rebaseStderr: string;
          dirtyFileCount: number;
          dirtyFileSample: string[];
        };

      const conflictResults = await Promise.all(
        Object.entries(ticket.worktrees)
          .filter(([, wt]) => deps.worktreeExists(wt.path))
          .map(async ([slug, wt]): Promise<ConflictResult | null> => {
            const prev = fetchQueue.get(slug) ?? Promise.resolve();
            const fetchPromise = prev
              .catch(() => {})
              .then(() => deps.runGit(["fetch", "origin", "main"], wt.path));
            fetchQueue.set(slug, fetchPromise);

            const fetch = await fetchPromise;
            fetchQueue.set(slug, Promise.resolve());
            if (fetch.code !== 0) {
              await deps.appendLog(stateDir, ticket.id, {
                event: "error",
                context: "checkConflicts",
                worktreePath: wt.path,
                stderr: fetch.stderr,
              });
              return null;
            }

            const rebase = await deps.runGit(
              ["rebase", "origin/main"],
              wt.path,
            );

            if (rebase.code === 0) {
              if (ticket.prs !== undefined && ticket.prs.length > 0) {
                const push = await deps.runGit(
                  ["push", "--force-with-lease", "origin", wt.branch],
                  wt.path,
                );
                if (push.code !== 0) {
                  await deps.appendLog(stateDir, ticket.id, {
                    event: "error",
                    context: "checkConflicts",
                    worktreePath: wt.path,
                    pushStderr: push.stderr,
                  });
                } else if (
                  !/Everything up-to-date/i.test(push.stderr) &&
                  !/Everything up-to-date/i.test(push.stdout)
                ) {
                  await deps.appendLog(stateDir, ticket.id, {
                    event: "branch-pushed",
                    worktreePath: wt.path,
                    branch: wt.branch,
                  });
                }
              }
              return null;
            }

            const diff = await deps.runGit(
              ["diff", "--name-only", "--diff-filter=U"],
              wt.path,
            );
            const conflictedFiles = diff.stdout
              .split("\n")
              .map((f) => f.trim())
              .filter((f) => f.length > 0);

            if (conflictedFiles.length === 0) {
              await deps.runGit(["rebase", "--abort"], wt.path);
              const status = await deps.runGit(["status", "--short"], wt.path);
              const dirtyLines = status.stdout
                .split("\n")
                .filter((l) => l.length > 0);
              return {
                kind: "blocked",
                wt,
                rebaseStderr: rebase.stderr,
                dirtyFileCount: dirtyLines.length,
                dirtyFileSample: dirtyLines.slice(0, 20),
              };
            }

            const safeBranch = sanitizeBranchForFilename(wt.branch);
            const contextContent =
              `# Conflict Context\n\n## Conflicted Files\n\n${
                conflictedFiles.map((f) => `- ${f}`).join("\n")
              }\n\n## Rebase Stderr\n\n\`\`\`\n${rebase.stderr}\n\`\`\`\n`;
            const contextFilename = await deps.writeContextFile(
              ticketDir,
              safeBranch,
              contextContent,
            );

            return {
              kind: "conflict",
              wt,
              conflictedFiles,
              rebaseStderr: rebase.stderr,
              contextFilename,
            };
          }),
      );

      const firstBlocked = conflictResults.find(
        (r): r is Extract<ConflictResult, { kind: "blocked" }> =>
          r !== null && (r as ConflictResult).kind === "blocked",
      );
      if (firstBlocked) {
        const updated: TicketState = {
          ...ticket,
          status: "needs-attention",
          updated: now,
        };
        await deps.writeTicket(stateDir, updated);
        await deps.appendLog(stateDir, ticket.id, {
          event: "needs-attention",
          reason: "rebase-blocked",
          worktreePath: firstBlocked.wt.path,
          branch: firstBlocked.wt.branch,
          rebaseStderr: firstBlocked.rebaseStderr,
          dirtyFileCount: firstBlocked.dirtyFileCount,
          dirtyFileSample: firstBlocked.dirtyFileSample,
        });
        return updated;
      }

      const firstConflict = conflictResults.find(
        (r): r is Extract<ConflictResult, { kind: "conflict" }> =>
          r !== null && (r as ConflictResult).kind === "conflict",
      );
      if (!firstConflict) return null;

      const { model, thinking } = deps.resolveModelConfig(ticket);
      await deps.spawn({
        worktreePath: firstConflict.wt.path,
        branch: firstConflict.wt.branch,
        ticketDir,
        contextFile: firstConflict.contextFilename,
        conflictedFiles: firstConflict.conflictedFiles,
        rebaseStderr: firstConflict.rebaseStderr,
        model,
        thinking,
      });

      const updated: TicketState = {
        ...ticket,
        status: "running",
        updated: now,
        phaseSessionIds: ticket.phaseSessionIds
          ? { ...ticket.phaseSessionIds, implementation: undefined }
          : undefined,
      };
      await deps.writeTicket(stateDir, updated);
      await deps.appendLog(stateDir, ticket.id, {
        event: "conflict-resolution-started",
        worktreePath: firstConflict.wt.path,
        branch: firstConflict.wt.branch,
        conflictedFiles: firstConflict.conflictedFiles,
        rebaseStderr: firstConflict.rebaseStderr,
      });
      return updated;
    },
  };
}
