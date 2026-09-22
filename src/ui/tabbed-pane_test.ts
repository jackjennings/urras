import { assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { dim, stripAnsiCode } from "@std/fmt/colors";
import { renderTabBar, TabbedPane } from "./tabbed-pane.ts";

// ── renderTabBar ──────────────────────────────────────────────────────────────

Deno.test("renderTabBar: single tab renders as [phaseName]", () => {
  const result = renderTabBar([{ phaseName: "spec" }], 0);
  assertEquals(stripAnsiCode(result), "[spec]");
});

Deno.test("renderTabBar: active tab is bracketed and inactive tabs are not", () => {
  const result = stripAnsiCode(
    renderTabBar([{ phaseName: "intake" }, { phaseName: "spec" }], 1),
  );
  assertStringIncludes(result, "[spec]");
  assertFalse(result.includes("[intake]"));
});

Deno.test("renderTabBar: inactive tab text is dimmed", () => {
  const result = renderTabBar(
    [{ phaseName: "intake" }, { phaseName: "spec" }],
    1,
  );
  assertStringIncludes(result, dim("intake"));
});

Deno.test("renderTabBar: tabs are separated by ' ─ '", () => {
  const result = stripAnsiCode(
    renderTabBar(
      [{ phaseName: "intake" }, { phaseName: "enrichment" }, {
        phaseName: "spec",
      }],
      2,
    ),
  );
  assertStringIncludes(result, "intake ─ enrichment ─ [spec]");
});

// ── TabbedPane ────────────────────────────────────────────────────────────────

Deno.test("TabbedPane: prev() at index 0 returns false and does not change activeIndex", () => {
  const pane = new TabbedPane([{ phaseName: "a" }, { phaseName: "b" }], 0);
  const changed = pane.prev();
  assertFalse(changed);
  assertEquals(pane.activeIndex, 0);
});

Deno.test("TabbedPane: next() at last index returns false and does not change activeIndex", () => {
  const pane = new TabbedPane([{ phaseName: "a" }, { phaseName: "b" }], 1);
  const changed = pane.next();
  assertFalse(changed);
  assertEquals(pane.activeIndex, 1);
});

Deno.test("TabbedPane: prev() above 0 returns true and decrements activeIndex", () => {
  const pane = new TabbedPane([{ phaseName: "a" }, { phaseName: "b" }], 1);
  const changed = pane.prev();
  assertEquals(changed, true);
  assertEquals(pane.activeIndex, 0);
});

Deno.test("TabbedPane: next() below last returns true and increments activeIndex", () => {
  const pane = new TabbedPane([{ phaseName: "a" }, { phaseName: "b" }], 0);
  const changed = pane.next();
  assertEquals(changed, true);
  assertEquals(pane.activeIndex, 1);
});

Deno.test("TabbedPane: renderBar() delegates to renderTabBar", () => {
  const pane = new TabbedPane([{ phaseName: "x" }, { phaseName: "y" }], 0);
  assertEquals(
    pane.renderBar(),
    renderTabBar([{ phaseName: "x" }, { phaseName: "y" }], 0),
  );
});
