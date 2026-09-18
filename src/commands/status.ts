import { join } from "@std/path";
import { bgGreen, bgRed, green, red, white, yellow } from "@std/fmt/colors";
import { listTickets, readTicket } from "../state/store.ts";
import { expandHome, loadConfig } from "../config.ts";
import { readUsageFiles } from "../usage.ts";
import { isLaunchdEnabled } from "../launchd.ts";
import { FULL_PHASE_SEQUENCE } from "../phases/types.ts";
import type {
  ApprovalEntry,
  PhaseUsage,
  PrEntry,
  TicketState,
} from "../state/types.ts";
import { STATUS_SEQUENCE } from "../state/types.ts";
import type { Command } from "./types.ts";
import { GitHubProvider } from "../providers/github.ts";
import { JiraProvider } from "../providers/jira.ts";
import { TodoTxtProvider } from "../providers/todo-txt.ts";
import { compareSortKeys } from "../providers/types.ts";
import { readDir, readTextFile } from "../filesystem.ts";

const toSortableMap: Record<string, (id: string) => Array<string | number>> = {
  github: GitHubProvider.toSortable,
  jira: JiraProvider.toSortable,
  "todo-txt": TodoTxtProvider.toSortable,
};

export function compareTickets(a: TicketState, b: TicketState): number {
  const aPhaseIdx = FULL_PHASE_SEQUENCE.indexOf(
    a.phase as typeof FULL_PHASE_SEQUENCE[number],
  );
  const bPhaseIdx = FULL_PHASE_SEQUENCE.indexOf(
    b.phase as typeof FULL_PHASE_SEQUENCE[number],
  );
  const ai = aPhaseIdx === -1 ? FULL_PHASE_SEQUENCE.length : aPhaseIdx;
  const bi = bPhaseIdx === -1 ? FULL_PHASE_SEQUENCE.length : bPhaseIdx;
  if (ai !== bi) return ai - bi;
  const aStatusIdx = STATUS_SEQUENCE.indexOf(
    a.status as typeof STATUS_SEQUENCE[number],
  );
  const bStatusIdx = STATUS_SEQUENCE.indexOf(
    b.status as typeof STATUS_SEQUENCE[number],
  );
  const asi = aStatusIdx === -1 ? STATUS_SEQUENCE.length : aStatusIdx;
  const bsi = bStatusIdx === -1 ? STATUS_SEQUENCE.length : bStatusIdx;
  if (asi !== bsi) return asi - bsi;
  if (a.provider !== b.provider) {
    return a.provider < b.provider ? -1 : 1;
  }
  const toSortableA = toSortableMap[a.provider] ?? ((id: string) => [id]);
  const toSortableB = toSortableMap[b.provider] ?? ((id: string) => [id]);
  return compareSortKeys(toSortableA(a.id), toSortableB(b.id));
}

export function formatTokens(total: number | null): string {
  if (total === null) return "—";
  if (total < 1000) return String(total);
  return `${(Math.round(total / 100) / 10).toFixed(1)}k`;
}

export async function readTicketTokens(
  ticketDir: string,
): Promise<number | null> {
  const files = await readUsageFiles(ticketDir);
  if (!files || files.length === 0) return null;
  return files.reduce(
    (sum, u) =>
      sum +
      u.models.reduce(
        (s, m) => s + m.input + m.output + m.cacheRead + m.cacheWrite,
        0,
      ),
    0,
  );
}

export async function readTicketCost(
  ticketDir: string,
): Promise<{ cost: number | null; partial: boolean }> {
  const files = await readUsageFiles(ticketDir);
  if (!files || files.length === 0) return { cost: null, partial: false };
  const withCost = files.filter((u) =>
    u.models.some((m) => m.costUsd !== undefined)
  );
  if (withCost.length === 0) return { cost: null, partial: false };
  const cost = withCost.reduce(
    (sum, u) => sum + u.models.reduce((s, m) => s + (m.costUsd ?? 0), 0),
    0,
  );
  return { cost, partial: withCost.length < files.length };
}

