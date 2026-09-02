import pLimit from "p-limit";
import { estimateTokenCount } from "tokenx";
import { adjudicatePhaseModel } from "./pre-phase-adjudication.ts";
import { advancePhase, type TickDeps } from "./phases/advance.ts";
import type { CandidateSelector } from "./candidate-selection.ts";
import type { Lock } from "./lock.ts";
import type { Provider } from "./providers/types.ts";
import type { TickAction } from "./tick-actions/types.ts";
import type { MigrationFn } from "./migrations/runner.ts";
import type { InstallResult } from "./packages.ts";
import { isApproved, type TicketState } from "./state/types.ts";
import { readTextFile } from "./filesystem.ts";
import { CorruptRepoIdentitiesError } from "./providers/github/repo-identity.ts";
import { StaleTicketWriteError } from "./state/store.ts";
import { shouldHideTicket } from "./commands/status.ts";

const TICK_DEADLINE_MS = 4 * 60 * 60 * 1000;
const TICK_ACTION_CONCURRENCY = 10;

export interface TickServiceDeps {
  stateDir: string;
  concurrency: number;
  packageSources: string[];
  installPackages(sources: string[]): Promise<InstallResult[]>;
  providers: Provider[];
  tickActions: TickAction[];
  tickDeps: TickDeps;
  runMigrations: MigrationFn;
  selectCandidates: CandidateSelector;
  listTickets(): Promise<string[]>;
  readTicket(id: string): Promise<TicketState>;
  writeTicket(ticket: TicketState): Promise<void>;
  commitState(): Promise<void>;
  lock: Lock;
  exit(code: number): void;
  refreshAnthropicPricing(): Promise<void>;
  processLearnings(): Promise<void>;
  notify(ticket: TicketState): Promise<void>;
  appendTickLog(entry: object): Promise<void>;
  agentsMdPaths: string[];
  agentsMdMaxTokens?: number;
  runCeremonies(): Promise<void>;
  scaffoldStatePrompts(): Promise<void>;
  generateShortTitle(
    title: string,
    context?: string,
  ): Promise<string | null>;
  notifyTickFailure(error: string): Promise<void>;
  preflightGitHubCredentials(): Promise<void>;
  reconcileRepoIdentities(): Promise<void>;
  writeTickProgress: (label: string | null) => Promise<void>;
  deadlineMs?: number;
}

class TickDeadlineError extends Error {}

export class TickService {
  #deps: TickServiceDeps;

  constructor(deps: TickServiceDeps) {
    this.#deps = deps;
  }

