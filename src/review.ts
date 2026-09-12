import {
  bold,
  cyan,
  dim,
  gray,
  green,
  italic,
  red,
  strikethrough,
  stripAnsiCode,
  underline,
  yellow,
} from "@std/fmt/colors";
import { join } from "@std/path";
import {
  type Component,
  Editor,
  type Focusable,
  getKeybindings,
  isKeyRelease,
  KeybindingsManager,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  type OverlayHandle,
  ProcessTerminal,
  setKeybindings,
  TUI,
  TUI_KEYBINDINGS,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { expandHome, loadConfig } from "./config.ts";
import { captureCommandRunner } from "./apfel.ts";
import { ApfelLanguageModel } from "./models/apfel.ts";
import { ClaudeLanguageModel } from "./models/claude.ts";
import { FallbackLanguageModel } from "./models/fallback.ts";
import type { LanguageModel } from "./models/types.ts";
import {
  commitTicket,
  readPhaseOutput,
  readTicketWithPatch,
  writePhaseOutput,
} from "./state/store.ts";
import type { TicketState } from "./state/types.ts";
import { buildContextFiles } from "./run-phase.ts";
import { CONTEXT_PHASE_SEQUENCE } from "./phases/types.ts";
import { compactTimestamp } from "./timestamp.ts";
import { diffLines } from "diff";
import { ScrollPane } from "./ui/scroll-pane.ts";
import {
  computeVisibleHeadingIndices,
  extractHeadings,
  renderTocLines,
} from "./ui/toc.ts";
import { readDir, readTextFile, renderPrompt } from "./filesystem.ts";

const markdownTheme: MarkdownTheme = {
  heading: (s) => cyan(s),
  link: (s) => cyan(s),
  linkUrl: (s) => dim(s),
  code: (s) => yellow(s),
  codeBlock: (s) => s,
  codeBlockBorder: (s) => dim(s),
  quote: (s) => italic(s),
  quoteBorder: (s) => dim(s),
  hr: (s) => dim(s),
  listBullet: (s) => dim(s),
  bold: (s) => bold(s),
  italic: (s) => italic(s),
  strikethrough: (s) => strikethrough(s),
  underline: (s) => underline(s),
};

export function renderDiff(oldStr: string, newStr: string): string[] {
  const changes = diffLines(oldStr, newStr);
  const lines: string[] = [];
  for (const change of changes) {
    const parts = change.value.split("\n");
    if (parts[parts.length - 1] === "") parts.pop();
    for (const part of parts) {
      if (change.added) {
        lines.push(green(`+ ${part}`));
      } else if (change.removed) {
        lines.push(red(`- ${part}`));
      } else {
        lines.push(dim(`  ${part}`));
      }
    }
  }
  return lines;
}

export function wrapDiffLines(lines: string[], width: number): string[] {
  return lines.flatMap((line) => {
    const visible = stripAnsiCode(line);
    if (visible.length <= width) return [line];
    const visibleBody = visible.slice(2);
    if (!visibleBody.includes(" ")) return [line];
    const visiblePrefix = visible.slice(0, 2);
    const coloredPrefix = visiblePrefix === "+ "
      ? green(visiblePrefix)
      : visiblePrefix === "- "
      ? red(visiblePrefix)
      : dim(visiblePrefix);
    return wrapTextWithAnsi(visibleBody, width - 2).map((chunk) =>
      coloredPrefix + chunk
    );
  });
}

export async function findLatestPhaseOutput(
  ticketDir: string,
): Promise<
  | { filename: string; phaseName: string; previousFilename: string | null }
  | null
> {
  for (const phase of [...CONTEXT_PHASE_SEQUENCE].reverse()) {
    const outputPattern = new RegExp(`^\\d{8}T\\d{6}-${phase}\.md$`);
    const matches: string[] = [];
    try {
      for await (const entry of readDir(ticketDir)) {
        if (entry.isFile && outputPattern.test(entry.name)) {
          matches.push(entry.name);
        }
      }
    } catch {
      /* dir missing */
    }
    if (matches.length > 0) {
      matches.sort();
      return {
        filename: matches[matches.length - 1],
        phaseName: phase,
        previousFilename: matches.length >= 2
          ? matches[matches.length - 2]
          : null,
      };
    }
  }
  return null;
}

export async function findAllPhaseOutputs(
  ticketDir: string,
): Promise<
  Array<
    { filename: string; phaseName: string; previousFilename: string | null }
  >
> {
  const results: Array<
    { filename: string; phaseName: string; previousFilename: string | null }
  > = [];
  for (const phase of CONTEXT_PHASE_SEQUENCE) {
    const outputPattern = new RegExp(`^\\d{8}T\\d{6}-${phase}\\.md$`);
    const matches: string[] = [];
    try {
      for await (const entry of readDir(ticketDir)) {
        if (entry.isFile && outputPattern.test(entry.name)) {
          matches.push(entry.name);
        }
      }
    } catch {
      /* dir missing */
    }
    if (matches.length > 0) {
      matches.sort();
      results.push({
        filename: matches[matches.length - 1],
        phaseName: phase,
        previousFilename: matches.length >= 2
          ? matches[matches.length - 2]
          : null,
      });
    }
  }
  return results;
}

export async function findLatestSelfApprove(
  ticketDir: string,
  phaseName: string,
  afterTimestamp: string,
): Promise<{ filename: string; fullText: string } | null> {
  const pattern = new RegExp(
    `^\\d{8}T\\d{6}-${phaseName}-self-approve\\.md$`,
  );
  const matches: string[] = [];
  try {
    for await (const entry of readDir(ticketDir)) {
      if (entry.isFile && pattern.test(entry.name)) {
        matches.push(entry.name);
      }
    }
  } catch {
    /* dir missing */
  }
  if (matches.length === 0) return null;
  matches.sort();
  const newest = matches[matches.length - 1];
  if (newest.slice(0, 15) <= afterTimestamp) return null;
  const fullText = await readTextFile(join(ticketDir, newest));
  const firstLine = fullText.split("\n")[0].trim().toUpperCase();
  if (!firstLine.startsWith("REJECT")) return null;
  return { filename: newest, fullText };
}

export async function findLatestFeedback(
  ticketDir: string,
  phaseName: string,
  afterTimestamp: string,
  beforeTimestamp: string,
): Promise<{ filename: string; fullText: string } | null> {
  const pattern = new RegExp(
    `^\\d{8}T\\d{6}-${phaseName}-feedback\\.md$`,
  );
  const matches: string[] = [];
  try {
    for await (const entry of readDir(ticketDir)) {
      if (entry.isFile && pattern.test(entry.name)) {
        const ts = entry.name.slice(0, 15);
        if (ts > afterTimestamp && ts <= beforeTimestamp) {
          matches.push(entry.name);
        }
      }
    }
  } catch {
    /* dir missing */
  }
  if (matches.length === 0) return null;
  matches.sort();
  const newest = matches[matches.length - 1];
  const fullText = await readTextFile(join(ticketDir, newest));
  return { filename: newest, fullText };
}

export function renderTabBar(
  tabs: Array<{ phaseName: string }>,
  activeIndex: number,
): string {
  return tabs
    .map((
      tab,
      i,
    ) => (i === activeIndex ? `[${tab.phaseName}]` : dim(tab.phaseName)))
    .join(" ─ ");
}

export async function classifyApproval(
  text: string,
  model: LanguageModel = new FallbackLanguageModel([
    new ApfelLanguageModel(captureCommandRunner()),
    new ClaudeLanguageModel(captureCommandRunner(), {
      model: "claude-haiku-4-5",
    }),
  ]),
): Promise<boolean> {
  if (text.trim().length > 50) return false;
  const result = await model.generateObject<
    { verdict: "APPROVE" | "FEEDBACK" }
  >(
    {
      systemPrompt: await renderPrompt(
        new URL("./review-approval.prompt.hbs", import.meta.url),
      ),
      prompt: text,
      maxTokens: 5,
      schema: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["APPROVE", "FEEDBACK"] },
        },
        required: ["verdict"],
      },
    },
  );
  if (result === null) {
    throw new Error("Approval detection failed: all models returned null");
  }
  return result.verdict === "APPROVE";
}

