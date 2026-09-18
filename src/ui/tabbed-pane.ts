import { dim } from "@std/fmt/colors";

export type Tab = { phaseName: string };

export function renderTabBar(tabs: Tab[], activeIndex: number): string {
  return tabs
    .map((tab, i) =>
      i === activeIndex ? `[${tab.phaseName}]` : dim(tab.phaseName)
    )
    .join(" ─ ");
}

export class TabbedPane {
  private _activeIndex: number;

  constructor(
    private readonly tabs: Tab[],
    initialIndex = 0,
  ) {
    this._activeIndex = initialIndex;
  }

  get activeIndex(): number {
    return this._activeIndex;
  }

  prev(): boolean {
    if (this._activeIndex <= 0) return false;
    this._activeIndex--;
    return true;
  }

  next(): boolean {
    if (this._activeIndex >= this.tabs.length - 1) return false;
    this._activeIndex++;
    return true;
  }

  renderBar(): string {
    return renderTabBar(this.tabs, this._activeIndex);
  }
}
