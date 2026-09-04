import matter from "gray-matter";
import { join } from "@std/path";
import { urrasDir } from "../paths.ts";
import {
  type ApprovalEntry,
  type ArtifactType,
  assertValidPhaseStatus,
  type LearningState,
  type LearningStatus,
  type PrEntry,
  type TicketPhase,
  type TicketState,
  type TicketStatus,
  type WorktreeInfo,
} from "./types.ts";
import {
  mkdir,
  readDir,
  readTextFile,
  remove,
  stat,
  writeTextFile,
} from "../filesystem.ts";

export class StaleTicketWriteError extends Error {}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

function migratePhase(oldPhase: string): [TicketPhase, TicketStatus] {
  const table: Record<string, [TicketPhase, TicketStatus]> = {
    "new": ["intake", "new"],
    "running-intake": ["intake", "running"],
    "waiting-intake": ["intake", "waiting"],
    "running-enrichment": ["enrichment", "running"],
    "waiting-enrichment": ["enrichment", "waiting"],
    "running-spec": ["spec", "running"],
    "waiting-spec": ["spec", "waiting"],
    "running-plan": ["plan", "running"],
    "waiting-plan": ["plan", "waiting"],
    "running-implementation": ["implementation", "running"],
    "waiting-diff": ["implementation", "waiting"],
    "waiting-merge": ["merge", "waiting"],
    "needs-attention": ["intake", "needs-attention"],
    "done": ["merge", "done"],
  };
  const result = table[oldPhase];
  if (!result) throw new Error(`Unknown legacy phase: ${oldPhase}`);
  return result;
}

// YAML parses an unquoted ISO timestamp into a Date; comparisons against
// comment timestamps are string-based, so normalize back to ISO.
function normalizeTimestamp(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw instanceof Date) return raw.toISOString();
  return String(raw);
}

function normalizePrEntry(raw: unknown): PrEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.url !== "string" || !r.url) return null;
  const entry: PrEntry = {
    url: r.url,
    title: typeof r.title === "string" ? r.title : "",
    dependsOn: Array.isArray(r.dependsOn) ? (r.dependsOn as string[]) : [],
    merged: typeof r.merged === "boolean" ? r.merged : false,
  };
  if (typeof r.worktreeKey === "string") entry.worktreeKey = r.worktreeKey;
  if (typeof r.closed === "boolean") entry.closed = r.closed;
  return entry;
}

const NOT_FRONTMATTER = Symbol("NOT_FRONTMATTER");

type FieldCodec<K extends keyof TicketState> = {
  write(t: TicketState): unknown;
  read(d: Record<string, unknown>): TicketState[K];
};

type Field<K extends keyof TicketState> =
  | FieldCodec<K>
  | typeof NOT_FRONTMATTER;

