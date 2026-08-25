import { join } from "@std/path";
import { estimateTokenCount } from "tokenx";
import { deleteRunPid } from "../executor.ts";
import { extractPrinciples } from "../run-phase.ts";
import {
  loadArtifactPrompt,
  loadPrompt,
  loadProviderPrompt,
  loadRevisionPrompt,
  loadStatePrompt,
} from "./runners.ts";
import { DEFAULT_PIPELINE_STEPS, nextPipelinePhase } from "./pipeline.ts";
import { compactTimestamp } from "../timestamp.ts";
import {
  type ApprovalEntry,
  isApproved,
  type TicketState,
  type WorktreeInfo,
} from "../state/types.ts";
import type { ActivePhase } from "./types.ts";
import { readDir, readTextFile } from "../filesystem.ts";

const DEFAULT_MAX_PROMPT_TOKENS = 5_000;

export interface TickDeps {
  spawn: (opts: {
    phase: ActivePhase;
    ticketDir: string;
    prompt: string;
    scope: string[];
    worktrees: Record<string, WorktreeInfo>;
    outputFile: string;
    model: string;
    thinking: string;
    sessionId?: string;
    resume?: boolean;
  }) => Promise<void>;
  isProcessAlive: (ticketId: string) => boolean;
  writeTicket: (stateDir: string, t: TicketState) => Promise<void>;
  writePhaseOutput: (
    stateDir: string,
    id: string,
    file: string,
    content: string,
  ) => Promise<void>;
  appendLog: (stateDir: string, id: string, entry: object) => Promise<void>;
  resolveModelConfig: (
    phase: ActivePhase,
    ticket: TicketState,
  ) => { model: string; thinking: string };
  selfReview: (
    phase: string,
    ticketDir: string,
    worktreePath?: string,
  ) => Promise<{ approved: boolean; reason: string | null }>;
  markPRsReady: (prUrls: string[]) => Promise<void>;
  readPhaseOutput: (
    ticketDir: string,
    phase: string,
  ) => Promise<string | null>;
  appendPrinciples: (
    stateDir: string,
    ticketId: string,
    phase: string,
    outputContent: string,
  ) => Promise<void>;
  readPhaseExitCode: (
    ticketDir: string,
    phase: string,
  ) => Promise<number | null>;
  readPhaseSessionId: (
    ticketDir: string,
    phase: string,
  ) => Promise<string | null>;
  maxPromptTokens?: number;
  buildRepoCorpusText: () => Promise<string>;
  buildPipelineOptionsText: () => Promise<string>;
  spawnOutlierAnalysis: (
    ticketId: string,
    ticketDir: string,
    lazboyWorktreePath: string,
    phase: "implementation" | "plan",
  ) => Promise<void>;
  adjudicatePhaseModel: (
    prompt: string,
  ) => Promise<{ model: string; thinking: string } | null>;
  readRunPidBootStamp: (ticketDir: string) => Promise<string | null>;
  currentBootId: () => string;
}

