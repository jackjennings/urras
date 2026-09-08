export interface WorkItem {
  id: string;
  provider: string;
  title: string;
  description: string;
  url: string;
}

export interface Provider {
  fetchNew(knownIds: Set<string>): Promise<WorkItem[]>;
  close(url: string): Promise<void>;
  pickup(url: string): Promise<void>;
}

export function compareSortKeys(
  a: Array<string | number>,
  b: Array<string | number>,
): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i];
    const bv = b[i];
    if (typeof av === "number" && typeof bv === "number") {
      if (av !== bv) return av - bv;
    } else if (typeof av === "string" && typeof bv === "string") {
      if (av < bv) return -1;
      if (av > bv) return 1;
    } else {
      return typeof av === "string" ? -1 : 1;
    }
  }
  return a.length - b.length;
}
