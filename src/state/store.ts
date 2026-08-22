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

  const worktreesRaw = data.worktrees as
    | Record<string, { path: string; branch: string }>
    | undefined;
  const worktrees: Record<string, WorktreeInfo> = {};
  if (worktreesRaw) {
    for (const [slug, info] of Object.entries(worktreesRaw)) {
      worktrees[slug] = { path: info.path, branch: info.branch };
    }
  }

  const rawPrs = data.prs;
  const prs: PrEntry[] | undefined = Array.isArray(rawPrs)
    ? (rawPrs as unknown[]).flatMap((entry) => {
      const normalized = normalizePrEntry(entry);
      if (!normalized) {
        console.error(`readTicket: dropping prs entry without url in ${id}`);
        return [];
      }
      return [normalized];
    })
    : undefined;

  const ticket: TicketState = {
    id: data.id,
    provider: data.provider,
    title: data.title,
    shortTitle: data.shortTitle as string | undefined,
    url: data.url,
    phase,
    status,
    approvals: (data.approvals as ApprovalEntry[] | undefined) ?? [],
    scope: data.scope ?? [],
    worktrees,
    prs,
    newRepos: data.newRepos as string[] | undefined,
    created: data.created,
    updated: data.updated,
    body: content.trim(),
    phases: data.phases as TicketState["phases"],
    outputRetries: data.outputRetries as number | undefined,
    resumeRetries: data.resumeRetries as number | undefined,
    artifacts: (data.artifacts as ArtifactType[] | undefined) ?? ["code"],
    documents: data.documents as { url: string; title: string }[] | undefined,
    workItems: data.workItems as { url: string; title: string }[] | undefined,
    lastSeenCommentTimestamp: normalizeTimestamp(
      data.lastSeenCommentTimestamp,
    ),
    providerDone: data.providerDone as boolean | undefined,
    providerPickedUp: data.providerPickedUp as boolean | undefined,
    ciHandledRunIds: data.ciHandledRunIds as string[] | undefined,
    phaseSessionIds: data.phaseSessionIds as TicketState["phaseSessionIds"],
    notifiedNeedsAttention: data.notifiedNeedsAttention as boolean | undefined,
    revision,
  };

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

  const frontmatter: Record<string, unknown> = {
    id: ticket.id,
    provider: ticket.provider,
    title: ticket.title,
    url: ticket.url,
    phase: ticket.phase,
    status: ticket.status,
    approvals: ticket.approvals,
    scope: ticket.scope,
    worktrees: ticket.worktrees,
    created: ticket.created,
    updated: ticket.updated,
  };
  if (ticket.prs !== undefined) frontmatter.prs = ticket.prs;
  if (ticket.newRepos !== undefined) frontmatter.newRepos = ticket.newRepos;
  if (ticket.outputRetries !== undefined) {
    frontmatter.outputRetries = ticket.outputRetries;
  }
  if (ticket.resumeRetries !== undefined) {
    frontmatter.resumeRetries = ticket.resumeRetries;
  }
  if (ticket.shortTitle !== undefined) {
    frontmatter.shortTitle = ticket.shortTitle;
  }
  if (ticket.phases !== undefined) frontmatter.phases = ticket.phases;
  frontmatter.artifacts = ticket.artifacts;
  if (ticket.documents !== undefined) {
    frontmatter.documents = ticket.documents;
  }
  if (ticket.workItems !== undefined) {
    frontmatter.workItems = ticket.workItems;
  }
  if (ticket.lastSeenCommentTimestamp !== undefined) {
    frontmatter.lastSeenCommentTimestamp = ticket.lastSeenCommentTimestamp;
  }
  if (ticket.providerDone !== undefined) {
    frontmatter.providerDone = ticket.providerDone;
  }
  if (ticket.providerPickedUp !== undefined) {
    frontmatter.providerPickedUp = ticket.providerPickedUp;
  }
  if (ticket.ciHandledRunIds !== undefined) {
    frontmatter.ciHandledRunIds = ticket.ciHandledRunIds;
  }
  if (ticket.phaseSessionIds !== undefined) {
    const definedSessionIds = Object.fromEntries(
      Object.entries(ticket.phaseSessionIds).filter(
        ([, sessionId]) => sessionId !== undefined,
      ),
    );
    if (Object.keys(definedSessionIds).length > 0) {
      frontmatter.phaseSessionIds = definedSessionIds;
    }
  }
  if (ticket.notifiedNeedsAttention !== undefined) {
    frontmatter.notifiedNeedsAttention = ticket.notifiedNeedsAttention;
  }
  const raw = matter.stringify(ticket.body, frontmatter);
  await writeTextFile(join(dir, "meta.md"), raw);
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
  await run(["git", "add", ...addArgs]);
  const result = await run([
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
  ]);
  if (result.code !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    const stdout = new TextDecoder().decode(result.stdout);
    if (
      !stderr.includes("nothing to commit") &&
      !stdout.includes("nothing to commit")
    ) {
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
