export interface CandidateEntry {
  id: string;
  prioritized: boolean;
}

export interface LastWorked {
  prioritized: string[];
  normal: string[];
}

function roundRobin(
  ids: string[],
  lastWorked: string[],
  count: number,
): string[] {
  if (ids.length === 0) return [];
  let start = 0;
  for (let i = lastWorked.length - 1; i >= 0; i--) {
    const idx = ids.indexOf(lastWorked[i]);
    if (idx !== -1) {
      start = (idx + 1) % ids.length;
      break;
    }
  }
  const take = Math.min(count, ids.length);
  const result: string[] = [];
  for (let i = 0; i < take; i++) {
    result.push(ids[(start + i) % ids.length]);
  }
  return result;
}

export function selectCandidates(
  candidates: CandidateEntry[],
  lastWorked: LastWorked,
  concurrency: number,
): string[] {
  if (candidates.length === 0) return [];

  const prioritizedIds = candidates.filter((c) => c.prioritized).map((c) =>
    c.id
  );
  const normalIds = candidates.filter((c) => !c.prioritized).map((c) => c.id);

  const prioritizedSelected = roundRobin(
    prioritizedIds,
    lastWorked.prioritized,
    concurrency,
  );
  const remaining = concurrency - prioritizedSelected.length;
  const normalSelected = roundRobin(normalIds, lastWorked.normal, remaining);

  return [...prioritizedSelected, ...normalSelected];
}

export interface CandidateSelectorDeps {
  readLastWorked: () => Promise<LastWorked>;
  writeLastWorked: (worked: LastWorked) => Promise<void>;
}

export type CandidateSelector = (
  candidates: CandidateEntry[],
  concurrency: number,
) => Promise<string[]>;

export function makeCandidateSelector(
  deps: CandidateSelectorDeps,
): CandidateSelector {
  return async (candidates, concurrency) => {
    const lastWorked = await deps.readLastWorked();
    const selected = selectCandidates(candidates, lastWorked, concurrency);
    const selectedSet = new Set(selected);
    const worked: LastWorked = {
      prioritized: candidates
        .filter((c) => c.prioritized && selectedSet.has(c.id))
        .map((c) => c.id),
      normal: candidates
        .filter((c) => !c.prioritized && selectedSet.has(c.id))
        .map((c) => c.id),
    };
    await deps.writeLastWorked(worked);
    return selected;
  };
}