export async function applyApproval(
  stateDir: string,
  id: string,
  now: Temporal.ZonedDateTime,
  {
    readTicket = readTicketWithPatch,
    commit = commitTicket,
  }: {
    readTicket?: typeof readTicketWithPatch;
    commit?: typeof commitTicket;
  } = {},
): Promise<void> {
  const { ticket, patchTicket } = await readTicket(stateDir, id);
  const nowStr = now.toInstant().toString();
  await patchTicket({
    approvals: [
      ...ticket.approvals,
      { timestamp: nowStr, actor: "human" as const, phase: ticket.phase },
    ],
    updated: nowStr,
  });
  await commit(stateDir, id, `approve: ${id}`);
}

export function formatTimestamp(now: Temporal.ZonedDateTime): string {
  return compactTimestamp(now);
}

export async function buildQuestionSystemPrompt(
  contextFiles: string[],
  readFile: (path: string | URL) => Promise<string> = readTextFile,
): Promise<string> {
  const preamble = await renderPrompt(
    new URL("./review-question.prompt.hbs", import.meta.url),
  );
  const parts: string[] = [preamble];
  for (const contextFile of contextFiles) {
    const path = contextFile.startsWith("@")
      ? contextFile.slice(1)
      : contextFile;
    try {
      const content = await readFile(path);
      parts.push(`\n---\n\n## ${path}\n\n${content}`);
    } catch {
      /* unreadable, skip */
    }
  }
  return parts.join("\n");
}

