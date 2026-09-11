import { join } from "@std/path";
import { urrasDir } from "../paths.ts";
import { bgGreen, bgRed, black, dim, inverse } from "@std/fmt/colors";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  Editor,
  type EditorTheme,
  isKeyRelease,
  matchesKey,
  type OverlayHandle,
  ProcessTerminal,
  TUI,
} from "@earendil-works/pi-tui";
import { expandHome, loadConfig } from "../config.ts";
import { isLaunchdEnabled } from "../launchd.ts";
import { isPhaseAlive } from "../executor.ts";
import {
  compareTickets,
  formatBrokenRow,
  formatStatusHeader,
  formatStatusRow,
  formatTokens,
  readTicketTokens,
  shouldHideTicket,
} from "./status.ts";
import { listTickets, readTicket } from "../state/store.ts";
import type { TicketState } from "../state/types.ts";
import { ScrollPane } from "../ui/scroll-pane.ts";
import type { Command } from "./types.ts";
import { mkdir, open, readTextFile } from "../filesystem.ts";
import { findLatestPhaseOutput, ReviewSession } from "../review.ts";

export type TicketEntry =
  | { ok: true; ticket: TicketState; tokens: number | null; alive: boolean }
  | { ok: false; id: string; error: string };

export interface HudWatcherDeps {
  readTicket: (stateDir: string, id: string) => Promise<TicketState>;
  readTicketTokens: (ticketDir: string) => Promise<number | null>;
  isPhaseAlive: (ticketDir: string) => boolean;
}

const BLOCKED_COMMANDS = new Set(["hud", "shell", "tail"]);

export function isBlockedCommand(name: string): boolean {
  return BLOCKED_COMMANDS.has(name);
}

export async function checkReviewPreconditions(
  id: string,
  stateDir: string,
  { readTicket: readTicketFn = readTicket }: {
    readTicket?: typeof readTicket;
  } = {},
): Promise<string | null> {
  if (!id) return "Usage: review <ticket-id>";
  const ticket = await readTicketFn(stateDir, id);
  if (ticket.status === "running") return `ticket ${id} is currently running`;
  if (ticket.status === "done") return `ticket ${id} is done`;
  const ticketDir = join(stateDir, id);
  const found = await findLatestPhaseOutput(ticketDir);
  const expectedPhaseNames = ticket.phase === "merge"
    ? ["merge", "implementation"]
    : [ticket.phase];
  if (!found || !expectedPhaseNames.includes(found.phaseName)) {
    return `No output for phase "${ticket.phase}" on ticket ${id}`;
  }
  return null;
}

export function parseCommand(
  input: string,
): { name: string; args: string[] } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  return { name: parts[0], args: parts.slice(1) };
}

export function formatTickLogLine(raw: string): string {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(raw);
  } catch {
    return raw;
  }
  const { ts = "", event = "", context = "", id = "", ...rest } = entry;
  let timeStr = "??:??:??";
  try {
    const zdt = Temporal.Instant.from(String(ts)).toZonedDateTimeISO(
      Temporal.Now.timeZoneId(),
    );
    timeStr = zdt.toString({
      fractionalSecondDigits: 0,
      offset: "never",
      timeZoneName: "never",
    });
  } catch {
    // malformed ts
  }
  const extras = Object.entries(rest)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const subject = context ? `${context}/${event}` : event;
  let line = `${dim(timeStr)} ${inverse(String(id))} ${subject}`;
  if (extras) {
    line += ` ${extras}`;
  }
  return line;
}

export function formatHudHeader(
  enabled: boolean,
  running: number,
  max: number,
  progress?: string,
): string {
  const badge = enabled
    ? bgGreen(black(" enabled "))
    : bgRed(black(" disabled "));
  const base = `${badge}  ${running}/${max} running`;
  return progress ? `${base}  ${progress}` : base;
}

export function logPaneLines(lines: string[]): string[] {
  return lines.length === 0 ? [dim("(no logs)")] : lines;
}

export async function openLogWatch(parentDir: string): Promise<Deno.FsWatcher> {
  await mkdir(parentDir, { recursive: true });
  return Deno.watchFs(parentDir);
}