const FIELDS: { [K in keyof TicketState]-?: Field<K> } = {
  id: {
    write: (t) => t.id,
    read: (d) => d.id as string,
  },
  provider: {
    write: (t) => t.provider,
    read: (d) => d.provider as string,
  },
  title: {
    write: (t) => t.title,
    read: (d) => d.title as string,
  },
  shortTitle: {
    write: (t) => t.shortTitle,
    read: (d) => d.shortTitle as string | undefined,
  },
  url: {
    write: (t) => t.url,
    read: (d) => d.url as string,
  },
  phase: {
    write: (t) => t.phase,
    read: (d) => d.phase as TicketPhase,
  },
  status: {
    write: (t) => t.status,
    read: (d) => d.status as TicketStatus,
  },
  approvals: {
    write: (t) => t.approvals,
    read: (d) => (d.approvals as ApprovalEntry[] | undefined) ?? [],
  },
  scope: {
    write: (t) => t.scope,
    read: (d) => (d.scope as string[] | undefined) ?? [],
  },
  worktrees: {
    write: (t) => t.worktrees,
    read: (d) => {
      const raw = d.worktrees as
        | Record<string, { path: string; branch: string }>
        | undefined;
      const worktrees: Record<string, WorktreeInfo> = {};
      if (raw) {
        for (const [slug, info] of Object.entries(raw)) {
          worktrees[slug] = { path: info.path, branch: info.branch };
        }
      }
      return worktrees;
    },
  },
  prs: {
    write: (t) => t.prs,
    read: (d) => {
      const rawPrs = d.prs;
      if (!Array.isArray(rawPrs)) return undefined;
      return (rawPrs as unknown[]).flatMap((entry) => {
        const normalized = normalizePrEntry(entry);
        if (!normalized) {
          console.error("readTicket: dropping prs entry without url");
          return [];
        }
        return [normalized];
      });
    },
  },
  newRepos: {
    write: (t) => t.newRepos,
    read: (d) => d.newRepos as string[] | undefined,
  },
  ciHandledRunIds: {
    write: (t) => t.ciHandledRunIds,
    read: (d) => d.ciHandledRunIds as string[] | undefined,
  },
  lastSeenCommentTimestamp: {
    write: (t) => t.lastSeenCommentTimestamp,
    read: (d) => normalizeTimestamp(d.lastSeenCommentTimestamp),
  },
  lastSeenPrCommentTimestamp: {
    write: (t) => t.lastSeenPrCommentTimestamp,
    read: (d) => normalizeTimestamp(d.lastSeenPrCommentTimestamp),
  },
  providerDone: {
    write: (t) => t.providerDone,
    read: (d) => d.providerDone as boolean | undefined,
  },
  providerPickedUp: {
    write: (t) => t.providerPickedUp,
    read: (d) => d.providerPickedUp as boolean | undefined,
  },
  outputRetries: {
    write: (t) => t.outputRetries,
    read: (d) => d.outputRetries as number | undefined,
  },
  resumeRetries: {
    write: (t) => t.resumeRetries,
    read: (d) => d.resumeRetries as number | undefined,
  },
  phaseSessionIds: {
    write: (t) => {
      if (t.phaseSessionIds === undefined) return undefined;
      const defined = Object.fromEntries(
        Object.entries(t.phaseSessionIds).filter(
          ([, sessionId]) => sessionId !== undefined,
        ),
      );
      return Object.keys(defined).length > 0 ? defined : undefined;
    },
    read: (d) => d.phaseSessionIds as TicketState["phaseSessionIds"],
  },
  notifiedNeedsAttention: {
    write: (t) => t.notifiedNeedsAttention,
    read: (d) => d.notifiedNeedsAttention as boolean | undefined,
  },
  created: {
    write: (t) => t.created,
    read: (d) => d.created as string,
  },
  updated: {
    write: (t) => t.updated,
    read: (d) => d.updated as string,
  },
  body: NOT_FRONTMATTER,
  revision: NOT_FRONTMATTER,
  phases: {
    write: (t) => t.phases,
    read: (d) => d.phases as TicketState["phases"],
  },
  artifacts: {
    write: (t) => t.artifacts,
    read: (d) => (d.artifacts as ArtifactType[] | undefined) ?? ["code"],
  },
  documents: {
    write: (t) => t.documents,
    read: (d) => d.documents as { url: string; title: string }[] | undefined,
  },
  workItems: {
    write: (t) => t.workItems,
    read: (d) => d.workItems as { url: string; title: string }[] | undefined,
  },
};