export async function answerQuestion(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  userText: string,
  systemPrompt: string,
  fetcher: typeof fetch,
): Promise<void> {
  messages.push({ role: "user", content: userText });
  try {
    const response = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") ?? "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        system: systemPrompt,
        messages,
      }),
    });
    if (!response.ok) {
      messages.push({
        role: "assistant",
        content: "Error: could not get a response.",
      });
      return;
    }
    const data = await response.json();
    const text = (data?.content?.[0]?.text ?? "").trim();
    messages.push({ role: "assistant", content: text });
  } catch {
    messages.push({
      role: "assistant",
      content: "Error: could not get a response.",
    });
  }
}

class QuestionOverlay implements Component, Focusable {
  private _focused = false;
  private messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  private pending = false;
  private editor: Editor;
  private handle: OverlayHandle | null = null;
  private onDismiss: (() => void) | null = null;

  constructor(
    private systemPrompt: string,
    private fetcher: typeof fetch,
    tui: TUI,
  ) {
    this.editor = new Editor(tui, {
      borderColor: (s) => s,
      selectList: {
        selectedPrefix: (s) => s,
        selectedText: (s) => s,
        description: (s) => s,
        scrollInfo: (s) => s,
        noMatch: (s) => s,
      },
    });
    this.editor.onSubmit = async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      this.editor.setText("");
      this.pending = true;
      tui.requestRender(true);
      await answerQuestion(
        this.messages,
        trimmed,
        this.systemPrompt,
        this.fetcher,
      );
      this.pending = false;
      tui.requestRender(true);
    };
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value;
  }

  setHandle(handle: OverlayHandle, onDismiss: () => void): void {
    this.handle = handle;
    this.onDismiss = onDismiss;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.handle?.setHidden(true);
      this.onDismiss?.();
      return;
    }
    this.editor.handleInput?.(data);
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    for (const msg of this.messages) {
      const label = msg.role === "user" ? dim("You:") : dim("Assistant:");
      lines.push(label);
      for (const line of wrapTextWithAnsi(msg.content, width - 2)) {
        lines.push(`  ${line}`);
      }
      lines.push("");
    }
    if (this.pending) {
      lines.push(dim("…"));
    }
    lines.push(...this.editor.render(width));
    return lines;
  }
}

export class ErrorOverlay implements Component, Focusable {
  private _focused = false;
  private message = "";
  private handle: OverlayHandle | null = null;
  private onDismiss: (() => void) | null = null;

