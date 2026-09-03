import { join } from "@std/path";
import type { TickAction } from "./types.ts";
import type { LearningState, TicketState } from "../state/types.ts";

export interface ResolveCIFixDeps {
  isProcessAlive: (ticketId: string) => boolean;
  hasCIFixContextFiles: (ticketId: string) => boolean;
  readDir: (path: string) => AsyncIterable<{ name: string; isFile: boolean }>;
  readFile: (path: string) => Promise<string | null>;
  remove: (path: string) => Promise<void>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  runGit: (
    args: string[],
    cwd: string,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  rerunFailedJobs: (opts: { repo: string; runId: string }) => Promise<void>;
  writeTicket: (stateDir: string, t: TicketState) => Promise<void>;
  appendLog: (stateDir: string, id: string, entry: object) => Promise<void>;
  writeLearning: (
    learning: Omit<LearningState, "id">,
    intent: string,
  ) => Promise<void>;
}

export function resolveCIFixAction(deps: ResolveCIFixDeps): TickAction {
  return {
    label: "Resolving CI fix",
    applies(ticket: TicketState): boolean {
      return (
        deps.hasCIFixContextFiles(ticket.id) && !deps.isProcessAlive(ticket.id)
      );
    },

    async run(
      ticket: TicketState,
      stateDir: string,
    ): Promise<TicketState | null> {
      const ticketDir = join(stateDir, ticket.id);
      const now = Temporal.Now.instant().toString();

      const contextFiles: string[] = [];
      try {
        for await (const entry of deps.readDir(ticketDir)) {
          if (
            entry.isFile &&
            entry.name.includes("-ci-fix-context-") &&
            entry.name.endsWith(".md")
          ) {
            contextFiles.push(entry.name);
          }
        }
      } catch {
        // ticketDir not readable
      }

      if (contextFiles.length === 0) return null;

      const updated: TicketState = { ...ticket, updated: now };

      const park = async (
        contextPath: string,
        reason: string,
        fields: Record<string, unknown>,
      ): Promise<TicketState> => {
        await deps.appendLog(stateDir, ticket.id, {
          event: reason === "ci-unfixable" ? "needs-attention" : "error",
          context: "resolveCIFix",
          reason,
          ...fields,
        });
        await deps.rename(contextPath, contextPath + ".parked");
        const parked: TicketState = {
          ...ticket,
          status: "needs-attention",
          updated: now,
        };
        await deps.writeTicket(stateDir, parked);
        return parked;
      };

      for (const contextFilename of contextFiles) {
        const contextPath = join(ticketDir, contextFilename);
        const contextContent = await deps.readFile(contextPath);
        if (contextContent === null) {
          await deps.appendLog(stateDir, ticket.id, {
            event: "error",
            context: "resolveCIFix",
            reason: "context-file-unreadable",
            contextFile: contextFilename,
          });
          await deps.remove(contextPath);
          continue;
        }

        const headers: Record<string, string> = {};
        for (const line of contextContent.split("\n")) {
          const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
          if (m) headers[m[1]] = m[2].trim();
        }
        const prUrl = headers["PR-URL"] ?? "";
        const repo = headers["Repo"] ?? "";
        const runId = headers["Run-ID"] ?? "";
        const attempt = headers["Attempt"] ?? "";
        const branch = headers["Branch"] ?? "";
        const headSha = headers["Head-SHA"] ?? "";
        const worktreePath = headers["Worktree-Path"] ?? "";

        const outputFilename = contextFilename.replace(
          "-ci-fix-context-",
          "-ci-fix-",
        );
        const outputPath = join(ticketDir, outputFilename);
        const outputContent = await deps.readFile(outputPath);

        if (outputContent === null) {
          return await park(contextPath, "output-file-missing", { runId });
        }

        const verdictMatch = outputContent.match(
          /^VERDICT:\s*(FIXED|INFRA|UNFIXABLE)/im,
        );
        if (!verdictMatch) {
          return await park(contextPath, "no-verdict-line", {
            runId,
            outputExcerpt: outputContent.trim().slice(0, 200),
          });
        }

        const verdict = verdictMatch[1].toUpperCase() as
          | "FIXED"
          | "INFRA"
          | "UNFIXABLE";

        if (verdict === "UNFIXABLE") {
          return await park(contextPath, "ci-unfixable", { runId, prUrl });
        }

        if (verdict === "FIXED") {
          if (worktreePath === "" || branch === "") {
            return await park(contextPath, "no-worktrees", { runId, prUrl });
          }
          if (headSha !== "") {
            const head = await deps.runGit(["rev-parse", "HEAD"], worktreePath);
            if (head.code === 0 && head.stdout.trim() === headSha) {
              return await park(contextPath, "no-commit", {
                runId,
                prUrl,
                branch,
              });
            }
          }
          const push = await deps.runGit(
            headSha === ""
              ? ["push", "--force-with-lease", "origin", branch]
              : [
                "push",
                `--force-with-lease=refs/heads/${branch}:${headSha}`,
                "origin",
                branch,
              ],
            worktreePath,
          );
          if (push.code !== 0) {
            return await park(contextPath, "push-failed", { runId, branch });
          }
          await deps.appendLog(stateDir, ticket.id, {
            event: "branch-pushed",
            worktreePath,
            branch,
          });

          const learningMatch = outputContent.match(/^LEARNING:\s*(.+)$/im);
          const learningText = learningMatch?.[1]?.trim() ?? "";
          if (learningText) {
            try {
              await deps.writeLearning(
                {
                  ticketId: ticket.id,
                  repo,
                  targetFile: "AGENTS.md",
                  status: "pending",
                  prs: [],
                },
                learningText,
              );
            } catch (e) {
              await deps.appendLog(stateDir, ticket.id, {
                event: "error",
                context: "resolveCIFix",
                message: String(e),
              });
            }
          }
        }

        if (verdict === "INFRA") {
          const parsedAttempt = Number.parseInt(attempt, 10);
          const attemptNumber = Number.isNaN(parsedAttempt) ? 1 : parsedAttempt;
          if (attemptNumber >= 2) {
            return await park(contextPath, "infra-rerun-exhausted", {
              runId,
              prUrl,
            });
          }
          try {
            await deps.rerunFailedJobs({ repo, runId });
          } catch (e) {
            await deps.appendLog(stateDir, ticket.id, {
              event: "error",
              context: "resolveCIFix",
              reason: "rerun-failed",
              runId,
              message: String(e),
            });
          }
        }

        await deps.remove(contextPath);
        await deps.remove(outputPath);

        await deps.appendLog(stateDir, ticket.id, {
          event: "ci-fix-resolved",
          prUrl,
          runId,
          attempt,
          verdict,
        });
      }

      await deps.writeTicket(stateDir, updated);
      return updated;
    },
  };
}
