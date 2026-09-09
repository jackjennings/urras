import { assertEquals } from "@std/assert";
import {
  canonicalLoginFor,
  currentLoginFor,
  type OrgIdentityTable,
} from "./org-identity.ts";

Deno.test(
  "canonicalLoginFor: returns the key when login is a canonical entry",
  () => {
    const table: OrgIdentityTable = {
      hellboxpy: {
        orgId: 1,
        currentLogin: "hellboxpy",
        aliases: ["hellboxpy"],
      },
    };
    assertEquals(canonicalLoginFor(table, "hellboxpy"), "hellboxpy");
  },
);

Deno.test(
  "canonicalLoginFor: returns the canonical key when login appears as an alias",
  () => {
    const table: OrgIdentityTable = {
      hellboxpy: {
        orgId: 1,
        currentLogin: "hellbox",
        aliases: ["hellboxpy", "hellbox"],
      },
    };
    assertEquals(canonicalLoginFor(table, "hellbox"), "hellboxpy");
  },
);

Deno.test("canonicalLoginFor: returns the input when not in table", () => {
  assertEquals(canonicalLoginFor({}, "unknown"), "unknown");
});

Deno.test(
  "currentLoginFor: returns currentLogin for a known canonical entry",
  () => {
    const table: OrgIdentityTable = {
      hellboxpy: {
        orgId: 1,
        currentLogin: "hellbox",
        aliases: ["hellboxpy", "hellbox"],
      },
    };
    assertEquals(currentLoginFor(table, "hellboxpy"), "hellbox");
  },
);

Deno.test(
  "currentLoginFor: resolves via alias then returns currentLogin",
  () => {
    const table: OrgIdentityTable = {
      hellboxpy: {
        orgId: 1,
        currentLogin: "hellbox",
        aliases: ["hellboxpy", "hellbox"],
      },
    };
    assertEquals(currentLoginFor(table, "hellbox"), "hellbox");
  },
);

Deno.test("currentLoginFor: returns the input when not in table", () => {
  assertEquals(currentLoginFor({}, "unknown"), "unknown");
});
