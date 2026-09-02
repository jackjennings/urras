import { FULL_PHASE_SEQUENCE } from "../phases/types.ts";

export type TicketPhase = typeof FULL_PHASE_SEQUENCE[number];

export type TicketStatus =
  | "new"
  | "running"
  | "waiting"
  | "revising"
  | "needs-attention"
  | "done";

export const STATUS_SEQUENCE = [
  "new",
  "running",
  "waiting",
  "revising",
  "needs-attention",
  "done",
] as const;

const VALID_STATUSES: Record<TicketPhase, ReadonlyArray<TicketStatus>> = {
  intake: ["new", "running", "waiting", "revising", "needs-attention"],
  enrichment: ["running", "waiting", "revising", "needs-attention"],
  spec: ["running", "waiting", "revising", "needs-attention"],
  plan: ["running", "waiting", "revising", "needs-attention"],
  implementation: ["running", "waiting", "revising", "needs-attention"],
  merge: ["waiting", "running", "revising", "done", "needs-attention"],
  "wont-do": ["done"],
};

export function assertValidPhaseStatus(
  phase: TicketPhase,
  status: TicketStatus,
): void {
  const statuses = VALID_STATUSES[phase] as TicketStatus[] | undefined;
  if (!statuses) {
    throw new Error(
      `Unrecognized phase: ${phase} (known phases: ${
        FULL_PHASE_SEQUENCE.join(", ")
      })`,
    );
  }
  if (!statuses.includes(status)) {
    throw new Error(
      `Invalid (phase, status) combination: (${phase}, ${status})`,
    );
  }
}

export interface WorktreeInfo {
  path: string;
  branch: string;
}

export interface PrEntry {
  url: string;
  title: string;
  dependsOn: string[];
  merged: boolean;
  closed?: boolean;
  worktreeKey?: string;
}

export interface ApprovalEntry {
  timestamp: string;
  actor: "human" | "agent" | "unknown";
  phase: TicketPhase;
}

export interface ArtifactDescriptor {
  requiresWorktrees: boolean;
  requiresPRs: boolean;
  completionField: keyof TicketState;
  missingReason: string;
  mergeStatus: "waiting" | "done";
}

export const ARTIFACT_DESCRIPTORS = {
  code: {
    requiresWorktrees: true,
    requiresPRs: true,
    completionField: "prs",
    missingReason: "no-prs",
    mergeStatus: "waiting",
  },
  document: {
    requiresWorktrees: false,
    requiresPRs: false,
    completionField: "documents",
    missingReason: "no-pages",
    mergeStatus: "done",
  },
  work: {
    requiresWorktrees: false,
    requiresPRs: false,
    completionField: "workItems",
    missingReason: "no-work-items",
    mergeStatus: "done",
  },
} satisfies Record<string, ArtifactDescriptor>;

export type ArtifactType = keyof typeof ARTIFACT_DESCRIPTORS;

export interface TicketState {
  id: string;
  provider: string;
  title: string;
  shortTitle?: string;
  url: string;
  phase: TicketPhase;
  status: TicketStatus;
  approvals: ApprovalEntry[];
  scope: string[];
  worktrees: Record<string, WorktreeInfo>;
  prs?: PrEntry[];
  newRepos?: string[];
  ciHandledRunIds?: string[];
  lastSeenCommentTimestamp?: string;
  lastSeenPrCommentTimestamp?: string;
  providerDone?: boolean;
  providerPickedUp?: boolean;
  outputRetries?: number;
  resumeRetries?: number;
  phaseSessionIds?: Partial<Record<string, string>>;
  notifiedNeedsAttention?: boolean;
  created: string;
  updated: string;
  body: string;
  phases?: PhaseModelConfig;
  artifacts: ArtifactType[];
  documents?: { url: string; title: string }[];
  workItems?: { url: string; title: string }[];
  revision?: string;
}

export function isApproved(ticket: TicketState): boolean {
  const last = ticket.approvals.at(-1);
  if (!last) return false;
  return last.phase === ticket.phase;
}

export type PhaseModelConfig = Partial<
  Record<string, { model?: string; thinking?: string; skip?: boolean }>
>;

export interface PhaseModelUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd?: number;
}

export interface PhaseUsage {
  durationMs: number;
  turns?: number;
  tools?: Record<string, number>;
  models: PhaseModelUsage[];
}

export type LearningStatus =
  | "pending"
  | "waiting"
  | "done"
  | "wont-do"
  | "needs-attention";

export interface LearningState {
  id: string;
  ticketId: string;
  repo: string;
  targetFile: string;
  prTitle: string;
  prBody: string;
  status: LearningStatus;
  prs: PrEntry[];
}

export interface Config {
  github: {
    repos: string[];
    accounts?: Record<string, { tokenEnv: string; login: string }>;
    orgs?: Record<string, string>;
  };
  state: { dir: string };
  extensions: { dir: string };
  tick: {
    concurrency: number;
    resolveCIFailures: boolean;
    principles: boolean;
    agentsMdMaxTokens: number;
    maxPromptTokens?: number;
    maxTurns: number;
    checkNewComments?: boolean;
  };
  codebase: { roots: string[] };
  pi: { provider: string; packages: string[] };
  agent: { type: "pi" | "claude-code" };
  jira?: Record<
    string,
    {
      baseUrl: string;
      project: string;
      statuses?: { pickup: string; done: string };
    }
  >;
  todoTxt?: { file: string };
  phases?: {
    defaults?: PhaseModelConfig;
  };
  ollama?: { models: string[]; url?: string };
}
