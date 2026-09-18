import { assertEquals } from "@std/assert";
import { assertSpyCall, spy } from "@std/testing/mock";
import {
  makeCandidateSelector,
  selectCandidates,
} from "./candidate-selection.ts";

function normal(ids: string[]) {
  return ids.map((id) => ({ id, prioritized: false }));
}

function prioritized(ids: string[]) {
  return ids.map((id) => ({ id, prioritized: true }));
}

const emptyLastWorked = { prioritized: [], normal: [] };

Deno.test("selectCandidates: empty candidates returns empty", () => {
  assertEquals(selectCandidates([], emptyLastWorked, 2), []);
});

Deno.test("selectCandidates: no lastWorked starts at index 0", () => {
  assertEquals(
    selectCandidates(normal(["gh-1", "gh-2", "gh-3"]), emptyLastWorked, 2),
    ["gh-1", "gh-2"],
  );
});

Deno.test("selectCandidates: lastWorked anchor advances start by one", () => {
  assertEquals(
    selectCandidates(
      normal(["gh-1", "gh-2", "gh-3", "gh-4", "gh-5"]),
      { prioritized: [], normal: ["gh-2"] },
      2,
    ),
    ["gh-3", "gh-4"],
  );
});

Deno.test("selectCandidates: anchor at last element wraps to index 0", () => {
  assertEquals(
    selectCandidates(
      normal(["gh-1", "gh-2", "gh-3"]),
      { prioritized: [], normal: ["gh-3"] },
      2,
    ),
    ["gh-1", "gh-2"],
  );
});

Deno.test("selectCandidates: wrapping selection spans end and start of list", () => {
  assertEquals(
    selectCandidates(
      normal(["gh-1", "gh-2", "gh-3", "gh-4", "gh-5"]),
      { prioritized: [], normal: ["gh-4"] },
      3,
    ),
    ["gh-5", "gh-1", "gh-2"],
  );
});

Deno.test("selectCandidates: concurrency larger than candidates returns all", () => {
  assertEquals(
    selectCandidates(normal(["gh-1", "gh-2"]), emptyLastWorked, 10),
    ["gh-1", "gh-2"],
  );
});

Deno.test("selectCandidates: all lastWorked IDs absent from candidates starts at 0", () => {
  assertEquals(
    selectCandidates(
      normal(["gh-1", "gh-3", "gh-5"]),
      { prioritized: [], normal: ["gh-2", "gh-4"] },
      2,
    ),
    ["gh-1", "gh-3"],
  );
});

Deno.test("selectCandidates: uses last surviving ID from end of lastWorked as anchor", () => {
  assertEquals(
    selectCandidates(
      normal(["gh-1", "gh-2", "gh-3"]),
      { prioritized: [], normal: ["gh-1", "gh-99", "gh-2"] },
      1,
    ),
    ["gh-3"],
  );
});

Deno.test("selectCandidates: prioritized tickets fill slots before normal tickets", () => {
  assertEquals(
    selectCandidates(
      [...prioritized(["p-1", "p-2"]), ...normal(["n-1", "n-2"])],
      emptyLastWorked,
      3,
    ),
    ["p-1", "p-2", "n-1"],
  );
});

Deno.test("selectCandidates: if prioritized count exceeds concurrency, normal gets no slots", () => {
  assertEquals(
    selectCandidates(
      [...prioritized(["p-1", "p-2", "p-3"]), ...normal(["n-1"])],
      emptyLastWorked,
      2,
    ),
    ["p-1", "p-2"],
  );
});

Deno.test("selectCandidates: if prioritized count is less than concurrency, remaining slots fill from normal", () => {
  assertEquals(
    selectCandidates(
      [...prioritized(["p-1"]), ...normal(["n-1", "n-2", "n-3"])],
      emptyLastWorked,
      3,
    ),
    ["p-1", "n-1", "n-2"],
  );
});

Deno.test("selectCandidates: round-robin fairness within prioritized tier", () => {
  const candidates = prioritized(["p-1", "p-2", "p-3"]);
  const tick1 = selectCandidates(candidates, emptyLastWorked, 1);
  assertEquals(tick1, ["p-1"]);
  const tick2 = selectCandidates(
    candidates,
    { prioritized: ["p-1"], normal: [] },
    1,
  );
  assertEquals(tick2, ["p-2"]);
  const tick3 = selectCandidates(
    candidates,
    { prioritized: ["p-2"], normal: [] },
    1,
  );
  assertEquals(tick3, ["p-3"]);
});

Deno.test("selectCandidates: round-robin fairness within normal tier", () => {
  const candidates = normal(["n-1", "n-2", "n-3"]);
  const tick1 = selectCandidates(candidates, emptyLastWorked, 1);
  assertEquals(tick1, ["n-1"]);
  const tick2 = selectCandidates(
    candidates,
    { prioritized: [], normal: ["n-1"] },
    1,
  );
  assertEquals(tick2, ["n-2"]);
});

Deno.test("makeCandidateSelector: selects via readLastWorked and persists via writeLastWorked", async () => {
  const writeLastWorkedSpy = spy(
    (_worked: { prioritized: string[]; normal: string[] }) => Promise.resolve(),
  );
  const selector = makeCandidateSelector({
    readLastWorked: () =>
      Promise.resolve({ prioritized: [], normal: ["gh-1"] }),
    writeLastWorked: writeLastWorkedSpy,
  });
  const selected = await selector(normal(["gh-1", "gh-2", "gh-3"]), 1);
  assertEquals(selected, ["gh-2"]);
  assertSpyCall(writeLastWorkedSpy, 0, {
    args: [{ prioritized: [], normal: ["gh-2"] }],
  });
});

Deno.test("makeCandidateSelector: writes empty buckets when no candidates", async () => {
  const writeLastWorkedSpy = spy(
    (_worked: { prioritized: string[]; normal: string[] }) => Promise.resolve(),
  );
  const selector = makeCandidateSelector({
    readLastWorked: () => Promise.resolve({ prioritized: [], normal: [] }),
    writeLastWorked: writeLastWorkedSpy,
  });
  const selected = await selector([], 3);
  assertEquals(selected, []);
  assertSpyCall(writeLastWorkedSpy, 0, {
    args: [{ prioritized: [], normal: [] }],
  });
});

Deno.test("makeCandidateSelector: persists prioritized and normal buckets separately", async () => {
  const writeLastWorkedSpy = spy(
    (_worked: { prioritized: string[]; normal: string[] }) => Promise.resolve(),
  );
  const selector = makeCandidateSelector({
    readLastWorked: () => Promise.resolve({ prioritized: [], normal: [] }),
    writeLastWorked: writeLastWorkedSpy,
  });
  const selected = await selector(
    [...prioritized(["p-1"]), ...normal(["n-1", "n-2"])],
    2,
  );
  assertEquals(selected, ["p-1", "n-1"]);
  assertSpyCall(writeLastWorkedSpy, 0, {
    args: [{ prioritized: ["p-1"], normal: ["n-1"] }],
  });
});