  constructor(private tui: TUI) {}

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  setMessage(message: string): void {
    this.message = message;
  }

  setHandle(handle: OverlayHandle, onDismiss: () => void): void {
    this.handle = handle;
    this.onDismiss = onDismiss;
  }

  handleInput(_data: string): void {
    this.handle?.setHidden(true);
    this.onDismiss?.();
    this.tui.requestRender(true);
  }

  invalidate(): void {}

  render(width: number): string[] {
    return wrapTextWithAnsi(this.message, width);
  }
}

function rejectionBannerLines(
  phaseName: string,
  fullText: string,
  width: number,
): string[] {
  const header = bold(red(`Self-review rejected: ${phaseName}`));
  const bodyLines = fullText
    .split("\n")
    .flatMap((line) => (line ? wrapTextWithAnsi(red(line), width) : [""]));
  return [header, ...bodyLines];
}

function feedbackBannerLines(
  phaseName: string,
  fullText: string,
  width: number,
): string[] {
  const header = bold(yellow(`Human feedback: ${phaseName}`));
  const bodyLines = fullText
    .split("\n")
    .flatMap((line) => (line ? wrapTextWithAnsi(yellow(line), width) : [""]));
  return [header, ...bodyLines];
}

export function renderTicketTab(ticket: TicketState): string {
  const lines: string[] = [
    `# ${ticket.title}`,
    "",
    `**URL:** ${ticket.url}`,
    `**Phase:** ${ticket.phase} / **Status:** ${ticket.status}`,
    "",
    "**Scope:**",
    ...ticket.scope.map((s) => `- ${s}`),
    "",
    "**Approvals:**",
    ...ticket.approvals.map((a) => {
      const ts = Temporal.Instant.from(a.timestamp).toZonedDateTimeISO("UTC");
      return `- ${compactTimestamp(ts)} — ${a.actor} (${a.phase})`;
    }),
    "",
    "**Worktrees:**",
    ...Object.entries(ticket.worktrees).map(
      ([key, info]) => `- ${key}: ${info.path} (${info.branch})`,
    ),
    "",
  ];

  if (ticket.prs && ticket.prs.length > 0) {
    lines.push("**PRs:**");
    for (const pr of ticket.prs) {
      lines.push(`- ${pr.url}`);
    }
    lines.push("");
  }

  lines.push("---", "", ticket.body);

  return lines.join("\n");
}

type TabContent = {
  getLines: (width: number) => string[];
  onInvalidate: (() => void) | undefined;
  headings: { level: number; title: string; sourceLine: number }[];
  totalSourceLines: number;
};

export interface ReviewSessionOptions {
  id: string;
  stateDir: string;
  ticket: TicketState;
  patchTicket: (patch: Partial<TicketState>) => Promise<void>;
  systemPrompt: string;
  allTabs?: Array<{ phaseName: string }>;
  allTabContents?: TabContent[];
  tui: TUI;
  close: () => void;
  readTicket?: typeof readTicketWithPatch;
  commit?: typeof commitTicket;
  fetch?: typeof fetch;
  getKeybindings?: () => KeybindingsManager;
  setKeybindings?: (kb: KeybindingsManager) => void;
}

export interface ReviewSessionCreateOptions {
  id: string;
  stateDir: string;
  ticketDir: string;
  ticket?: TicketState;
  patchTicket?: (patch: Partial<TicketState>) => Promise<void>;
  tui: TUI;
  close: () => void;
  readTicket?: typeof readTicketWithPatch;
  commit?: typeof commitTicket;
  fetch?: typeof fetch;
  getKeybindings?: () => KeybindingsManager;
  setKeybindings?: (kb: KeybindingsManager) => void;
}