async function readNamedUsageFiles(
  ticketDir: string,
): Promise<{ name: string; usage: PhaseUsage }[] | null> {
  const files: { name: string; usage: PhaseUsage }[] = [];
  try {
    for await (const entry of readDir(ticketDir)) {
      if (!entry.isFile || !entry.name.endsWith(".usage.json")) continue;
      try {
        const raw = await readTextFile(join(ticketDir, entry.name));
        files.push({
          name: entry.name,
          usage: JSON.parse(raw) as PhaseUsage,
        });
      } catch {
        return null;
      }
    }
  } catch {
    return null;
  }
  return files;
}

function groupPhaseKey(name: string): string {
  const stem = name
    .replace(/^\d{8}T\d{6}-/, "")
    .replace(/\.usage\.json$/, "");
  return stem.startsWith("ci-fix-") ? "ci-fix" : stem;
}

const KNOWN_BACKGROUND_PHASES = ["ci-fix", "conflict-resolution"];

function comparePhaseKeys(a: string, b: string): number {
  const ai = (FULL_PHASE_SEQUENCE as readonly string[]).indexOf(a);
  const bi = (FULL_PHASE_SEQUENCE as readonly string[]).indexOf(b);
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  const aIsBackground = KNOWN_BACKGROUND_PHASES.includes(a);
  const bIsBackground = KNOWN_BACKGROUND_PHASES.includes(b);
  if (aIsBackground && !bIsBackground) return -1;
  if (!aIsBackground && bIsBackground) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export type PhaseRow = {
  key: string;
  tokens: number;
  turns: number | null;
  revisions: number;
};

export function buildPhaseBreakdown(
  files: { name: string; usage: PhaseUsage }[],
): PhaseRow[] {
  const groups = new Map<
    string,
    { tokens: number; turns: number | null; revisions: number }
  >();
  for (const { name, usage } of files) {
    const key = groupPhaseKey(name);
    let group = groups.get(key);
    if (!group) {
      group = { tokens: 0, turns: null, revisions: 0 };
      groups.set(key, group);
    }
    group.tokens += usage.models.reduce(
      (s, m) => s + m.input + m.output + m.cacheRead + m.cacheWrite,
      0,
    );
    group.revisions++;
    if (usage.turns !== undefined) {
      group.turns = (group.turns ?? 0) + usage.turns;
    }
  }
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      tokens: g.tokens,
      turns: g.turns,
      revisions: g.revisions,
    }))
    .sort((a, b) => comparePhaseKeys(a.key, b.key));
}

export function formatPhaseBreakdown(rows: PhaseRow[]): string {
  if (rows.length === 0) return "";
  const maxKeyLen = Math.max(...rows.map((r) => r.key.length));
  const lines = ["Phases:"];
  for (const row of rows) {
    const name = row.key.padEnd(maxKeyLen);
    const tokens = formatTokens(row.tokens).padStart(6);
    const turns = row.turns !== null ? `${row.turns} turns` : "—";
    const revisions = row.revisions === 1
      ? "1 revision"
      : `${row.revisions} revisions`;
    lines.push(`  ${name}  ${tokens}  ${turns}  ${revisions}`);
  }
  return lines.join("\n");
}

type TicketUsageData = {
  tokens: number | null;
  costResult: { cost: number | null; partial: boolean };
  phaseBreakdown: PhaseRow[] | null;
};

export async function readAllTicketUsage(
  ticketDir: string,
): Promise<TicketUsageData> {
  const files = await readNamedUsageFiles(ticketDir);
  if (!files || files.length === 0) {
    return {
      tokens: null,
      costResult: { cost: null, partial: false },
      phaseBreakdown: null,
    };
  }
  const tokens = files.reduce(
    (sum, { usage: u }) =>
      sum +
      u.models.reduce(
        (s, m) => s + m.input + m.output + m.cacheRead + m.cacheWrite,
        0,
      ),
    0,
  );
  const withCost = files.filter(({ usage: u }) =>
    u.models.some((m) => m.costUsd !== undefined)
  );
  const costResult = withCost.length === 0 ? { cost: null, partial: false } : {
    cost: withCost.reduce(
      (sum, { usage: u }) =>
        sum + u.models.reduce((s, m) => s + (m.costUsd ?? 0), 0),
      0,
    ),
    partial: withCost.length < files.length,
  };
  const rows = buildPhaseBreakdown(files);
  return {
    tokens,
    costResult,
    phaseBreakdown: rows.length > 0 ? rows : null,
  };
}

