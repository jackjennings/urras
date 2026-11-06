import { join } from "@std/path";
import {
  exists,
  mkdir,
  readTextFile,
  remove,
  rename,
  writeTextFile,
} from "./filesystem.ts";

export type BreakerStatus =
  | { state: "closed" }
  | {
    state: "open";
    openedAt: string;
    retryAt: string;
    trips: number;
    reason: string;
  }
  | { state: "half-open"; retryAt: string; trips: number; reason: string };

export interface CircuitBreaker {
  readonly name: string;
  status(now: Temporal.Instant): Promise<BreakerStatus>;
  trip(opts: { retryAt: string | null; reason: string }): Promise<void>;
  succeed(): Promise<void>;
  reset(): Promise<void>;
}

interface BreakerRecord {
  openedAt: string;
  retryAt: string;
  trips: number;
  reason: string;
}

export interface JsonFileBreakerDeps {
  defaultPauseMinutes: number;
  appendTickLog: (entry: object) => Promise<void>;
}

export class JsonFileBreaker implements CircuitBreaker {
  readonly name: string;
  readonly #dir: string;
  readonly #deps: JsonFileBreakerDeps;

  constructor(name: string, breakersDir: string, deps: JsonFileBreakerDeps) {
    this.name = name;
    this.#dir = breakersDir;
    this.#deps = deps;
  }

  get #path(): string {
    return join(this.#dir, `${this.name}.json`);
  }

  async #readRecord(): Promise<BreakerRecord | null | "corrupt"> {
    let raw: string;
    try {
      raw = await readTextFile(this.#path);
    } catch {
      return null;
    }
    try {
      return JSON.parse(raw) as BreakerRecord;
    } catch {
      return "corrupt";
    }
  }

  async status(now: Temporal.Instant): Promise<BreakerStatus> {
    const record = await this.#readRecord();
    if (record === null) return { state: "closed" };
    if (record === "corrupt") {
      await this.#deps.appendTickLog({ event: "usage-limit-state-unreadable" });
      const retryAt = now.add({ minutes: this.#deps.defaultPauseMinutes })
        .toString();
      return {
        state: "open",
        openedAt: "<unknown>",
        retryAt,
        trips: 1,
        reason: "unreadable",
      };
    }
    if (
      Temporal.Instant.compare(now, Temporal.Instant.from(record.retryAt)) >= 0
    ) {
      return {
        state: "half-open",
        retryAt: record.retryAt,
        trips: record.trips,
        reason: record.reason,
      };
    }
    return {
      state: "open",
      openedAt: record.openedAt,
      retryAt: record.retryAt,
      trips: record.trips,
      reason: record.reason,
    };
  }

  async trip(opts: { retryAt: string | null; reason: string }): Promise<void> {
    const existing = await this.#readRecord();
    const now = Temporal.Now.instant();
    let trips = 1;
    let openedAt = now.toString();
    if (existing !== null && existing !== "corrupt") {
      if (
        Temporal.Instant.compare(now, Temporal.Instant.from(existing.retryAt)) <
          0
      ) {
        return;
      }
      trips = existing.trips + 1;
      openedAt = existing.openedAt;
    }
    const retryAt = opts.retryAt ??
      now.add({
        minutes: Math.min(
          this.#deps.defaultPauseMinutes * Math.pow(2, trips - 1),
          24 * 60,
        ),
      }).toString();
    const record: BreakerRecord = {
      openedAt,
      retryAt,
      trips,
      reason: opts.reason,
    };
    await this.#writeRecord(record);
  }

  async succeed(): Promise<void> {
    await this.reset();
  }

  async reset(): Promise<void> {
    try {
      await remove(this.#path);
    } catch {
      // already absent
    }
  }

  async #writeRecord(record: BreakerRecord): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const tmp = this.#path + ".tmp";
    await writeTextFile(tmp, JSON.stringify(record));
    await rename(tmp, this.#path);
  }
}

export class NoOpBreaker implements CircuitBreaker {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  status(_now: Temporal.Instant): Promise<BreakerStatus> {
    return Promise.resolve({ state: "closed" });
  }
  trip(_opts: { retryAt: string | null; reason: string }): Promise<void> {
    return Promise.resolve();
  }
  succeed(): Promise<void> {
    return Promise.resolve();
  }
  reset(): Promise<void> {
    return Promise.resolve();
  }
}

export function breakerFilePath(breakersDir: string, name: string): string {
  return join(breakersDir, `${name}.json`);
}

export async function readBreakerStatus(
  breakersDir: string,
  name: string,
): Promise<BreakerStatus> {
  const path = breakerFilePath(breakersDir, name);
  try {
    if (!(await exists(path))) return { state: "closed" };
  } catch {
    return { state: "closed" };
  }
  try {
    const content = await readTextFile(path);
    const record = JSON.parse(content) as BreakerRecord;
    const now = Temporal.Now.instant();
    if (
      Temporal.Instant.compare(now, Temporal.Instant.from(record.retryAt)) >= 0
    ) {
      return {
        state: "half-open",
        retryAt: record.retryAt,
        trips: record.trips,
        reason: record.reason,
      };
    }
    return {
      state: "open",
      openedAt: record.openedAt,
      retryAt: record.retryAt,
      trips: record.trips,
      reason: record.reason,
    };
  } catch {
    return { state: "closed" };
  }
}
