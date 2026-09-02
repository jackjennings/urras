import type { LearningState, LearningStatus, PrEntry } from "./state/types.ts";

export type PRState = "merged" | "closed" | "open";

export interface LearningDeps {
  listLearnings(): Promise<Array<{ learning: LearningState; intent: string }>>;
  writeLearning(learning: LearningState, intent: string): Promise<void>;
  prState(url: string): Promise<PRState>;
  applyToRepo(
    learning: LearningState,
    intent: string,
  ): Promise<{ url: string; title: string }>;
  log?(entry: object): Promise<void>;
}

export function resolveLearningStatus(prs: PrEntry[]): LearningStatus {
  if (prs.length === 0) return "waiting";
  if (prs.every((pr) => pr.merged)) return "done";
  if (prs.every((pr) => pr.merged || pr.closed)) return "wont-do";
  return "waiting";
}

export async function processLearnings(deps: LearningDeps): Promise<void> {
  const entries = await deps.listLearnings();

  for (const entry of entries) {
    if (entry.learning.status !== "waiting") continue;
    const prs = entry.learning.prs.map((pr) => ({ ...pr }));
    const mergedUrls = new Set(
      prs.filter((pr) => pr.merged).map((pr) => pr.url),
    );
    let dirty = false;
    for (const pr of prs) {
      if (pr.merged || pr.closed) continue;
      if (pr.dependsOn.some((dep) => !mergedUrls.has(dep))) continue;
      let state: PRState;
      try {
        state = await deps.prState(pr.url);
      } catch {
        await deps.log?.({
          event: "learning-processing-failed",
          id: entry.learning.id,
          reason: "pr-state-check-failed",
        });
        continue;
      }
      if (state === "merged") {
        pr.merged = true;
        mergedUrls.add(pr.url);
        dirty = true;
      } else if (state === "closed") {
        pr.closed = true;
        dirty = true;
      }
    }
    const status = resolveLearningStatus(prs);
    if (dirty || status !== entry.learning.status) {
      entry.learning = { ...entry.learning, prs, status };
      await deps.writeLearning(entry.learning, entry.intent);
    }
  }

  const inFlight = new Set(
    entries
      .filter((e) => e.learning.status === "waiting")
      .map((e) => e.learning.targetFile),
  );
  for (const entry of entries) {
    if (entry.learning.status !== "pending") continue;
    if (inFlight.has(entry.learning.targetFile)) continue;
    inFlight.add(entry.learning.targetFile);
    try {
      const { url, title } = await deps.applyToRepo(
        entry.learning,
        entry.intent,
      );
      const pr: PrEntry = {
        url,
        title,
        dependsOn: [],
        merged: false,
      };
      await deps.writeLearning(
        {
          ...entry.learning,
          prs: [...entry.learning.prs, pr],
          status: "waiting",
        },
        entry.intent,
      );
    } catch (e) {
      await deps.log?.({
        event: "learning-processing-failed",
        id: entry.learning.id,
        reason: e instanceof Error ? e.message : "unknown",
      });
      await deps.writeLearning(
        { ...entry.learning, status: "needs-attention" },
        entry.intent,
      );
    }
  }
}