function formatCost(
  { cost, partial }: { cost: number | null; partial: boolean },
): string {
  if (cost === null) return "—";
  const formatted = `$${cost.toFixed(2)}`;
  return partial ? `~${formatted}` : formatted;
}

function formatPrs(prs: PrEntry[] | undefined): string {
  if (!prs || prs.length === 0) return "—";
  const [first, ...rest] = prs;
  if (rest.length === 0) return first.url;
  return [first.url, ...rest.map((p) => " ".repeat(9) + p.url)].join("\n");
}

type LogEntry = {
  ts: string;
  event: string;
  [key: string]: unknown;
};

function isAttentionEntry(e: LogEntry): boolean {
  return (
    e.event === "phase-output-invalid" ||
    (e.event === "phase-transition" && e.to === "needs-attention") ||
    e.event === "needs-attention" ||
    e.event === "conflict-resolution-failed" ||
    (e.event === "error" && e.context === "resolveCIFix")
  );
}

function formatAttentionEntry(e: LogEntry): string {
  let fields: string;
  if (e.event === "phase-output-invalid") {
    fields = `phase=${e.phase}, reason=${e.reason}`;
  } else if (e.event === "phase-transition") {
    fields = `reason=${e.reason}`;
  } else if (e.event === "needs-attention") {
    fields = `reason=${e.reason}`;
  } else if (e.event === "conflict-resolution-failed") {
    fields = `reason=${e.reason}, branch=${e.branch}${
      typeof e.sessionId === "string" ? `, sessionId=${e.sessionId}` : ""
    }`;
  } else {
    fields = `reason=${e.reason}, runId=${e.runId}`;
  }
  return `${e.ts}: ${e.event}: ${fields}`;
}

export async function readAttentionReason(
  ticketDir: string,
): Promise<string | null> {
  let raw: string;
  try {
    raw = await readTextFile(join(ticketDir, "log.ndjson"));
  } catch {
    return null;
  }
  let last: LogEntry | null = null;
  for (const line of raw.split("\n").filter(Boolean)) {
    try {
      const entry = JSON.parse(line) as LogEntry;
      if (isAttentionEntry(entry)) last = entry;
    } catch {
      // skip malformed lines
    }
  }
  return last ? formatAttentionEntry(last) : null;
}

export function formatDetailView(
  ticket: TicketState,
  tokens: number | null,
  costResult: { cost: number | null; partial: boolean },
  attentionReason?: string | null,
  phaseBreakdown?: PhaseRow[] | null,
): string {
  const lastApproval = ticket.approvals.at(-1);
  const approvedStr = lastApproval?.phase === ticket.phase
    ? lastApproval.actor
    : "—";
  const lines = [
    `${"Phase".padEnd(8)} ${ticket.phase}`,
    `${"Status".padEnd(8)} ${ticket.status}`,
    `Approved ${approvedStr}`,
    `${"Tokens".padEnd(8)} ${formatTokens(tokens)}`,
    `${"Cost".padEnd(8)} ${formatCost(costResult)}`,
    `${"PRs".padEnd(8)} ${formatPrs(ticket.prs)}`,
  ];
  if (attentionReason) {
    lines.push(`${"Reason".padEnd(8)} ${attentionReason}`);
  }
  if (phaseBreakdown && phaseBreakdown.length > 0) {
    lines.push(formatPhaseBreakdown(phaseBreakdown));
  }
  return lines.join("\n");
}

function colorizeStatus(status: string): string {
  const padded = status.padEnd(17);
  if (status === "running") return green(padded);
  if (status === "waiting") return yellow(padded);
  if (status === "needs-attention") return red(padded);
  return padded;
}

