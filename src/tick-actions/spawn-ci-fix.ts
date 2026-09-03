import { join } from "@std/path";
import type { TickAction } from "./types.ts";
import type { TicketState } from "../state/types.ts";
import { parsePrUrl, slugOf } from "../providers/github/identity.ts";

export type CIConclusion =
  | "failure"
  | "action_required"
  | "success"
  | "pending";

export interface CIRunResult {
  runId: string;
  attempt: number;
  conclusion: CIConclusion;
  failingJobs: string[];
  headSha: string;
}

export function ciFixRunKey(runId: string, attempt: number): string {
  return `${runId}-${attempt}`;
}

export interface SpawnCIFixDeps {
  getPRChecks: (prUrl: string) => Promise<CIRunResult | null>;
  isProcessAlive: (ticketId: string) => boolean;
  writeTicket: (stateDir: string, t: TicketState) => Promise<void>;
  appendLog: (stateDir: string, id: string, entry: object) => Promise<void>;
  spawn: (opts: {
    worktreePath: string;
    branch: string;
    ticketDir: string;
    contextFile: string;
    prUrl: string;
    repo: string;
    runId: string;
    attempt: number;
    model: string;
    thinking: string;
  }) => Promise<void>;
  writeContextFile: (
    ticketDir: string,
    runKey: string,
    content: string,
  ) => Promise<string>;
  resolveModelConfig: (
    ticket: TicketState,
  ) => { model: string; thinking: string };
}

export function spawnCIFixAction(deps: SpawnCIFixDeps): TickAction {
  return {
    label: "Spawning CI fix",
    applies(ticket: TicketState): boolean {
      return (
        ticket.prs !== undefined &&
        ticket.prs.some((pr) => !pr.merged) &&
        ticket.status !== "needs-attention" &&
        ticket.status !== "running" &&
        !deps.isProcessAlive(ticket.id)
      );
    },

    async run(
      ticket: TicketState,
      stateDir: string,
    ): Promise<TicketState | null> {
      const handledKeys = new Set(ticket.ciHandledRunIds ?? []);
      const ticketDir = join(stateDir, ticket.id);

      for (const pr of ticket.prs ?? []) {
        if (pr.merged) continue;

        let ciResult: CIRunResult | null;
        try {
          ciResult = await deps.getPRChecks(pr.url);
        } catch (e) {
          await deps.appendLog(stateDir, ticket.id, {
            event: "error",
            context: "spawnCIFix",
            message: String(e),
          });
          continue;
        }
        if (!ciResult) continue;
        if (
          ciResult.conclusion !== "failure" &&
          ciResult.conclusion !== "action_required"
        ) {
          continue;
        }

        const runKey = ciFixRunKey(ciResult.runId, ciResult.attempt);
        if (handledKeys.has(runKey)) continue;

        const prParsed = parsePrUrl(pr.url);
        const repo = prParsed ? slugOf(prParsed) : "unknown/unknown";

        const worktree = pr.worktreeKey
          ? ticket.worktrees[pr.worktreeKey]
          : undefined;
        const now = Temporal.Now.instant().toString();

        if (!worktree) {
          await deps.appendLog(stateDir, ticket.id, {
            event: "needs-attention",
            reason: "no-worktrees",
            prUrl: pr.url,
            runId: ciResult.runId,
          });
          const parked: TicketState = {
            ...ticket,
            status: "needs-attention",
            updated: now,
          };
          await deps.writeTicket(stateDir, parked);
          return parked;
        }

        if (pr.worktreeKey && pr.worktreeKey !== repo) {
          await deps.appendLog(stateDir, ticket.id, {
            event: "needs-attention",
            reason: "worktree-pr-repo-mismatch",
            prUrl: pr.url,
            worktreeKey: pr.worktreeKey,
            repo,
          });
          const parked: TicketState = {
            ...ticket,
            status: "needs-attention",
            updated: now,
          };
          await deps.writeTicket(stateDir, parked);
          return parked;
        }

        handledKeys.add(runKey);

        const jobsSection = ciResult.failingJobs.map((name) => `- ${name}`)
          .join("\n");
        const content = `PR-URL: ${pr.url}\n` +
          `Repo: ${repo}\n` +
          `Run-ID: ${ciResult.runId}\n` +
          `Attempt: ${ciResult.attempt}\n` +
          `Branch: ${worktree.branch}\n` +
          `Head-SHA: ${ciResult.headSha}\n` +
          `Worktree-Path: ${worktree.path}\n\n` +
          `## Failing jobs\n\n${jobsSection}`;

        let contextFile: string;
        try {
          contextFile = await deps.writeContextFile(ticketDir, runKey, content);
        } catch (e) {
          await deps.appendLog(stateDir, ticket.id, {
            event: "error",
            context: "spawnCIFix",
            message: String(e),
          });
          handledKeys.delete(runKey);
          continue;
        }

        const { model, thinking } = deps.resolveModelConfig(ticket);
        try {
          await deps.spawn({
            worktreePath: worktree.path,
            branch: worktree.branch,
            ticketDir,
            contextFile,
            prUrl: pr.url,
            repo,
            runId: ciResult.runId,
            attempt: ciResult.attempt,
            model,
            thinking,
          });
        } catch (e) {
          await deps.appendLog(stateDir, ticket.id, {
            event: "error",
            context: "spawnCIFix",
            message: String(e),
          });
          handledKeys.delete(runKey);
          continue;
        }

        const updated: TicketState = {
          ...ticket,
          ciHandledRunIds: [...handledKeys],
          updated: now,
        };
        await deps.writeTicket(stateDir, updated);
        return updated;
      }

      return null;
    },
  };
}