export async function advancePhase(
  ticket: TicketState,
  stateDir: string,
  deps: TickDeps,
): Promise<void> {
  const zonedNow = Temporal.Now.zonedDateTimeISO("UTC");
  const now = zonedNow.toInstant().toString();
  const requiresPRs = ticket.artifacts.includes("code");
  const requiresWorktrees = ticket.artifacts.includes("code");
  const mergeStatus: "waiting" | "done" = requiresPRs ? "waiting" : "done";

  if (ticket.status === "revising") {
    const isMergeRevision = ticket.phase === "merge";
    const activePhase = isMergeRevision
      ? "implementation"
      : ticket.phase as ActivePhase;
    const outputFile = `${compactTimestamp(zonedNow)}-${
      isMergeRevision ? "merge" : activePhase
    }.md`;
    const isImplementationRevision = activePhase === "implementation";
    const revisionPrompt = await loadRevisionPrompt(activePhase);
    const basePrompt = revisionPrompt || await loadPrompt(activePhase);
    const revisingSupplement = await loadProviderPrompt(
      activePhase,
      ticket.provider,
    );
    const revisingArtifactSupplement = await loadArtifactPrompt(
      activePhase,
      ticket.artifacts,
    );
    const revisingStatePrompt = await loadStatePrompt(
      activePhase,
      stateDir,
      ticket.provider,
      ticket.id,
    );
    const revisingStateRevisionPrompt = await loadStatePrompt(
      `${activePhase}-revision`,
      stateDir,
      ticket.provider,
      ticket.id,
    );
    let commentContext = "";
    try {
      const contextFiles: string[] = [];
      for await (const entry of readDir(join(stateDir, ticket.id))) {
        if (entry.isFile && entry.name.endsWith("-comment-context.md")) {
          contextFiles.push(entry.name);
        }
      }
      contextFiles.sort();
      const last = contextFiles.at(-1);
      if (last) {
        commentContext = await readTextFile(join(stateDir, ticket.id, last));
      }
    } catch {
      // directory missing or unreadable — proceed without comment context
    }
    const prompt = [
      basePrompt,
      revisingSupplement,
      revisingArtifactSupplement,
      revisingStatePrompt,
      revisingStateRevisionPrompt,
      commentContext,
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");
    const threshold = deps.maxPromptTokens ?? DEFAULT_MAX_PROMPT_TOKENS;
    const tokens = estimateTokenCount(prompt);
    if (tokens > threshold) {
      await deps.appendLog(stateDir, ticket.id, {
        event: "prompt-too-long",
        phase: activePhase,
        tokens,
        maxTokens: threshold,
      });
    }
    const { model: revisingModel, thinking: revisingThinking } = deps
      .resolveModelConfig(activePhase, ticket);
    let sessionId: string | undefined;
    if (isImplementationRevision) {
      const stored = ticket.phaseSessionIds?.["implementation"];
      if (stored) sessionId = stored;
    }
    await deps.spawn({
      phase: activePhase,
      ticketDir: join(stateDir, ticket.id),
      prompt,
      scope: ticket.scope,
      worktrees: isImplementationRevision ? ticket.worktrees : {},
      outputFile,
      model: revisingModel,
      thinking: revisingThinking,
      sessionId,
      resume: sessionId !== undefined,
    });
    await deps.writeTicket(stateDir, {
      ...ticket,
      status: "running",
      updated: now,
      notifiedNeedsAttention: false,
    });
    await deps.appendLog(stateDir, ticket.id, {
      event: "status-transition",
      phase: ticket.phase,
      from: "revising",
      to: "running",
    });
    return;
  }

  if (ticket.status === "new") {
    const intakeBase = await loadPrompt("intake");
    const intakeSupplement = await loadProviderPrompt(
      "intake",
      ticket.provider,
    );
    const intakeArtifactSupplement = await loadArtifactPrompt(
      "intake",
      ticket.artifacts,
    );
    const corpusText = await deps.buildRepoCorpusText();
    const pipelineOptionsText = await deps.buildPipelineOptionsText();
    const intakeStatePrompt = await loadStatePrompt(
      "intake",
      stateDir,
      ticket.provider,
      ticket.id,
    );
    const prompt = [
      intakeBase,
      intakeSupplement,
      intakeArtifactSupplement,
      corpusText,
      pipelineOptionsText,
      intakeStatePrompt,
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");
    const threshold = deps.maxPromptTokens ?? DEFAULT_MAX_PROMPT_TOKENS;
    const tokens = estimateTokenCount(prompt);
    if (tokens > threshold) {
      await deps.appendLog(stateDir, ticket.id, {
        event: "prompt-too-long",
        phase: "intake",
        tokens,
        maxTokens: threshold,
      });
    }
    const { model: intakeModel, thinking: intakeThinking } = deps
      .resolveModelConfig("intake", ticket);
    const intakeUuid = crypto.randomUUID();
    await deps.writeTicket(stateDir, {
      ...ticket,
      phase: "intake",
      status: "running",
      updated: now,
      phaseSessionIds: { ...ticket.phaseSessionIds, intake: intakeUuid },
    });
    await deps.spawn({
      phase: "intake",
      ticketDir: join(stateDir, ticket.id),
      prompt,
      scope: [],
      worktrees: {},
      outputFile: `${compactTimestamp(zonedNow)}-intake.md`,
      model: intakeModel,
      thinking: intakeThinking,
      sessionId: intakeUuid,
    });
    await deps.appendLog(stateDir, ticket.id, {
      event: "status-transition",
      phase: "intake",
      from: "new",
      to: "running",
    });
    return;
  }

  if (ticket.status === "running") {
    if (!deps.isProcessAlive(ticket.id)) {
      const storedBootId = await deps.readRunPidBootStamp(
        join(stateDir, ticket.id),
      );
      await deleteRunPid(join(stateDir, ticket.id));
      const sessionIdFromSidecar = await deps.readPhaseSessionId(
        join(stateDir, ticket.id),
        ticket.phase,
      );
      const phaseSessionIds = sessionIdFromSidecar !== null
        ? { ...ticket.phaseSessionIds, [ticket.phase]: sessionIdFromSidecar }
        : ticket.phaseSessionIds;
      const waitingTicket: TicketState = {
        ...ticket,
        outputRetries: undefined,
        status: "waiting",
        updated: now,
        phaseSessionIds,
      };
      await deps.writeTicket(stateDir, waitingTicket);
      await deps.appendLog(stateDir, ticket.id, {
        event: "status-transition",
        phase: ticket.phase,
        from: "running",
        to: "waiting",
      });

      const exitCode = await deps.readPhaseExitCode(
        join(stateDir, ticket.id),
        ticket.phase,
      );
      if (exitCode === null) {
        const currentId = deps.currentBootId();
        if (
          storedBootId !== null &&
          storedBootId !== currentId &&
          waitingTicket.phaseSessionIds?.[ticket.phase]
        ) {
          const sessionId = waitingTicket.phaseSessionIds[ticket.phase]!;
          const outputFile = `${compactTimestamp(zonedNow)}-${ticket.phase}.md`;
          const resumePhase: ActivePhase = ticket.phase === "merge"
            ? "implementation"
            : ticket.phase as ActivePhase;
          const { model: resumeModel, thinking: resumeThinking } = deps
            .resolveModelConfig(resumePhase, ticket);
          await deps.spawn({
            phase: resumePhase,
            ticketDir: join(stateDir, ticket.id),
            prompt:
              `Your previous run was interrupted by a system restart. Continue from where you left off and write your output to ${outputFile}. Output nothing else.`,
            scope: ticket.scope,
            worktrees: resumePhase === "implementation" ? ticket.worktrees : {},
            outputFile,
            model: resumeModel,
            thinking: resumeThinking,
            sessionId,
            resume: true,
          });
          await deps.writeTicket(stateDir, {
            ...ticket,
            status: "running",
            outputRetries: undefined,
            updated: now,
          });
          await deps.appendLog(stateDir, ticket.id, {
            event: "phase-resumed",
            phase: ticket.phase,
          });
          return;
        }
        await deps.writeTicket(stateDir, {
          ...waitingTicket,
          status: "needs-attention",
          updated: now,
        });
        await deps.appendLog(stateDir, ticket.id, {
          event: "phase-output-invalid",
          phase: ticket.phase,
          reason: "incomplete",
        });
        return;
      }
      if (exitCode !== 0) {
        const staleSessionId =
          ticket.phase === "implementation" || ticket.phase === "merge"
            ? waitingTicket.phaseSessionIds?.["implementation"]
            : undefined;
        if (
          staleSessionId !== undefined &&
          (waitingTicket.resumeRetries ?? 0) < 1
        ) {
          const { implementation: _impl, ...restSessionIds } =
            waitingTicket.phaseSessionIds ?? {};
          await deps.writeTicket(stateDir, {
            ...waitingTicket,
            status: "revising",
            phaseSessionIds: restSessionIds,
            resumeRetries: 1,
            updated: now,
          });
          await deps.appendLog(stateDir, ticket.id, {
            event: "resume-retry",
            phase: ticket.phase,
            staleSessionId,
          });
          return;
        }
        await deps.writeTicket(stateDir, {
          ...waitingTicket,
          status: "needs-attention",
          updated: now,
        });
        await deps.appendLog(stateDir, ticket.id, {
          event: "phase-output-invalid",
          phase: ticket.phase,
          reason: "non-zero-exit",
        });
        return;
      }

      const outputContent = await deps.readPhaseOutput(
        join(stateDir, ticket.id),
        ticket.phase,
      );
      if (outputContent === null) {
        const retries = ticket.outputRetries ?? 0;
        if (retries < 1) {
          const sessionId = waitingTicket.phaseSessionIds?.[ticket.phase];
          if (sessionId) {
            const outputFile = `${
              compactTimestamp(zonedNow)
            }-${ticket.phase}.md`;
            const retryPhase: ActivePhase = ticket.phase === "merge"
              ? "implementation"
              : ticket.phase as ActivePhase;
            const { model: retryModel, thinking: retryThinking } = deps
              .resolveModelConfig(retryPhase, ticket);
            await deps.spawn({
              phase: retryPhase,
              ticketDir: join(stateDir, ticket.id),
              prompt:
                `You did not create the output file. Use the Write tool to write your previous response to ${outputFile} now. Output nothing else.`,
              scope: [],
              worktrees: retryPhase === "implementation"
                ? ticket.worktrees
                : {},
              outputFile,
              model: retryModel,
              thinking: retryThinking,
              sessionId,
              resume: true,
            });
            await deps.writeTicket(stateDir, {
              ...ticket,
              outputRetries: 1,
              status: "running",
              updated: now,
            });
            await deps.appendLog(stateDir, ticket.id, {
              event: "phase-output-retry",
              phase: ticket.phase,
              attempt: 1,
            });
            return;
          }
        }
        await deps.writeTicket(stateDir, {
          ...waitingTicket,
          status: "needs-attention",
          updated: now,
        });
        await deps.appendLog(stateDir, ticket.id, {
          event: "phase-output-invalid",
          phase: ticket.phase,
          reason: "missing",
        });
        return;
      }
      if (outputContent.trim() === "") {
        await deps.writeTicket(stateDir, {
          ...waitingTicket,
          status: "needs-attention",
          updated: now,
        });
        await deps.appendLog(stateDir, ticket.id, {
          event: "phase-output-invalid",
          phase: ticket.phase,
          reason: "empty",
        });
        return;
      }

      if (
        ticket.phase === "implementation" &&
        ticket.artifacts.includes("document") &&
        !(ticket.documents?.length)
      ) {
        await deps.writeTicket(stateDir, {
          ...waitingTicket,
          status: "needs-attention",
          updated: now,
        });
        await deps.appendLog(stateDir, ticket.id, {
          event: "needs-attention",
          reason: "no-pages",
        });
        return;
      }

      if (
        ticket.phase === "implementation" &&
        ticket.artifacts.includes("work") &&
        !(ticket.workItems?.length)
      ) {
        await deps.writeTicket(stateDir, {
          ...waitingTicket,
          status: "needs-attention",
          updated: now,
        });
        await deps.appendLog(stateDir, ticket.id, {
          event: "needs-attention",
          reason: "no-work-items",
        });
        return;
      }

      const principles = extractPrinciples(outputContent);
      if (principles) {
        await deps.appendPrinciples(
          stateDir,
          ticket.id,
          ticket.phase,
          outputContent,
        );
      }

      let feedbackPrecedesOutput = false;
      try {
        const outputPattern = new RegExp(
          `^\\d{8}T\\d{6}-${ticket.phase}\\.md$`,
        );
        const feedbackPattern = new RegExp(
          `^\\d{8}T\\d{6}-${ticket.phase}-feedback\\.md$`,
        );
        const relevantFiles: string[] = [];
        for await (const entry of readDir(join(stateDir, ticket.id))) {
          if (
            entry.isFile &&
            (outputPattern.test(entry.name) || feedbackPattern.test(entry.name))
          ) {
            relevantFiles.push(entry.name);
          }
        }
        relevantFiles.sort();
        const lastOutputIndex = relevantFiles.findLastIndex((name) =>
          outputPattern.test(name)
        );
        if (lastOutputIndex > 0) {
          feedbackPrecedesOutput = feedbackPattern.test(
            relevantFiles[lastOutputIndex - 1],
          );
        }
      } catch {
        // directory unreadable — proceed with normal self-review
      }
      const skipSelfReview = ticket.phase === "plan" &&
        (ticket.newRepos?.length ?? 0) > 0;
      if (!feedbackPrecedesOutput && !skipSelfReview) {
        let selfReviewResult: { approved: boolean; reason: string | null } = {
          approved: false,
          reason: null,
        };
        try {
          selfReviewResult = await deps.selfReview(
            ticket.phase,
            join(stateDir, ticket.id),
            ticket.worktrees["jackjennings/lazyboy"]?.path,
          );
        } catch {
          // treated as { approved: false, reason: null }
        }
        if (selfReviewResult.approved) {
          const agentEntry: ApprovalEntry = {
            timestamp: Temporal.Now.instant().toString(),
            actor: "agent",
            phase: ticket.phase,
          };
          await deps.writeTicket(stateDir, {
            ...waitingTicket,
            approvals: [...waitingTicket.approvals, agentEntry],
          });
          await deps.appendLog(stateDir, ticket.id, {
            event: "self-approved",
            phase: ticket.phase,
          });
        } else if (selfReviewResult.reason !== null) {
          const filename = `${
            compactTimestamp(zonedNow)
          }-${ticket.phase}-self-review.md`;
          await deps.writePhaseOutput(
            stateDir,
            ticket.id,
            filename,
            selfReviewResult.reason,
          );
        }
      }
      if (ticket.phase === "implementation") {
        const wt = ticket.worktrees["jackjennings/lazyboy"];
        if (wt) {
          deps.spawnOutlierAnalysis(
            ticket.id,
            join(stateDir, ticket.id),
            wt.path,
            "implementation",
          ).catch(() => {});
        } else {
          await deps.appendLog(stateDir, ticket.id, {
            event: "error",
            context: "spawnOutlierAnalysis",
            message: "no jackjennings/lazyboy worktree",
          });
        }
      }
      if (ticket.phase === "plan") {
        const wt = ticket.worktrees["jackjennings/lazyboy"];
        if (wt) {
          deps.spawnOutlierAnalysis(
            ticket.id,
            join(stateDir, ticket.id),
            wt.path,
            "plan",
          ).catch(() => {});
        } else {
          await deps.appendLog(stateDir, ticket.id, {
            event: "error",
            context: "spawnOutlierAnalysis",
            message: "no jackjennings/lazyboy worktree",
          });
        }
      }
    }
    return;
  }

  if (
    ticket.phase === "implementation" &&
    ticket.status === "waiting" &&
    isApproved(ticket)
  ) {
    if (requiresPRs) {
      const unmergedUrls = (ticket.prs ?? [])
        .filter((pr) => !pr.merged)
        .map((pr) => pr.url);
      if (unmergedUrls.length > 0) {
        try {
          await deps.markPRsReady(unmergedUrls);
        } catch (e) {
          await deps.appendLog(stateDir, ticket.id, {
            event: "error",
            context: "markPRsReady",
            message: String(e),
          });
        }
      }
    }
    await deps.writeTicket(stateDir, {
      ...ticket,
      phase: "merge",
      status: mergeStatus,
      updated: now,
      resumeRetries: undefined,
    });
    await deps.appendLog(stateDir, ticket.id, {
      event: "phase-transition",
      from: ticket.phase,
      to: "merge",
    });
    return;
  }

  const pipelineSteps = ticket.pipelineSteps ?? DEFAULT_PIPELINE_STEPS;
  const activePhases = pipelineSteps
    .map((s) => s.phase)
    .filter((p) => p !== "implementation");
  if (
    ticket.status === "waiting" &&
    isApproved(ticket) &&
    (activePhases as string[]).includes(ticket.phase)
  ) {
    const activePhase = ticket.phase as ActivePhase;
    const next = nextPipelinePhase(pipelineSteps, activePhase);
    if (next === "done") return;
    const effectiveNext: ActivePhase = activePhase === "spec" &&
        ticket.phases?.plan?.skip === true &&
        next === "plan"
      ? nextPipelinePhase(pipelineSteps, "plan") as ActivePhase
      : next;
    if (
      effectiveNext === "implementation" &&
      requiresWorktrees &&
      Object.keys(ticket.worktrees).length === 0
    ) {
      await deps.writeTicket(stateDir, {
        ...ticket,
        phase: "implementation",
        status: "needs-attention",
        updated: now,
      });
      await deps.appendLog(stateDir, ticket.id, {
        event: "phase-transition",
        from: ticket.phase,
        to: "needs-attention",
        reason: "no-worktrees",
      });
      return;
    }
    const basePrompt = await loadPrompt(effectiveNext);
    const supplement = await loadProviderPrompt(effectiveNext, ticket.provider);
    const artifactSupplement = await loadArtifactPrompt(
      effectiveNext,
      ticket.artifacts,
    );
    const statePrompt = await loadStatePrompt(
      effectiveNext,
      stateDir,
      ticket.provider,
      ticket.id,
    );
    const prompt = [basePrompt, supplement, artifactSupplement, statePrompt]
      .filter((part) => part.length > 0)
      .join("\n\n");
    const threshold = deps.maxPromptTokens ?? DEFAULT_MAX_PROMPT_TOKENS;
    const tokens = estimateTokenCount(prompt);
    if (tokens > threshold) {
      await deps.appendLog(stateDir, ticket.id, {
        event: "prompt-too-long",
        phase: next,
        tokens,
        maxTokens: threshold,
      });
    }
    let resolvedTicket = ticket;
    if (next === "implementation") {
      try {
        const override = await deps.adjudicatePhaseModel(prompt);
        if (override !== null) {
          resolvedTicket = {
            ...ticket,
            phases: { ...ticket.phases, implementation: override },
          };
          await deps.writeTicket(stateDir, resolvedTicket);
        }
      } catch {
        // silently skip — resolveModelConfig proceeds with original ticket state
      }
    }
    const { model: nextModel, thinking: nextThinking } = deps
      .resolveModelConfig(effectiveNext, resolvedTicket);
    const nextUuid = crypto.randomUUID();
    await deps.writeTicket(stateDir, {
      ...resolvedTicket,
      phase: effectiveNext,
      status: "running",
      updated: now,
      phaseSessionIds: {
        ...ticket.phaseSessionIds,
        [effectiveNext]: nextUuid,
      },
    });
    await deps.spawn({
      phase: effectiveNext,
      ticketDir: join(stateDir, ticket.id),
      prompt,
      scope: ticket.scope,
      worktrees: effectiveNext === "implementation" ? ticket.worktrees : {},
      outputFile: `${compactTimestamp(zonedNow)}-${effectiveNext}.md`,
      model: nextModel,
      thinking: nextThinking,
      sessionId: nextUuid,
    });
    await deps.appendLog(stateDir, ticket.id, {
      event: "phase-transition",
      from: ticket.phase,
      to: effectiveNext,
    });
    return;
  }

  if (
    ticket.status === "waiting" &&
    isApproved(ticket) &&
    ticket.phase !== "implementation" &&
    !(activePhases as string[]).includes(ticket.phase)
  ) {
    await deps.writeTicket(stateDir, {
      ...ticket,
      status: "needs-attention",
      updated: now,
    });
    await deps.appendLog(stateDir, ticket.id, {
      event: "needs-attention",
      reason: "phase-not-in-pipeline",
    });
    return;
  }
}