export function formatStatusRow(
  marker: string,
  id: string,
  phase: string,
  status: string,
  approvals: ApprovalEntry[],
  tokenStr: string,
  title: string,
): string {
  const last = approvals.at(-1);
  const approvedFor = last?.phase === phase ? last.actor : null;
  const approvedStr = approvedFor ?? "-";
  return `${marker} ${id.padEnd(36)} ${phase.padEnd(16)} ${
    colorizeStatus(status)
  } ${approvedStr.padEnd(9)} ${tokenStr.padStart(10)} ${title}`;
}

export function shouldHideTicket(phase: string, status: string): boolean {
  return (phase === "merge" && status === "done") || phase === "wont-do";
}

export function formatBrokenRow(id: string, message: string): string {
  return `${red(id.padEnd(36))} ${message}`;
}

function terminalWidth(fallback: number): number {
  try {
    return Deno.consoleSize().columns;
  } catch {
    return fallback;
  }
}

export function formatStatusHeader(): string {
  const header = `  ${"ID".padEnd(36)} ${"PHASE".padEnd(16)} ${
    "STATUS".padEnd(17)
  } ${"APPROVED".padEnd(9)} ${"TOKENS".padStart(10)} TITLE`;
  return [header, "─".repeat(terminalWidth(header.length))].join("\n");
}

export const status: Command = {
  name: "status",
  description: "show active tickets",
  completesWith: "_ids",
  async run(args) {
    const id = args[0];
    if (id && !id.startsWith("--")) {
      const config = await loadConfig();
      const stateDir = expandHome(config.state.dir);
      let ticket: TicketState;
      try {
        ticket = await readTicket(stateDir, id);
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) {
          console.error(`No such ticket: ${id}`);
          Deno.exit(1);
        }
        throw e;
      }
      const ticketDir = join(stateDir, id);
      const [{ tokens, costResult, phaseBreakdown }, attentionReason] =
        await Promise.all([
          readAllTicketUsage(ticketDir),
          ticket.status === "needs-attention"
            ? readAttentionReason(ticketDir)
            : Promise.resolve(null),
        ]);
      console.log(
        formatDetailView(
          ticket,
          tokens,
          costResult,
          attentionReason,
          phaseBreakdown,
        ),
      );
      return;
    }

    const enabled = await isLaunchdEnabled();
    const label = enabled
      ? bgGreen(white(" enabled "))
      : bgRed(white(" disabled "));
    console.log(label);
    console.log();

    const config = await loadConfig();
    const stateDir = expandHome(config.state.dir);
    const ids = await listTickets(stateDir);
    if (ids.length === 0) {
      console.log("No active tickets.");
      Deno.exit(0);
    }
    const results = await Promise.allSettled(
      ids.map((id) => readTicket(stateDir, id)),
    );
    const validTickets: TicketState[] = [];
    const brokenRows: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        validTickets.push(result.value);
      } else {
        const err = result.reason;
        brokenRows.push(
          formatBrokenRow(
            ids[i],
            err instanceof Error ? err.message : String(err),
          ),
        );
      }
    }
    validTickets.sort(compareTickets);
    const showAll = args.includes("--all");
    const visible = showAll
      ? validTickets
      : validTickets.filter((t) => !shouldHideTicket(t.phase, t.status));
    if (visible.length === 0 && brokenRows.length === 0) {
      console.log("No active tickets (run with --all to show completed).");
      Deno.exit(0);
    }
    const tokenTotals = await Promise.all(
      visible.map((t) => readTicketTokens(join(stateDir, t.id))),
    );
    console.log(formatStatusHeader());
    for (let i = 0; i < visible.length; i++) {
      const t = visible[i];
      console.log(
        formatStatusRow(
          t.held ? "~" : t.prioritized ? "!" : " ",
          t.id,
          t.phase,
          t.status,
          t.approvals,
          formatTokens(tokenTotals[i]),
          t.shortTitle ?? t.title,
        ),
      );
    }
    for (const row of brokenRows) {
      console.log(row);
    }
  },
};