export class ReviewSession implements Component, Focusable {
  private _focused = false;
  private closed = false;
  private readonly savedKb: KeybindingsManager;
  private readonly scrollPane: ScrollPane;
  private readonly editor: Editor;
  private readonly questionHandle: OverlayHandle;
  private readonly errorHandle: OverlayHandle;
  private readonly questionOverlay: QuestionOverlay;
  private readonly errorOverlay: ErrorOverlay;
  private readonly allTabs: Array<{ phaseName: string }>;
  private readonly allTabContents: TabContent[];
  private activeTabIndex: number;
  private editorVisible: boolean;
  private headings: { level: number; title: string; sourceLine: number }[];
  private totalSourceLines: number;
  private currentOnInvalidate: (() => void) | undefined;
  private focusedElement: "content" | "editor" = "content";
  private readonly id: string;
  private readonly stateDir: string;
  private readonly ticket: TicketState;
  private readonly patchTicket: (patch: Partial<TicketState>) => Promise<void>;
  private readonly tui: TUI;
  private readonly onClose: () => void;
  private readonly readTicket: typeof readTicketWithPatch;
  private readonly commit: typeof commitTicket;
  private readonly fetcher: typeof fetch;
  private readonly setKeybindings: (kb: KeybindingsManager) => void;

  constructor({
    id,
    stateDir,
    ticket,
    patchTicket,
    systemPrompt,
    allTabs: allTabsOpt,
    allTabContents: allTabContentsOpt,
    tui,
    close,
    readTicket = readTicketWithPatch,
    commit = commitTicket,
    fetch: fetcher = fetch,
    getKeybindings: getKeybindingsArg = getKeybindings,
    setKeybindings: setKeybindingsArg = setKeybindings,
  }: ReviewSessionOptions) {
    this.id = id;
    this.stateDir = stateDir;
    this.ticket = ticket;
    this.patchTicket = patchTicket;
    this.tui = tui;
    this.onClose = close;
    this.readTicket = readTicket;
    this.commit = commit;
    this.fetcher = fetcher;
    this.setKeybindings = setKeybindingsArg;

    const ticketContent = renderTicketTab(ticket);
    const ticketMd = new Markdown(ticketContent, 1, 0, markdownTheme);
    const defaultTicketTabContent: TabContent = {
      getLines: (w) => ticketMd.render(w),
      onInvalidate: () => ticketMd.invalidate(),
      headings: [],
      totalSourceLines: 0,
    };

    this.allTabs = allTabsOpt ?? [{ phaseName: "ticket" }];
    this.allTabContents = allTabContentsOpt ?? [defaultTicketTabContent];
    this.activeTabIndex = this.allTabs.length - 1;
    this.editorVisible = this.activeTabIndex === this.allTabs.length - 1;
    this.headings = this.allTabContents[this.activeTabIndex].headings;
    this.totalSourceLines =
      this.allTabContents[this.activeTabIndex].totalSourceLines;
    this.currentOnInvalidate =
      this.allTabContents[this.activeTabIndex].onInvalidate;

    this.savedKb = getKeybindingsArg();
    const kb = new KeybindingsManager({
      ...TUI_KEYBINDINGS,
      "tui.input.submit": {
        defaultKeys: ["shift+enter"],
        description: "Submit input",
      },
      "tui.input.newLine": {
        defaultKeys: ["enter", "ctrl+j"],
        description: "Insert newline",
      },
    });
    setKeybindingsArg(kb);

    this.editor = new Editor(tui, {
      borderColor: (s) => this.focusedElement === "editor" ? s : gray(s),
      selectList: {
        selectedPrefix: (s) => s,
        selectedText: (s) => s,
        description: (s) => s,
        scrollInfo: (s) => s,
        noMatch: (s) => s,
      },
    });

    this.scrollPane = new ScrollPane({
      getLines: this.allTabContents[this.activeTabIndex].getLines,
      tui,
      getTitle: () => renderTabBar(this.allTabs, this.activeTabIndex),
      getHeight: () =>
        this.editorVisible
          ? Math.max(
            1,
            tui.terminal.rows -
              this.editor.render(tui.terminal.columns).length - 1,
          )
          : tui.terminal.rows - 1,
      onInvalidate: () => this.currentOnInvalidate?.(),
      pinnedSidebar: (w, scrollState) =>
        renderTocLines(
          this.headings,
          w,
          computeVisibleHeadingIndices({
            headings: this.headings,
            totalSourceLines: this.totalSourceLines,
            ...scrollState,
          }),
        ),
      pinnedSidebarWidth: (w) =>
        this.headings.length === 0 || w < 100 ? 0 : Math.floor(w / 3),
    });

    tui.addChild(this.scrollPane);
    if (this.editorVisible) tui.addChild(this.editor);
    tui.setFocus(this.scrollPane);

    this.questionOverlay = new QuestionOverlay(systemPrompt, fetcher, tui);
    this.questionHandle = tui.showOverlay(this.questionOverlay, {
      width: "80%",
      minWidth: 60,
      maxHeight: "80%",
      margin: 1,
    });
    this.questionHandle.setHidden(true);
    this.questionOverlay.setHandle(this.questionHandle, () => {
      tui.setFocus(
        this.focusedElement === "content" ? this.scrollPane : this.editor,
      );
      tui.requestRender(true);
    });

    this.errorOverlay = new ErrorOverlay(tui);
    this.errorHandle = tui.showOverlay(this.errorOverlay, {
      width: "80%",
      minWidth: 60,
      maxHeight: "80%",
      margin: 1,
    });
    this.errorHandle.setHidden(true);
    this.errorOverlay.setHandle(this.errorHandle, () => {
      tui.setFocus(this.editor);
      tui.requestRender(true);
    });

    this.editor.onSubmit = this.handleSubmit;

    tui.addInputListener((data) => {
      if (isKeyRelease(data)) {
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+c")) {
        this.close();
        return;
      }
      if (matchesKey(data, "escape")) {
        this.close();
        return;
      }
      if (matchesKey(data, "alt+shift+/")) {
        if (this.questionHandle.isHidden()) {
          this.questionHandle.setHidden(false);
          this.questionHandle.focus();
        }
        return { consume: true };
      }
      if (
        matchesKey(data, "left") &&
        this.focusedElement === "content" &&
        this.activeTabIndex > 0
      ) {
        this.activeTabIndex--;
        this.applyTabSwitch();
        tui.requestRender(true);
        return { consume: true };
      }
      if (
        matchesKey(data, "right") &&
        this.focusedElement === "content" &&
        this.activeTabIndex < this.allTabs.length - 1
      ) {
        this.activeTabIndex++;
        this.applyTabSwitch();
        tui.requestRender(true);
        return { consume: true };
      }
      if (matchesKey(data, "tab")) {
        if (this.editorVisible) {
          if (this.focusedElement === "content") {
            this.focusedElement = "editor";
            tui.setFocus(this.editor);
          } else {
            this.focusedElement = "content";
            tui.setFocus(this.scrollPane);
          }
          tui.requestRender(true);
        }
        return { consume: true };
      }
      if (matchesKey(data, "shift+enter")) {
        const text = this.editor.getExpandedText();
        if (text.trim()) {
          void this.handleSubmit(text);
        }
        return { consume: true };
      }
    });
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.scrollPane.focused = value;
  }