export async function readTicket(
  stateDir: string,
  id: string,
): Promise<TicketState> {
  const metaPath = join(stateDir, id, "meta.md");
  const raw = await readTextFile(metaPath);
  const revision = await sha256Hex(raw);
  const { data, content } = matter(raw);

  let phase: TicketPhase;
  let status: TicketStatus;
  const needsMigration = data.status === undefined;

  if (needsMigration) {
    [phase, status] = migratePhase(data.phase as string);
  } else {
    phase = data.phase as TicketPhase;
    status = data.status as TicketStatus;
  }

  try {
    assertValidPhaseStatus(phase, status);
  } catch (error) {
    throw new Error(
      `${metaPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  data.phase = phase;
  data.status = status;

  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(FIELDS)) {
    if (field === NOT_FRONTMATTER) continue;
    const f = field as FieldCodec<keyof TicketState>;
    result[key] = f.read(data);
  }
  result.body = content.trim();
  result.revision = revision;
  const ticket = result as unknown as TicketState;

  if (needsMigration) {
    await writeTicket(stateDir, ticket);
    const migratedRaw = await readTextFile(metaPath);
    ticket.revision = await sha256Hex(migratedRaw);
  }

  return ticket;
}

export async function writeTicket(
  stateDir: string,
  ticket: TicketState,
): Promise<void> {
  assertValidPhaseStatus(ticket.phase, ticket.status);
  const dir = join(stateDir, ticket.id);
  await mkdir(dir, { recursive: true });

  const metaPath = join(dir, "meta.md");
  let fileExists = false;
  try {
    await stat(metaPath);
    fileExists = true;
  } catch {
    // not found — new-ticket path
  }
  if (fileExists) {
    if (ticket.revision === undefined) {
      throw new StaleTicketWriteError(
        `writeTicket: ${ticket.id} has no revision token`,
      );
    }
    const onDisk = await readTextFile(metaPath);
    if (await sha256Hex(onDisk) !== ticket.revision) {
      throw new StaleTicketWriteError(
        `writeTicket: ${ticket.id} revision is stale`,
      );
    }
  }

  const frontmatter: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(FIELDS)) {
    if (field === NOT_FRONTMATTER) continue;
    const f = field as FieldCodec<keyof TicketState>;
    const value = f.write(ticket);
    if (value !== undefined) {
      frontmatter[key] = value;
    }
  }
  const raw = matter.stringify(ticket.body, frontmatter);
  await writeTextFile(join(dir, "meta.md"), raw);
}

export async function readTicketWithPatch(
  stateDir: string,
  id: string,
): Promise<{
  ticket: TicketState;
  patchTicket: (attrs: Partial<TicketState>) => Promise<void>;
}> {
  const ticket = await readTicket(stateDir, id);
  return {
    ticket,
    patchTicket: async (attrs) => {
      const fresh = await readTicket(stateDir, id);
      await writeTicket(stateDir, { ...fresh, ...attrs });
    },
  };
}

export async function writePhaseOutput(
  stateDir: string,
  id: string,
  filename: string,
  content: string,
): Promise<void> {
  await writeTextFile(join(stateDir, id, filename), content);
}

export function readPhaseOutput(
  stateDir: string,
  id: string,
  filename: string,
): Promise<string> {
  return readTextFile(join(stateDir, id, filename));
}

async function walkStateDir(
  dir: string,
  relPath: string,
  depth: number,
  ids: string[],
): Promise<void> {
  if (depth > 4) return;
  for await (const entry of readDir(dir)) {
    if (!entry.isDirectory || entry.name.startsWith(".")) continue;
    const entryDir = join(dir, entry.name);
    const entryRel = relPath ? `${relPath}/${entry.name}` : entry.name;
    let hasMeta = false;
    try {
      await stat(join(entryDir, "meta.md"));
      hasMeta = true;
      // deno-lint-ignore no-empty
    } catch {}
    if (hasMeta) {
      ids.push(entryRel);
    } else {
      await walkStateDir(entryDir, entryRel, depth + 1, ids);
    }
  }
}

export async function listTickets(stateDir: string): Promise<string[]> {
  const ids: string[] = [];
  try {
    await walkStateDir(stateDir, "", 1, ids);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return ids;
}

export async function appendTicketLog(
  stateDir: string,
  id: string,
  entry: object,
): Promise<void> {
  const ts = Temporal.Now.instant().toString();
  await writeTextFile(
    join(stateDir, id, "log.ndjson"),
    JSON.stringify({ ts, ...entry }) + "\n",
    { append: true },
  );
  const lazyDir = urrasDir();
  await mkdir(lazyDir, { recursive: true });
  try {
    await writeTextFile(
      join(lazyDir, "log.ndjson"),
      JSON.stringify({ ts, id, ...entry }) + "\n",
      { append: true },
    );
  } catch {
    // combined log failure must not interrupt per-ticket log writes
  }
}

async function stateCommit(
  stateDir: string,
  addArgs: string[],
  message: string,
): Promise<void> {
  const run = (cmd: string[]) =>
    new Deno.Command(cmd[0], { args: cmd.slice(1), cwd: stateDir }).output();
  const commitCmd = [
    "git",
    "-c",
    "user.name=urras",
    "-c",
    "user.email=urras@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message,
  ];
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
    await run(["git", "add", ...addArgs]);
    const result = await run(commitCmd);
    if (result.code === 0) return;
    const stderr = new TextDecoder().decode(result.stderr);
    const stdout = new TextDecoder().decode(result.stdout);
    if (
      stderr.includes("nothing to commit") ||
      stdout.includes("nothing to commit")
    ) {
      return;
    }
    if (!stderr.includes("index.lock") || attempt === 2) {
      throw new Error(`git commit failed: ${stderr}`);
    }
  }
}

export async function commitState(
  stateDir: string,
  message: string,
): Promise<void> {
  await stateCommit(stateDir, ["-A"], message);
}

export async function commitTicket(
  stateDir: string,
  ticketId: string,
  message: string,
): Promise<void> {
  await stateCommit(stateDir, ["--", ticketId], message);
}

export async function commitPrinciples(
  stateDir: string,
  message: string,
  relPath = "principles.md",
): Promise<void> {
  await stateCommit(stateDir, ["--", relPath], message);
}

export async function writeLearning(
  stateDir: string,
  learning: LearningState,
  intent: string,
): Promise<void> {
  const learningsDir = join(stateDir, "learnings");
  await mkdir(learningsDir, { recursive: true });
  const raw = matter.stringify(`${intent.trim()}\n`, {
    id: learning.id,
    ticketId: learning.ticketId,
    repo: learning.repo,
    targetFile: learning.targetFile,
    prTitle: learning.prTitle,
    prBody: learning.prBody,
    status: learning.status,
    prs: learning.prs,
  });
  await writeTextFile(join(learningsDir, `${learning.id}.md`), raw);
}

export async function listLearnings(
  stateDir: string,
): Promise<Array<{ learning: LearningState; intent: string }>> {
  const learningsDir = join(stateDir, "learnings");
  const entries: Array<{ learning: LearningState; intent: string }> = [];
  try {
    for await (const file of readDir(learningsDir)) {
      if (!file.isFile || !file.name.endsWith(".md")) continue;
      try {
        const raw = await readTextFile(join(learningsDir, file.name));
        const { data, content } = matter(raw);
        if (typeof data.id !== "string") {
          console.error(`listLearnings: skipping file without id ${file.name}`);
          continue;
        }
        entries.push({
          learning: {
            id: data.id,
            ticketId: data.ticketId as string,
            repo: data.repo as string,
            targetFile: data.targetFile as string,
            prTitle: data.prTitle as string,
            prBody: data.prBody as string,
            status: (data.status as LearningStatus) ?? "pending",
            prs: Array.isArray(data.prs)
              ? (data.prs as unknown[]).flatMap((entry) => {
                const normalized = normalizePrEntry(entry);
                if (!normalized) {
                  console.error(
                    `listLearnings: dropping prs entry without url in ${file.name}`,
                  );
                  return [];
                }
                return [normalized];
              })
              : [],
          },
          intent: content.trim(),
        });
      } catch {
        console.error(`listLearnings: skipping unparseable file ${file.name}`);
      }
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return entries;
}

export async function removeLearning(
  stateDir: string,
  id: string,
): Promise<void> {
  try {
    await remove(join(stateDir, "learnings", `${id}.md`));
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}
