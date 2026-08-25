export function selectCandidates(
  candidates: string[],
  lastWorked: string[],
  concurrency: number,
): string[] {
  if (candidates.length === 0) return [];

  let start = 0;
  for (let i = lastWorked.length - 1; i >= 0; i--) {
    const idx = candidates.indexOf(lastWorked[i]);
    if (idx !== -1) {
      start = (idx + 1) % candidates.length;
      break;
    }
  }

  const count = Math.min(concurrency, candidates.length);
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    result.push(candidates[(start + i) % candidates.length]);
  }
  return result;
}

export interface CandidateSelectorDeps {
  readLastWorked: () => Promise<string[]>;
  writeLastWorked: (ids: string[]) => Promise<void>;
}

export type CandidateSelector = (
  candidates: string[],
  concurrency: number,
) => Promise<string[]>;

export function makeCandidateSelector(
  deps: CandidateSelectorDeps,
): CandidateSelector {
  return async (candidates, concurrency) => {
    const lastWorked = await deps.readLastWorked();
    const selected = selectCandidates(candidates, lastWorked, concurrency);
    await deps.writeLastWorked(selected);
    return selected;
  };
}
