import { assertEquals } from "@std/assert";
import { assertSpyCall, spy } from "@std/testing/mock";
import {
  makeCandidateSelector,
  selectCandidates,
} from "./candidate-selection.ts";

Deno.test("selectCandidates: empty candidates returns empty", () => {
  assertEquals(selectCandidates([], [], 2), []);
});

Deno.test("selectCandidates: no lastWorked starts at index 0", () => {
  assertEquals(selectCandidates(["gh-1", "gh-2", "gh-3"], [], 2), [
    "gh-1",
    "gh-2",
  ]);
});

Deno.test("selectCandidates: lastWorked anchor advances start by one", () => {
  assertEquals(
    selectCandidates(["gh-1", "gh-2", "gh-3", "gh-4", "gh-5"], ["gh-2"], 2),
    ["gh-3", "gh-4"],
  );
});

Deno.test("selectCandidates: anchor at last element wraps to index 0", () => {
  assertEquals(selectCandidates(["gh-1", "gh-2", "gh-3"], ["gh-3"], 2), [
    "gh-1",
    "gh-2",
  ]);
});

Deno.test("selectCandidates: wrapping selection spans end and start of list", () => {
  assertEquals(
    selectCandidates(["gh-1", "gh-2", "gh-3", "gh-4", "gh-5"], ["gh-4"], 3),
    ["gh-5", "gh-1", "gh-2"],
  );
});

Deno.test("selectCandidates: concurrency larger than candidates returns all", () => {
  assertEquals(selectCandidates(["gh-1", "gh-2"], [], 10), ["gh-1", "gh-2"]);
});

Deno.test("selectCandidates: all lastWorked IDs absent from candidates starts at 0", () => {
  assertEquals(
    selectCandidates(["gh-1", "gh-3", "gh-5"], ["gh-2", "gh-4"], 2),
    ["gh-1", "gh-3"],
  );
});

Deno.test("selectCandidates: uses last surviving ID from end of lastWorked as anchor", () => {
  assertEquals(
    selectCandidates(["gh-1", "gh-2", "gh-3"], ["gh-1", "gh-99", "gh-2"], 1),
    ["gh-3"],
  );
});

Deno.test("makeCandidateSelector: selects via readLastWorked and persists via writeLastWorked", async () => {
  const writeLastWorkedSpy = spy((_ids: string[]) => Promise.resolve());
  const selector = makeCandidateSelector({
    readLastWorked: () => Promise.resolve(["gh-1"]),
    writeLastWorked: writeLastWorkedSpy,
  });
  const selected = await selector(["gh-1", "gh-2", "gh-3"], 1);
  assertEquals(selected, ["gh-2"]);
  assertSpyCall(writeLastWorkedSpy, 0, { args: [["gh-2"]] });
});

Deno.test("makeCandidateSelector: writes empty array when no candidates", async () => {
  const writeLastWorkedSpy = spy((_ids: string[]) => Promise.resolve());
  const selector = makeCandidateSelector({
    readLastWorked: () => Promise.resolve([]),
    writeLastWorked: writeLastWorkedSpy,
  });
  const selected = await selector([], 3);
  assertEquals(selected, []);
  assertSpyCall(writeLastWorkedSpy, 0, { args: [[]] });
});
