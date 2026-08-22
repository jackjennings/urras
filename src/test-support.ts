import type { TicketState } from "./state/types.ts";
import { removeSync } from "./filesystem.ts";
import { appendTickLog, type TickServiceDeps } from "./tick.ts";
import type { TickDeps } from "./phases/advance.ts";

export function makeTicket(overrides: Partial<TicketState> = {}): TicketState {
  return {
    id: "github/org/repo/1",
    provider: "github",
    title: "T",
    url: "https://github.com/org/repo/issues/1",
    phase: "intake",
    status: "new",
    approvals: [],
    scope: [],
    worktrees: {},
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
    body: "",
    artifacts: ["code"],
    ...overrides,
  };
}

export function makeTickDeps(overrides: Partial<TickDeps> = {}): TickDeps {
  return {
    spawn: () => Promise.resolve(),
    isProcessAlive: () => false,
    writeTicket: () => Promise.resolve(),
    writePhaseOutput: () => Promise.resolve(),
    appendLog: () => Promise.resolve(),
    resolveModelConfig: () => ({ model: "claude-sonnet-4-6", thinking: "off" }),
    selfReview: () => Promise.resolve({ approved: false, reason: null }),
    markPRsReady: () => Promise.resolve(),
    readPhaseOutput: () => Promise.resolve("content"),
    appendPrinciples: () => Promise.resolve(),
    readPhaseExitCode: () => Promise.resolve(0),
    readPhaseSessionId: () => Promise.resolve(null),
    buildRepoCorpusText: () => Promise.resolve(""),
    spawnOutlierAnalysis: () => Promise.resolve(),
    adjudicatePhaseModel: () => Promise.resolve(null),
    readRunPidBootStamp: () => Promise.resolve(null),
    currentBootId: () => "boot",
    ...overrides,
  };
}

export function makeTickServiceDeps(
  overrides: Partial<TickServiceDeps> = {},
): TickServiceDeps {
  return {
    stateDir: "/state",
    concurrency: 1,
    packageSources: [],
    installPackages: () => Promise.resolve([]),
    providers: [],
    tickActions: [],
    tickDeps: makeTickDeps(),
    runMigrations: (_dir, tickets) => Promise.resolve(tickets),
    readLastWorked: () => Promise.resolve([]),
    writeLastWorked: () => Promise.resolve(),
    listTickets: () => Promise.resolve([]),
    readTicket: (_id) => Promise.resolve(makeTicket()),
    writeTicket: () => Promise.resolve(),
    commitState: () => Promise.resolve(),
    lock: { withLock: (fn) => fn() },
    exit: () => {},
    refreshAnthropicPricing: () => Promise.resolve(),
    processLearnings: () => Promise.resolve(),
    notify: () => Promise.resolve(),
    appendTickLog,
    agentsMdPaths: [],
    runCeremonies: () => Promise.resolve(),
    scaffoldStatePrompts: () => Promise.resolve(),
    generateShortTitle: () => Promise.resolve(null),
    notifyTickFailure: () => Promise.resolve(),
    preflightGitHubCredentials: () => Promise.resolve(),
    reconcileRepoIdentities: () => Promise.resolve(),
    writeTickProgress: () => Promise.resolve(),
    ...overrides,
  };
}

export function withLazyboyDir(): Disposable & { path: string } {
  const path = Deno.makeTempDirSync();
  const original = Deno.env.get("URRAS_DIR");
  Deno.env.set("URRAS_DIR", path);
  return {
    path,
    [Symbol.dispose]() {
      if (original !== undefined) {
        Deno.env.set("URRAS_DIR", original);
      } else {
        Deno.env.delete("URRAS_DIR");
      }
      try {
        removeSync(path, { recursive: true });
      } catch {
        // temp dir already removed
      }
    },
  };
}