export const HUD_CHROME_ROWS = 3;

export function paneHeights(
  { rows, inputRows }: { rows: number; inputRows: number },
): { status: number; log: number } {
  const available = Math.max(2, rows - inputRows - HUD_CHROME_ROWS);
  const status = Math.ceil(available / 2);
  return { status, log: available - status };
}

export const TICK_LOG_TAIL_LINES = 2000;
const TICK_LOG_TAIL_BYTES = 256 * 1024;

async function readTail(path: string, maxBytes: number): Promise<string> {
  const file = await open(path, { read: true });
  try {
    const { size } = await file.stat();
    if (size <= maxBytes) return await readTextFile(path);
    await file.seek(size - maxBytes, Deno.SeekMode.Start);
    const buffer = new Uint8Array(maxBytes);
    let read = 0;
    while (read < maxBytes) {
      const n = await file.read(buffer.subarray(read));
      if (n === null) break;
      read += n;
    }
    const text = new TextDecoder().decode(buffer.subarray(0, read));
    const firstBreak = text.indexOf("\n");
    return firstBreak === -1 ? "" : text.slice(firstBreak + 1);
  } finally {
    file.close();
  }
}

export async function readTickLog(tickLogPath: string): Promise<string[]> {
  let raw = "";
  try {
    raw = await readTail(tickLogPath, TICK_LOG_TAIL_BYTES);
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(-TICK_LOG_TAIL_LINES)
    .map(formatTickLogLine);
}

export interface HudAutocompleteProviderDeps {
  commands: Array<Pick<Command, "name" | "description" | "completesWith">>;
  listTickets: (stateDir?: string) => Promise<string[]>;
}

export function hudAutocompleteProvider(
  deps: HudAutocompleteProviderDeps,
): AutocompleteProvider {
  return {
    getSuggestions(
      lines: string[],
      _cursorLine: number,
      cursorCol: number,
      { signal }: { signal: AbortSignal },
    ): Promise<AutocompleteSuggestions | null> {
      if (signal.aborted) return Promise.resolve(null);
      const text = lines[0].slice(0, cursorCol);
      const spaceIndex = text.search(/\s/);
      if (spaceIndex === -1) {
        const prefix = text;
        const items = deps.commands
          .filter(
            (c) => !isBlockedCommand(c.name) && !c.name.startsWith("_"),
          )
          .map((c) => ({
            value: c.name,
            label: c.name,
            description: c.description ?? "",
          }));
        return Promise.resolve({ items, prefix });
      }
      const token1 = text.slice(0, spaceIndex);
      const prefix = lines[0].split(/\s/).pop() ?? "";
      const cmd = deps.commands.find((c) => c.name === token1);
      if (!cmd || cmd.completesWith === undefined) return Promise.resolve(null);
      if (cmd.completesWith === "_ids") {
        return deps.listTickets().then((ids) => {
          if (signal.aborted) return null;
          return {
            items: ids.map((id) => ({ value: id, label: id })),
            prefix,
          };
        });
      }
      return Promise.resolve({
        items: cmd.completesWith.map((s) => ({ value: s, label: s })),
        prefix,
      });
    },
    applyCompletion(
      lines: string[],
      _cursorLine: number,
      cursorCol: number,
      item: AutocompleteItem,
      prefix: string,
    ) {
      const before = lines[0].slice(0, cursorCol - prefix.length);
      const after = lines[0].slice(cursorCol);
      const newLine = before + item.value + after;
      return {
        lines: [newLine],
        cursorLine: 0,
        cursorCol: cursorCol - prefix.length + item.value.length,
      };
    },
  };
}

export async function loadTicketEntry(
  stateDir: string,
  id: string,
  deps: HudWatcherDeps,
): Promise<TicketEntry> {
  const ticketDir = join(stateDir, id);
  try {
    const [ticket, tokens] = await Promise.all([
      deps.readTicket(stateDir, id),
      deps.readTicketTokens(ticketDir),
    ]);
    const alive = deps.isPhaseAlive(ticketDir);
    return { ok: true, ticket, tokens, alive };
  } catch (error) {
    return {
      ok: false,
      id,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function handleTicketWatcherEvent(opts: {
  stateDir: string;
  eventPath: string;
  ticketMap: Map<string, TicketEntry>;
  ticketDirMap: Map<string, string>;
  deps: HudWatcherDeps;
  scheduleRefresh: () => void;
}): Promise<void> {
  const {
    stateDir,
    eventPath,
    ticketMap,
    ticketDirMap,
    deps,
    scheduleRefresh,
  } = opts;
  let id: string | undefined;
  for (const [dir, ticketId] of ticketDirMap) {
    if (eventPath === dir || eventPath.startsWith(dir + "/")) {
      id = ticketId;
      break;
    }
  }
  if (!id) return;
  ticketMap.set(id, await loadTicketEntry(stateDir, id, deps));
  scheduleRefresh();
}

export async function handleRootWatcherEvent(opts: {
  stateDir: string;
  ticketMap: Map<string, TicketEntry>;
  ticketDirMap: Map<string, string>;
  watchers: Set<Deno.FsWatcher>;
  deps: HudWatcherDeps;
  scheduleRefresh: () => void;
}): Promise<void> {
  const { stateDir, ticketMap, ticketDirMap, watchers, deps, scheduleRefresh } =
    opts;
  const currentIds = await listTickets(stateDir);
  const currentIdSet = new Set(currentIds);

  for (const id of currentIds) {
    if (!ticketMap.has(id)) {
      const ticketDir = join(stateDir, id);
      ticketMap.set(id, await loadTicketEntry(stateDir, id, deps));
      ticketDirMap.set(ticketDir, id);
      const watcher = Deno.watchFs(ticketDir, { recursive: true });
      watchers.add(watcher);
      (async () => {
        for await (const event of watcher) {
          if (event.paths.length > 0) {
            await handleTicketWatcherEvent({
              stateDir,
              eventPath: event.paths[0],
              ticketMap,
              ticketDirMap,
              deps,
              scheduleRefresh,
            });
          }
        }
      })();
    }
  }

  for (const id of [...ticketMap.keys()]) {
    if (!currentIdSet.has(id)) {
      ticketMap.delete(id);
      ticketDirMap.delete(join(stateDir, id));
    }
  }

  scheduleRefresh();
}

async function buildStatusFromMap(
  ticketMap: Map<string, TicketEntry>,
  config: { tick: { concurrency: number } },
): Promise<{ header: string; statusLines: string[] }> {
  const tickets: TicketState[] = [];
  const brokenRows: string[] = [];
  let running = 0;

  for (const entry of ticketMap.values()) {
    if (entry.ok) {
      tickets.push(entry.ticket);
      if (entry.ticket.status === "running" && entry.alive) running++;
    } else {
      brokenRows.push(formatBrokenRow(entry.id, entry.error));
    }
  }

  tickets.sort(compareTickets);
  const visible = tickets.filter((t) => !shouldHideTicket(t.phase, t.status));

  const statusLines = [
    ...formatStatusHeader().split("\n"),
    ...visible.map((t) => {
      const e = ticketMap.get(t.id);
      const tokens = e?.ok ? e.tokens : null;
      return formatStatusRow(
        t.id,
        t.phase,
        t.status,
        t.approvals,
        formatTokens(tokens),
        t.shortTitle ?? t.title,
      );
    }),
    ...brokenRows,
  ];

  const enabled = await isLaunchdEnabled();
  let progress: string | undefined;
  try {
    const raw = await readTextFile(join(urrasDir(), "tick-progress.json"));
    const data = JSON.parse(raw) as { label?: string };
    if (data.label) progress = data.label;
  } catch {
    // missing or unparseable
  }

  return {
    header: formatHudHeader(
      enabled,
      running,
      config.tick.concurrency,
      progress,
    ),
    statusLines,
  };
}

export const hud: Command = {
  name: "hud",
  description: "live status display",
  async run(_args) {
    const { commands } = await import("./registry.ts");
    const config = await loadConfig();
    const stateDir = expandHome(config.state.dir);
    const parentDir = urrasDir();
    const tickLogPath = join(parentDir, "log.ndjson");

    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal);

    let currentStatusLines: string[] = [];
    let currentLogLines: string[] = [];

    const editorTheme: EditorTheme = {
      borderColor: (str: string) => dim(str),
      selectList: {
        selectedPrefix: (text: string) => inverse(text),
        selectedText: (text: string) => inverse(text),
        description: (text: string) => dim(text),
        scrollInfo: (text: string) => dim(text),
        noMatch: (text: string) => text,
      },
    };
    const commandEditor = new Editor(tui, editorTheme);
    commandEditor.setAutocompleteProvider(
      hudAutocompleteProvider({
        commands,
        listTickets: () => listTickets(stateDir),
      }),
    );

    const layout = () =>
      paneHeights({
        rows: tui.terminal.rows,
        inputRows: commandEditor.render(tui.terminal.columns).length,
      });

    const statusPane = new ScrollPane({
      getLines: (_w) => currentStatusLines,
      tui,
      title: "status",
      getHeight: () => layout().status,
    });

    const logPane = new ScrollPane({
      getLines: (_w) => logPaneLines(currentLogLines),
      tui,
      title: "log",
      getHeight: () => layout().log,
    });

    let headerLine = "";
    const headerComponent = {
      render(_width: number): string[] {
        return [headerLine];
      },
      invalidate() {},
    };

    let commandRunning = false;
    let reviewSessionActive = false;

    tui.addChild(headerComponent);
    tui.addChild(statusPane);
    tui.addChild(logPane);
    tui.addChild(commandEditor);
    tui.setFocus(statusPane);
    statusPane.focused = true;
    logPane.focused = false;
    commandEditor.focused = false;

    async function refresh() {
      const logWasAtEnd = logPane.isAtEnd(tui.terminal.columns);
      const savedLogOffset = logPane.scrollOffset;
      const savedStatusOffset = statusPane.scrollOffset;

      const [{ header, statusLines }, logLines] = await Promise.all([
        buildStatusFromMap(ticketMap, config),
        readTickLog(tickLogPath),
      ]);

      headerLine = header;
      currentStatusLines = statusLines;
      currentLogLines = logLines;
      statusPane.setContent((_w) => currentStatusLines);
      statusPane.scrollOffset = savedStatusOffset;
      logPane.setContent((_w) => logPaneLines(currentLogLines));

      if (logWasAtEnd) {
        logPane.scrollToEnd();
      } else {
        logPane.scrollOffset = savedLogOffset;
      }

      tui.requestRender(true);
    }

    const ticketMap = new Map<string, TicketEntry>();
    const ticketDirMap = new Map<string, string>();
    const ticketWatchers = new Set<Deno.FsWatcher>();
    const hudDeps: HudWatcherDeps = {
      readTicket,
      readTicketTokens,
      isPhaseAlive,
    };

    commandEditor.onSubmit = async (value: string) => {
      if (commandRunning) return;
      const parsed = parseCommand(value);
      if (!parsed) return;
      const { name, args } = parsed;
      if (name === "review") {
        if (reviewSessionActive) return;
        const id = args[0] ?? "";
        const error = await checkReviewPreconditions(id, stateDir);
        if (error !== null) {
          headerLine = error;
          tui.requestRender(true);
          return;
        }
        reviewSessionActive = true;
        commandEditor.setText("");
        const handleRef: { value: OverlayHandle | null } = { value: null };
        const session = await ReviewSession.create({
          id,
          stateDir,
          ticketDir: join(stateDir, id),
          tui,
          close: () => {
            handleRef.value?.hide();
            reviewSessionActive = false;
            tui.setFocus(commandEditor);
            scheduleRefresh();
          },
        });
        const reviewHandle = tui.showOverlay(session, { width: "100%" });
        handleRef.value = reviewHandle;
        reviewHandle.focus();
        tui.requestRender(true);
        return;
      }
      if (isBlockedCommand(name)) {
        headerLine = `Blocked: ${name}`;
        tui.requestRender(true);
        return;
      }
      if (!commands.find((c) => c.name === name)) {
        headerLine = `Unknown command: ${name}`;
        tui.requestRender(true);
        return;
      }
      commandEditor.setText("");
      commandRunning = true;
      const label = args.length > 0 ? `${name} ${args.join(" ")}` : name;
      headerLine = `Running: ${label}`;
      tui.requestRender(true);
      const scriptPath = new URL("../index.ts", import.meta.url).pathname;
      const proc = new Deno.Command("deno", {
        args: ["run", "--allow-all", scriptPath, name, ...args],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      });
      const result = await proc.output();
      const combined = [
        new TextDecoder().decode(result.stdout),
        new TextDecoder().decode(result.stderr),
      ].join("\n");
      const lines = combined
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      let display: string;
      if (lines.length === 0) {
        display = result.code === 0 ? "OK" : `Error (exit ${result.code})`;
      } else {
        display = lines[0];
      }
      headerLine = display;
      tui.requestRender(true);
      commandRunning = false;
      setTimeout(() => refresh(), 3000);
    };

    const initialIds = await listTickets(stateDir);
    await Promise.all(
      initialIds.map(async (id) => {
        const entry = await loadTicketEntry(stateDir, id, hudDeps);
        ticketMap.set(id, entry);
        ticketDirMap.set(join(stateDir, id), id);
      }),
    );

    await refresh();
    logPane.scrollToEnd();

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    function scheduleRefresh() {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        refresh();
      }, 200);
    }

    for (const id of initialIds) {
      const watcher = Deno.watchFs(join(stateDir, id), { recursive: true });
      ticketWatchers.add(watcher);
      (async () => {
        for await (const event of watcher) {
          if (event.paths.length > 0) {
            await handleTicketWatcherEvent({
              stateDir,
              eventPath: event.paths[0],
              ticketMap,
              ticketDirMap,
              deps: hudDeps,
              scheduleRefresh,
            });
          }
        }
      })();
    }

    const watchRoot = Deno.watchFs(stateDir);
    (async () => {
      for await (const _event of watchRoot) {
        await handleRootWatcherEvent({
          stateDir,
          ticketMap,
          ticketDirMap,
          watchers: ticketWatchers,
          deps: hudDeps,
          scheduleRefresh,
        });
      }
    })();

    const watchLog = await openLogWatch(parentDir);

    (async () => {
      for await (const _event of watchLog) {
        scheduleRefresh();
      }
    })();

    tui.addInputListener((data) => {
      if (isKeyRelease(data)) {
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+c")) {
        tui.stop();
        Deno.exit(0);
      }
      if (matchesKey(data, "escape")) {
        if (
          commandEditor.focused && !reviewSessionActive &&
          !commandEditor.isShowingAutocomplete()
        ) {
          commandEditor.setText("");
          commandEditor.focused = false;
          statusPane.focused = true;
          logPane.focused = false;
          tui.setFocus(statusPane);
          tui.requestRender(true);
          return { consume: true };
        }
      }
      if (matchesKey(data, "tab")) {
        if (commandEditor.focused && commandEditor.getText() !== "") {
          return;
        }
        if (statusPane.focused) {
          statusPane.focused = false;
          logPane.focused = true;
          commandEditor.focused = false;
          tui.setFocus(logPane);
        } else if (logPane.focused) {
          logPane.focused = false;
          commandEditor.focused = true;
          statusPane.focused = false;
          tui.setFocus(commandEditor);
        } else {
          commandEditor.focused = false;
          statusPane.focused = true;
          logPane.focused = false;
          tui.setFocus(statusPane);
        }
        tui.requestRender(true);
      }
      if (matchesKey(data, "super+k")) {
        statusPane.focused = false;
        logPane.focused = false;
        commandEditor.focused = true;
        tui.setFocus(commandEditor);
        tui.requestRender(true);
      }
    });

    const sigtermHandler = () => {
      tui.stop();
      Deno.exit(0);
    };
    Deno.addSignalListener("SIGTERM", sigtermHandler);

    tui.start();
  },
};