  invalidate(): void {
    this.scrollPane.invalidate();
    if (this.editorVisible) this.editor.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [...this.scrollPane.render(width)];
    if (this.editorVisible) lines.push(...this.editor.render(width));
    return lines;
  }

  handleInput(data: string): void {
    if (this.scrollPane.handleInput) this.scrollPane.handleInput(data);
  }

  private applyTabSwitch(): void {
    const tabContent = this.allTabContents[this.activeTabIndex];
    this.scrollPane.setContent(tabContent.getLines);
    this.headings = tabContent.headings;
    this.totalSourceLines = tabContent.totalSourceLines;
    this.currentOnInvalidate = tabContent.onInvalidate;
    this.editorVisible = this.activeTabIndex === this.allTabs.length - 1;
    if (this.editorVisible) {
      this.tui.addChild(this.editor);
    } else {
      this.tui.removeChild(this.editor);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.questionHandle.hide();
    this.errorHandle.hide();
    this.tui.removeChild(this.scrollPane);
    if (this.editorVisible) this.tui.removeChild(this.editor);
    this.setKeybindings(this.savedKb);
    this.onClose();
  }

  private handleSubmit = async (text: string): Promise<void> => {
    if (!text.trim()) return;
    const now = Temporal.Now.zonedDateTimeISO("UTC");
    let isApproval: boolean;
    try {
      isApproval = await classifyApproval(text);
    } catch (e) {
      this.errorOverlay.setMessage(
        e instanceof Error ? e.message : String(e),
      );
      this.errorHandle.setHidden(false);
      this.errorHandle.focus();
      return;
    }
    if (isApproval) {
      await applyApproval(this.stateDir, this.id, now, {
        readTicket: this.readTicket,
        commit: this.commit,
      });
      this.close();
      return;
    }
    const timestamp = formatTimestamp(now);
    const feedbackFile = `${timestamp}-${this.ticket.phase}-feedback.md`;
    await writePhaseOutput(this.stateDir, this.id, feedbackFile, text);
    await this.patchTicket({
      status: "revising",
      updated: now.toInstant().toString(),
    });
    await this.commit(this.stateDir, this.id, `review: ${this.id}`);
    this.close();
  };

  static async create(
    opts: ReviewSessionCreateOptions,
  ): Promise<ReviewSession> {
    const {
      id,
      stateDir,
      ticketDir,
      tui,
      close,
      readTicket = readTicketWithPatch,
      commit = commitTicket,
      fetch: fetcher = fetch,
      getKeybindings: getKeybindingsArg = getKeybindings,
      setKeybindings: setKeybindingsArg = setKeybindings,
    } = opts;

    let ticket: TicketState;
    let patchTicket: (patch: Partial<TicketState>) => Promise<void>;

    if (opts.ticket !== undefined && opts.patchTicket !== undefined) {
      ticket = opts.ticket;
      patchTicket = opts.patchTicket;
    } else {
      const result = await readTicket(stateDir, id);
      ticket = result.ticket;
      patchTicket = result.patchTicket;
    }

    const tabs = await findAllPhaseOutputs(ticketDir);
    const tabContents: TabContent[] = [];

    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      const isLatest = i === tabs.length - 1;
      const rawContent = await readPhaseOutput(stateDir, id, tab.filename);
      if (isLatest && tab.previousFilename !== null) {
        const previousContent = await readPhaseOutput(
          stateDir,
          id,
          tab.previousFilename,
        );
        const diffResult = renderDiff(previousContent, rawContent);
        tabContents.push({
          getLines: (w) => wrapDiffLines(diffResult, w),
          onInvalidate: undefined,
          headings: [],
          totalSourceLines: 0,
        });
      } else {
        const md = new Markdown(rawContent, 1, 0, markdownTheme);
        tabContents.push({
          getLines: (w) => md.render(w),
          onInvalidate: () => md.invalidate(),
          headings: extractHeadings(rawContent),
          totalSourceLines: rawContent.split("\n").length,
        });
      }
    }

    const tabRejections = await Promise.all(
      tabs.map((tab) =>
        findLatestSelfApprove(
          ticketDir,
          tab.phaseName,
          tab.filename.slice(0, 15),
        )
      ),
    );

    for (let i = 0; i < tabs.length; i++) {
      const selfApprove = tabRejections[i];
      if (selfApprove !== null) {
        const originalGetLines = tabContents[i].getLines;
        const phaseName = tabs[i].phaseName;
        const fullText = selfApprove.fullText;
        tabContents[i] = {
          ...tabContents[i],
          getLines: (width) => [
            ...rejectionBannerLines(phaseName, fullText, width),
            "",
            ...originalGetLines(width),
          ],
        };
      }
    }

    for (let i = 0; i < tabs.length; i++) {
      const isLatest = i === tabs.length - 1;
      const previousFilename = tabs[i].previousFilename;
      if (isLatest && previousFilename !== null) {
        const feedback = await findLatestFeedback(
          ticketDir,
          tabs[i].phaseName,
          previousFilename.slice(0, 15),
          tabs[i].filename.slice(0, 15),
        );
        if (feedback !== null) {
          const originalGetLines = tabContents[i].getLines;
          const phaseName = tabs[i].phaseName;
          const fullText = feedback.fullText;
          tabContents[i] = {
            ...tabContents[i],
            getLines: (width) => [
              ...feedbackBannerLines(phaseName, fullText, width),
              "",
              ...originalGetLines(width),
            ],
          };
        }
      }
    }

    const ticketContent = renderTicketTab(ticket);
    const ticketMd = new Markdown(ticketContent, 1, 0, markdownTheme);
    const ticketTabContent: TabContent = {
      getLines: (w) => ticketMd.render(w),
      onInvalidate: () => ticketMd.invalidate(),
      headings: [],
      totalSourceLines: 0,
    };
    const allTabs = [{ phaseName: "ticket" }, ...tabs];
    const allTabContents = [ticketTabContent, ...tabContents];

    const { contextFiles } = await buildContextFiles({ ticketDir, stateDir });
    const systemPrompt = await buildQuestionSystemPrompt(contextFiles);

    return new ReviewSession({
      id,
      stateDir,
      ticket,
      patchTicket,
      systemPrompt,
      allTabs,
      allTabContents,
      tui,
      close,
      readTicket,
      commit,
      fetch: fetcher,
      getKeybindings: getKeybindingsArg,
      setKeybindings: setKeybindingsArg,
    });
  }
}