  async run(): Promise<void> {
    const deps = this.#deps;
    const deadlineMs = deps.deadlineMs ?? TICK_DEADLINE_MS;
    let deadlineTimerId: ReturnType<typeof setTimeout> | undefined;
    try {
      await deps.refreshAnthropicPricing();
      await deps.installPackages(deps.packageSources);
      try {
        await Promise.race([
          deps.lock.withLock(async () => {
            await deps.appendTickLog({
              event: "tick-start",
            });
            try {
              await this.#runWorkflow(deps);
            } catch (e) {
              await deps.appendTickLog({
                ts: Temporal.Now.instant().toString(),
                event: "tick-failed",
                error: e instanceof Error ? e.message : String(e),
              });
              throw e;
            }
            await deps.appendTickLog({
              event: "tick-end",
            });
          }),
          new Promise<never>((_, reject) => {
            deadlineTimerId = setTimeout(
              () => reject(new TickDeadlineError()),
              deadlineMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(deadlineTimerId);
      }
    } catch (e) {
      if (e instanceof TickDeadlineError) {
        await deps.appendTickLog({
          event: "tick-deadline-exceeded",
          deadlineMs,
        });
        try {
          await deps.notifyTickFailure("tick deadline exceeded");
        } catch {
          // notification failure must not suppress exit
        }
        deps.exit(1);
        return;
      }
      const errorStr = e instanceof Error ? e.message : String(e);
      console.error(e);
      try {
        await deps.notifyTickFailure(errorStr);
      } catch {
        // notification failure must not suppress original error or change exit code
      }
      deps.exit(1);
    }
  }

  async #runWorkflow(deps: TickServiceDeps): Promise<void> {
    await deps.preflightGitHubCredentials();
    await deps.processLearnings();
    let captureEnabled = true;
    try {
      await deps.reconcileRepoIdentities();
    } catch (e) {
      if (e instanceof CorruptRepoIdentitiesError) {
        await deps.appendTickLog({
          event: "repo-identity-unavailable",
          error: e instanceof Error ? e.message : String(e),
        });
        captureEnabled = false;
      } else {
        throw e;
      }
    }
    if (captureEnabled) {
      const existingIds = new Set(await deps.listTickets());
      for (const provider of deps.providers) {
        const newItems = await provider.fetchNew(existingIds);
        for (const item of newItems) {
          const shortTitle =
            (await deps.generateShortTitle(item.title, item.description)) ??
              undefined;
          await deps.writeTicket({
            id: item.id,
            provider: item.provider,
            title: item.title,
            shortTitle,
            url: item.url,
            phase: "intake",
            status: "new",
            approvals: [],
            scope: [],
            worktrees: {},
            created: Temporal.Now.instant().toString(),
            updated: Temporal.Now.instant().toString(),
            body: item.description,
            artifacts: ["code"],
          });
          await deps.tickDeps.appendLog(deps.stateDir, item.id, {
            event: "ticket-captured",
            title: item.title,
          });
        }
      }
    } // end if (captureEnabled)

    const ids = (await deps.listTickets()).sort();
    const settled = await Promise.allSettled(
      ids.map((id) => deps.readTicket(id)),
    );
    const validTickets: TicketState[] = [];
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status === "fulfilled") {
        validTickets.push(result.value);
      } else {
        const err = result.reason;
        await deps.appendTickLog({
          event: "ticket-read-error",
          id: ids[i],
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const migratedTickets = await deps.runMigrations(
      deps.stateDir,
      validTickets,
    );

    const processedTickets = [...migratedTickets];
    const droppedTicketIds = new Set<string>();
    const activeTicketCount = processedTickets.filter(
      (t) => !shouldHideTicket(t.phase, t.status),
    ).length;

    await deps.writeTickProgress(`Checking [${activeTicketCount} tickets]`);

    const limit = pLimit(TICK_ACTION_CONCURRENCY);
    const tasks = processedTickets.map((ticket) =>
      limit(async () => {
        if (ticket.phase === "wont-do") return ticket;
        let current = ticket;
        for (const action of deps.tickActions) {
          try {
            if (action.applies(current)) {
              const updated = await action.run(current, deps.stateDir);
              if (updated !== null) current = updated;
            }
          } catch (e) {
            if (e instanceof StaleTicketWriteError) {
              await deps.tickDeps.appendLog(
                deps.stateDir,
                current.id,
                { event: "stale-write", context: "tickAction" },
              );
              droppedTicketIds.add(current.id);
              break;
            }
            await deps.tickDeps.appendLog(
              deps.stateDir,
              current.id,
              {
                event: "error",
                context: "tickAction",
                action:
                  (action as { constructor?: { name?: string } }).constructor
                    ?.name ?? "unknown",
                message: String(e),
              },
            );
          }
        }
        return current;
      })
    );

    const results = await Promise.allSettled(tasks);
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        processedTickets[i] = result.value;
      }
    }

    await deps.writeTickProgress(null);

    for (let i = 0; i < processedTickets.length; i++) {
      const ticket = processedTickets[i];
      if (droppedTicketIds.has(ticket.id)) continue;
      if (
        ticket.status === "needs-attention" && !ticket.notifiedNeedsAttention
      ) {
        const updated = { ...ticket, notifiedNeedsAttention: true };
        try {
          await deps.writeTicket(updated);
          processedTickets[i] = updated;
        } catch (e) {
          if (!(e instanceof StaleTicketWriteError)) throw e;
          await deps.tickDeps.appendLog(
            deps.stateDir,
            ticket.id,
            { event: "stale-write", context: "notify" },
          );
          continue;
        }
        await deps.notify(ticket);
      }
    }

    const runningTickets = processedTickets.filter(
      (t) => t.status === "running" && !droppedTicketIds.has(t.id),
    );
    const candidateTickets = processedTickets.filter(
      (t) =>
        !droppedTicketIds.has(t.id) &&
        t.status !== "done" &&
        t.status !== "needs-attention" &&
        !(t.phase === "merge" && t.status === "waiting") &&
        t.status !== "running" &&
        t.phase !== "wont-do",
    );

    const selectedIds = await deps.selectCandidates(
      candidateTickets.map((t) => t.id),
      deps.concurrency,
    );
    const selectedSet = new Set(selectedIds);

    for (const ticket of runningTickets) {
      await advancePhase(ticket, deps.stateDir, deps.tickDeps);
    }

    let running =
      runningTickets.filter((t) => deps.tickDeps.isProcessAlive(t.id)).length;
    for (const ticket of candidateTickets) {
      if (!selectedSet.has(ticket.id)) continue;
      const willSpawn = ticket.status === "new" ||
        ticket.status === "revising" ||
        (ticket.status === "waiting" && isApproved(ticket));
      if (willSpawn && running >= deps.concurrency) continue;
      if (willSpawn) {
        running++;
        const agentsMdMaxTokens = deps.agentsMdMaxTokens ?? 0;
        if (deps.agentsMdPaths.length > 0 && agentsMdMaxTokens > 0) {
          for (const agentsMdPath of deps.agentsMdPaths) {
            let content: string;
            try {
              content = await readTextFile(agentsMdPath);
            } catch {
              continue;
            }
            const tokens = estimateTokenCount(content);
            if (tokens > agentsMdMaxTokens) {
              await deps.appendTickLog({
                event: "agents-md-too-large",
                path: agentsMdPath,
                tokens,
                maxTokens: agentsMdMaxTokens,
              });
            }
          }
        }
      }
      await advancePhase(ticket, deps.stateDir, deps.tickDeps);
    }

    await deps.scaffoldStatePrompts();
    await deps.commitState();
    await deps.runCeremonies();
  }
}

export { adjudicatePhaseModel };
