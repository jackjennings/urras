import { dim, stripAnsiCode } from "@std/fmt/colors";
import {
  type Component,
  type Focusable,
  matchesKey,
  type TUI,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { compositeSideBySide } from "./toc.ts";

const SIDEBAR_SEP = dim("│");
const SIDEBAR_SEP_WIDTH = 1;

export class ScrollPane implements Component, Focusable {
  private getLinesFn: (width: number) => string[];
  private onInvalidateFn?: () => void;
  private pinnedSidebar?: (
    sidebarWidth: number,
    scrollState: { scrollOffset: number; totalLines: number; height: number },
  ) => string[];
  private pinnedSidebarWidth?: (totalWidth: number) => number;
  scrollOffset = 0;
  focused = true;
  private tui: TUI;
  private titleFn: () => string;
  private getHeight: () => number;
  private expanded?: {
    // deno-lint-ignore no-fn-suffix/no-fn-suffix
    getLinesFn: (width: number) => string[];
    width: number;
    lines: string[];
  };

  constructor(
    options: {
      getLines: (width: number) => string[];
      tui: TUI;
      getHeight: () => number;
      onInvalidate?: () => void;
      pinnedSidebar?: (
        sidebarWidth: number,
        scrollState: {
          scrollOffset: number;
          totalLines: number;
          height: number;
        },
      ) => string[];
      pinnedSidebarWidth?: (totalWidth: number) => number;
    } & ({ title: string } | { getTitle: () => string }),
  ) {
    this.getLinesFn = options.getLines;
    this.tui = options.tui;
    this.titleFn = "getTitle" in options
      ? options.getTitle
      : () => options.title;
    this.getHeight = options.getHeight;
    this.onInvalidateFn = options.onInvalidate;
    this.pinnedSidebar = options.pinnedSidebar;
    this.pinnedSidebarWidth = options.pinnedSidebarWidth;
  }

  private activeSidebarWidth(totalWidth: number): number {
    return this.pinnedSidebarWidth?.(totalWidth) ?? 0;
  }

  private effectiveContentWidth(totalWidth: number): number {
    const sw = this.activeSidebarWidth(totalWidth);
    if (sw === 0) return totalWidth;
    return totalWidth - sw - SIDEBAR_SEP_WIDTH;
  }

  private expandLines(width: number): string[] {
    const cached = this.expanded;
    if (
      cached && cached.getLinesFn === this.getLinesFn && cached.width === width
    ) {
      return cached.lines;
    }
    const raw = this.getLinesFn(width).flatMap((line) =>
      line.split(/\r\n|\n|\r/)
    );
    const lines = width <= 0
      ? raw
      : raw.flatMap((segment) => wrapTextWithAnsi(segment, width));
    this.expanded = { getLinesFn: this.getLinesFn, width, lines };
    return lines;
  }

  setContent(getLines: (width: number) => string[]): void {
    this.getLinesFn = getLines;
    this.expanded = undefined;
    this.scrollOffset = 0;
  }

  scrollToEnd(): void {
    const width = this.tui.terminal.columns;
    const cw = this.effectiveContentWidth(width);
    const height = this.getHeight();
    const lines = this.expandLines(cw);
    this.scrollOffset = Math.max(0, lines.length - height);
  }

  isAtEnd(width: number): boolean {
    const cw = this.effectiveContentWidth(width);
    const lines = this.expandLines(cw);
    const height = this.getHeight();
    return this.scrollOffset >= Math.max(0, lines.length - height);
  }

  private header(width: number): string {
    const title = this.titleFn();
    const label = ` ${title} `;
    const remaining = Math.max(0, width - stripAnsiCode(label).length);
    const left = Math.floor(remaining / 2);
    const right = remaining - left;
    const line = "─".repeat(left) + label + "─".repeat(right);
    return this.focused ? line : dim(line);
  }

  handleInput(data: string): void {
    if (!this.focused) return;
    const width = this.tui.terminal.columns;
    const cw = this.effectiveContentWidth(width);
    if (matchesKey(data, "space") || matchesKey(data, "f")) {
      const height = this.getHeight();
      const lines = this.expandLines(cw);
      const maxOffset = Math.max(0, lines.length - height);
      this.scrollOffset = Math.min(this.scrollOffset + height, maxOffset);
    }
    if (matchesKey(data, "b")) {
      const height = this.getHeight();
      this.scrollOffset = Math.max(0, this.scrollOffset - height);
    }
    if (matchesKey(data, "down")) {
      const height = this.getHeight();
      const lines = this.expandLines(cw);
      const maxOffset = Math.max(0, lines.length - height);
      this.scrollOffset = Math.min(this.scrollOffset + 1, maxOffset);
    }
    if (matchesKey(data, "up")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    }
  }

  invalidate(): void {
    this.expanded = undefined;
    this.onInvalidateFn?.();
  }

  render(width: number): string[] {
    const sw = this.activeSidebarWidth(width);
    const cw = this.effectiveContentWidth(width);
    const lines = this.expandLines(cw);
    const height = this.getHeight();
    const sliced = lines.slice(this.scrollOffset, this.scrollOffset + height);
    while (sliced.length < height) sliced.push("");
    if (sw > 0 && this.pinnedSidebar) {
      const tocLines = this.pinnedSidebar(sw, {
        scrollOffset: this.scrollOffset,
        totalLines: lines.length,
        height,
      });
      return [
        this.header(width),
        ...compositeSideBySide(sliced, cw, tocLines, SIDEBAR_SEP),
      ];
    }
    return [this.header(width), ...sliced];
  }
}