export async function review(
  id: string,
  {
    isTerminal = () => Deno.stdin.isTerminal(),
    readStdin = () => new Response(Deno.stdin.readable).text(),
    stateDir: stateDirOverride,
    readTicket = readTicketWithPatch,
    commit = commitTicket,
  }: {
    isTerminal?: () => boolean;
    readStdin?: () => Promise<string>;
    stateDir?: string;
    readTicket?: typeof readTicketWithPatch;
    commit?: typeof commitTicket;
  } = {},
): Promise<void> {
  const stateDir = stateDirOverride ??
    expandHome((await loadConfig()).state.dir);
  const ticketDir = join(stateDir, id);

  const { ticket, patchTicket } = await readTicket(stateDir, id);

  if (ticket.status === "running") {
    console.error(`ticket ${id} is currently running`);
    Deno.exit(1);
  }

  if (ticket.status === "done") {
    console.error(`ticket ${id} is done`);
    Deno.exit(1);
  }

  const found = await findLatestPhaseOutput(ticketDir);
  const expectedPhaseNames: string[] = ticket.phase === "merge"
    ? ["merge", "implementation"]
    : [ticket.phase];
  if (!found || !expectedPhaseNames.includes(found.phaseName)) {
    console.error(`No output for phase "${ticket.phase}" on ticket ${id}`);
    Deno.exit(1);
  }

  if (!isTerminal()) {
    const text = await readStdin();
    if (!text.trim()) {
      console.error("review input is empty");
      Deno.exit(1);
    }
    const selfReviewRejection = await findLatestSelfApprove(
      ticketDir,
      found.phaseName,
      found.filename.slice(0, 15),
    );
    if (selfReviewRejection !== null) {
      console.error(
        `Self-review rejected [${found.phaseName}]: ${
          selfReviewRejection.fullText.split("\n")[0].trim()
        }`,
      );
    }
    const now = Temporal.Now.zonedDateTimeISO("UTC");
    const timestamp = formatTimestamp(now);
    const feedbackFile = `${timestamp}-${ticket.phase}-feedback.md`;
    await writePhaseOutput(stateDir, id, feedbackFile, text);
    await patchTicket({
      status: "revising",
      updated: now.toInstant().toString(),
    });
    await commit(stateDir, id, `review: ${id}`);
    Deno.exit(0);
  }

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const handlerRef: { sigterm?: () => void } = {};
  const session = await ReviewSession.create({
    id,
    stateDir,
    ticketDir,
    ticket,
    patchTicket,
    tui,
    close() {
      if (handlerRef.sigterm) {
        Deno.removeSignalListener("SIGTERM", handlerRef.sigterm);
      }
      tui.stop();
      Deno.exit(0);
    },
    readTicket,
    commit,
  });

  handlerRef.sigterm = () => session.close();
  Deno.addSignalListener("SIGTERM", handlerRef.sigterm);
  tui.showOverlay(session, { width: "100%" });
  tui.start();
}
