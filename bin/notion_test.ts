import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  blockToMarkdown,
  databaseToMarkdown,
  markdownToBlocks,
  parseNotionId,
  propertyToString,
  richTextToMarkdown,
  runAppend,
  runCreate,
  runDatabase,
  runPage,
  runReplace,
  runSearch,
  searchResultsToMarkdown,
  toRich,
} from "./notion";
import type { Client } from "@notionhq/client";
import type {
  BlockObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints";

const scriptPath = new URL("./notion", import.meta.url).pathname;

// ── parseNotionId ─────────────────────────────────────────────────────────────

Deno.test("parseNotionId — slug URL with 32-hex suffix", () => {
  assertEquals(
    parseNotionId(
      "https://www.notion.so/workspace/My-Page-abc1234567890abcdef1234567890ab",
    ),
    "abc1234567890abcdef1234567890ab",
  );
});

Deno.test("parseNotionId — bare 32-hex URL", () => {
  assertEquals(
    parseNotionId("https://www.notion.so/abc1234567890abcdef1234567890ab"),
    "abc1234567890abcdef1234567890ab",
  );
});

Deno.test("parseNotionId — UUID-with-dashes URL", () => {
  assertEquals(
    parseNotionId(
      "https://www.notion.so/abc12345-6789-0abc-def1-234567890abc",
    ),
    "abc12345-6789-0abc-def1-234567890abc",
  );
});

Deno.test("parseNotionId — returns null for segment with no hex ID", () => {
  assertEquals(parseNotionId("https://www.notion.so/not-a-valid-page"), null);
});

Deno.test("parseNotionId — returns null for non-URL input", () => {
  assertEquals(parseNotionId("just-a-string"), null);
});

// ── CLI subprocess tests ──────────────────────────────────────────────────────

Deno.test("CLI exits 1 with error when NOTION_TOKEN is unset", async () => {
  const result = await new Deno.Command("deno", {
    args: [
      "run",
      "--allow-env=NOTION_TOKEN",
      "--allow-net=api.notion.com",
      scriptPath,
      "page",
      "https://www.notion.so/abc1234567890abcdef1234567890ab",
    ],
    env: { ...Deno.env.toObject(), NOTION_TOKEN: "" },
  }).output();
  assertEquals(result.code, 1);
  assertEquals(
    new TextDecoder().decode(result.stderr).trim(),
    "error: NOTION_TOKEN is not set",
  );
});

Deno.test("CLI exits 1 with usage on no arguments", async () => {
  const result = await new Deno.Command("deno", {
    args: [
      "run",
      "--allow-env=NOTION_TOKEN",
      "--allow-net=api.notion.com",
      scriptPath,
    ],
    env: { ...Deno.env.toObject(), NOTION_TOKEN: "secret_test" },
  }).output();
  assertEquals(result.code, 1);
  assert(new TextDecoder().decode(result.stderr).includes("usage:"));
});

Deno.test("CLI exits 1 with usage on unrecognized subcommand", async () => {
  const result = await new Deno.Command("deno", {
    args: [
      "run",
      "--allow-env=NOTION_TOKEN",
      "--allow-net=api.notion.com",
      scriptPath,
      "unknown",
      "arg",
    ],
    env: { ...Deno.env.toObject(), NOTION_TOKEN: "secret_test" },
  }).output();
  assertEquals(result.code, 1);
  assert(new TextDecoder().decode(result.stderr).includes("usage:"));
});

Deno.test("CLI exits 1 with error for unparseable URL", async () => {
  const result = await new Deno.Command("deno", {
    args: [
      "run",
      "--allow-env=NOTION_TOKEN",
      "--allow-net=api.notion.com",
      scriptPath,
      "page",
      "https://www.notion.so/no-hex-here",
    ],
    env: { ...Deno.env.toObject(), NOTION_TOKEN: "secret_test" },
  }).output();
  assertEquals(result.code, 1);
  assertEquals(
    new TextDecoder().decode(result.stderr).trim(),
    "error: could not parse Notion ID from URL: https://www.notion.so/no-hex-here",
  );
});

// ── richTextToMarkdown ────────────────────────────────────────────────────────

function makeRichText(
  text: string,
  bold = false,
  italic = false,
): RichTextItemResponse {
  return {
    type: "text",
    text: { content: text, link: null },
    annotations: {
      bold,
      italic,
      strikethrough: false,
      underline: false,
      code: false,
      color: "default",
    },
    plain_text: text,
    href: null,
  };
}

Deno.test("richTextToMarkdown — plain text", () => {
  assertEquals(richTextToMarkdown([makeRichText("hello")]), "hello");
});

Deno.test("richTextToMarkdown — bold wraps in **", () => {
  assertEquals(
    richTextToMarkdown([makeRichText("world", true)]),
    "**world**",
  );
});

Deno.test("richTextToMarkdown — italic wraps in _", () => {
  assertEquals(
    richTextToMarkdown([makeRichText("hi", false, true)]),
    "_hi_",
  );
});

Deno.test("richTextToMarkdown — multiple segments concatenated", () => {
  assertEquals(
    richTextToMarkdown([makeRichText("Hello "), makeRichText("world", true)]),
    "Hello **world**",
  );
});

// ── blockToMarkdown ───────────────────────────────────────────────────────────

Deno.test("blockToMarkdown — paragraph", () => {
  const block = {
    type: "paragraph",
    paragraph: { rich_text: [makeRichText("Content")], color: "default" },
  } as unknown as BlockObjectResponse;
  assertEquals(blockToMarkdown(block), "Content");
});

Deno.test("blockToMarkdown — heading_1", () => {
  const block = {
    type: "heading_1",
    heading_1: {
      rich_text: [makeRichText("Title")],
      color: "default",
      is_toggleable: false,
    },
  } as unknown as BlockObjectResponse;
  assertEquals(blockToMarkdown(block), "# Title");
});

Deno.test("blockToMarkdown — heading_2", () => {
  const block = {
    type: "heading_2",
    heading_2: {
      rich_text: [makeRichText("Sub")],
      color: "default",
      is_toggleable: false,
    },
  } as unknown as BlockObjectResponse;
  assertEquals(blockToMarkdown(block), "## Sub");
});

Deno.test("blockToMarkdown — heading_3", () => {
  const block = {
    type: "heading_3",
    heading_3: {
      rich_text: [makeRichText("Sub")],
      color: "default",
      is_toggleable: false,
    },
  } as unknown as BlockObjectResponse;
  assertEquals(blockToMarkdown(block), "### Sub");
});

Deno.test("blockToMarkdown — bulleted_list_item", () => {
  const block = {
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: [makeRichText("item")],
      color: "default",
    },
  } as unknown as BlockObjectResponse;
  assertEquals(blockToMarkdown(block), "- item");
});

Deno.test("blockToMarkdown — numbered_list_item", () => {
  const block = {
    type: "numbered_list_item",
    numbered_list_item: {
      rich_text: [makeRichText("item")],
      color: "default",
    },
  } as unknown as BlockObjectResponse;
  assertEquals(blockToMarkdown(block), "1. item");
});

Deno.test("blockToMarkdown — code with language", () => {
  const block = {
    type: "code",
    code: {
      rich_text: [makeRichText("const x = 1;")],
      language: "typescript",
      caption: [],
    },
  } as unknown as BlockObjectResponse;
  assertEquals(
    blockToMarkdown(block),
    "```typescript\nconst x = 1;\n```",
  );
});

Deno.test("blockToMarkdown — quote", () => {
  const block = {
    type: "quote",
    quote: { rich_text: [makeRichText("quoted")], color: "default" },
  } as unknown as BlockObjectResponse;
  assertEquals(blockToMarkdown(block), "> quoted");
});

Deno.test("blockToMarkdown — divider", () => {
  const block = {
    type: "divider",
    divider: {},
  } as unknown as BlockObjectResponse;
  assertEquals(blockToMarkdown(block), "---");
});

Deno.test("blockToMarkdown — child_page emits link with page title", () => {
  const block = {
    type: "child_page",
    id: "abc12345-6789-0abc-def1-234567890abc",
    child_page: { title: "Child Page" },
  } as unknown as BlockObjectResponse;
  assertEquals(
    blockToMarkdown(block),
    "[Child Page](https://www.notion.so/abc12345-6789-0abc-def1-234567890abc)",
  );
});

Deno.test("blockToMarkdown — unknown type returns empty string", () => {
  const block = { type: "unsupported_xyz" } as unknown as BlockObjectResponse;
  assertEquals(blockToMarkdown(block), "");
});

// ── runPage ───────────────────────────────────────────────────────────────────

function makeRich(text: string) {
  return makeRichText(text);
}

function makeParagraphBlock(text: string, hasChildren = false) {
  return {
    type: "paragraph",
    id: `block-${text}`,
    has_children: hasChildren,
    paragraph: { rich_text: [makeRich(text)], color: "default" },
  };
}

function makePageResponse(title: string) {
  return {
    properties: {
      Title: {
        type: "title",
        title: [makeRich(title)],
      },
    },
  };
}

Deno.test("runPage — outputs title as H1 followed by block content", async () => {
  const client = {
    pages: { retrieve: () => Promise.resolve(makePageResponse("My Page")) },
    blocks: {
      children: {
        list: () =>
          Promise.resolve({
            results: [makeParagraphBlock("First paragraph")],
            has_more: false,
            next_cursor: null,
          }),
      },
    },
  } as unknown as Client;

  const output = await runPage(client, "some-id");
  assert(output.startsWith("# My Page"));
  assert(output.includes("First paragraph"));
});

Deno.test("runPage — paginates blocks across multiple API responses", async () => {
  let calls = 0;
  const client = {
    pages: { retrieve: () => Promise.resolve(makePageResponse("Paged")) },
    blocks: {
      children: {
        list: () => {
          calls++;
          return Promise.resolve({
            results: calls === 1
              ? [makeParagraphBlock("page1")]
              : [makeParagraphBlock("page2")],
            has_more: calls === 1,
            next_cursor: calls === 1 ? "cursor" : null,
          });
        },
      },
    },
  } as unknown as Client;

  const output = await runPage(client, "some-id");
  assert(output.includes("page1"));
  assert(output.includes("page2"));
  assertEquals(calls, 2);
});

Deno.test("runPage — appends truncation comment when blocks exceed 500", async () => {
  const client = {
    pages: { retrieve: () => Promise.resolve(makePageResponse("Big Page")) },
    blocks: {
      children: {
        list: () =>
          Promise.resolve({
            results: Array(100).fill(null).map((_, i) =>
              makeParagraphBlock(`block-${i}`)
            ),
            has_more: true,
            next_cursor: "cursor",
          }),
      },
    },
  } as unknown as Client;

  const output = await runPage(client, "some-id");
  assert(output.includes("<!-- truncated: block limit reached -->"));
});

Deno.test("runPage — propagates API errors for caller to handle", async () => {
  const client = {
    pages: {
      retrieve: () => Promise.reject({ status: 404, message: "Not found" }),
    },
    blocks: { children: { list: () => Promise.resolve({}) } },
  } as unknown as Client;

  let threw = false;
  try {
    await runPage(client, "bad-id");
  } catch {
    threw = true;
  }
  assert(threw);
});

// ── propertyToString ──────────────────────────────────────────────────────────

Deno.test("propertyToString — title", () => {
  assertEquals(
    propertyToString({ type: "title", title: [makeRich("My Title")] }),
    "My Title",
  );
});

Deno.test("propertyToString — rich_text", () => {
  assertEquals(
    propertyToString({
      type: "rich_text",
      rich_text: [makeRich("some text")],
    }),
    "some text",
  );
});

Deno.test("propertyToString — number", () => {
  assertEquals(propertyToString({ type: "number", number: 42 }), "42");
});

Deno.test("propertyToString — number null", () => {
  assertEquals(propertyToString({ type: "number", number: null }), "");
});

Deno.test("propertyToString — select", () => {
  assertEquals(
    propertyToString({ type: "select", select: { name: "Option A" } }),
    "Option A",
  );
});

Deno.test("propertyToString — select null", () => {
  assertEquals(propertyToString({ type: "select", select: null }), "");
});

Deno.test("propertyToString — multi_select", () => {
  assertEquals(
    propertyToString({
      type: "multi_select",
      multi_select: [{ name: "A" }, { name: "B" }],
    }),
    "A, B",
  );
});

Deno.test("propertyToString — date", () => {
  assertEquals(
    propertyToString({
      type: "date",
      date: { start: "2026-01-01", end: null },
    }),
    "2026-01-01",
  );
});

Deno.test("propertyToString — checkbox true", () => {
  assertEquals(propertyToString({ type: "checkbox", checkbox: true }), "true");
});

Deno.test("propertyToString — unsupported type returns empty string", () => {
  assertEquals(propertyToString({ type: "formula" }), "");
});

// ── databaseToMarkdown ────────────────────────────────────────────────────────

Deno.test("databaseToMarkdown — renders header row and data row", () => {
  const headers = ["Name", "Status"];
  const rows = [["Alpha", "Done"], ["Beta", ""]];
  const md = databaseToMarkdown(headers, rows);
  const lines = md.split("\n");
  assert(lines[0].includes("Name"));
  assert(lines[0].includes("Status"));
  assert(lines[2].includes("Alpha"));
  assert(lines[3].includes("Beta"));
});

// ── runDatabase ───────────────────────────────────────────────────────────────

Deno.test("runDatabase — renders title H1 and property table", async () => {
  const client = {
    databases: {
      retrieve: () =>
        Promise.resolve({
          title: [makeRich("My DB")],
          properties: { Name: { type: "title" }, Status: { type: "select" } },
        }),
      query: () =>
        Promise.resolve({
          results: [
            {
              properties: {
                Name: { type: "title", title: [makeRich("Row 1")] },
                Status: { type: "select", select: { name: "Active" } },
              },
            },
          ],
          has_more: false,
          next_cursor: null,
        }),
    },
  } as unknown as Client;

  const output = await runDatabase(client, "db-id");
  assert(output.startsWith("# My DB"));
  assert(output.includes("Row 1"));
});

Deno.test("runDatabase — appends truncation comment when rows exceed 500", async () => {
  const client = {
    databases: {
      retrieve: () =>
        Promise.resolve({
          title: [makeRich("Big DB")],
          properties: { Name: { type: "title" } },
        }),
      query: () =>
        Promise.resolve({
          results: Array(100).fill({
            properties: {
              Name: { type: "title", title: [makeRich("r")] },
            },
          }),
          has_more: true,
          next_cursor: "cursor",
        }),
    },
  } as unknown as Client;

  const output = await runDatabase(client, "db-id");
  assert(output.includes("<!-- truncated: row limit reached -->"));
});

// ── searchResultsToMarkdown ───────────────────────────────────────────────────

Deno.test("searchResultsToMarkdown — formats each result as a list item", () => {
  const results = [
    {
      object: "page",
      id: "abc12345-6789-0abc-def1-234567890abc",
      properties: { title: { type: "title", title: [makeRich("My Page")] } },
    },
    {
      object: "database",
      id: "def12345-6789-0abc-def1-234567890abc",
      title: [makeRich("My DB")],
    },
  ];
  const md = searchResultsToMarkdown(results);
  assert(
    md.includes(
      "[My Page](https://www.notion.so/abc12345-6789-0abc-def1-234567890abc) (page)",
    ),
  );
  assert(
    md.includes(
      "[My DB](https://www.notion.so/def12345-6789-0abc-def1-234567890abc) (database)",
    ),
  );
});

// ── runSearch ─────────────────────────────────────────────────────────────────

Deno.test("runSearch — returns empty message when no results", async () => {
  const client = {
    search: () =>
      Promise.resolve({
        results: [],
        has_more: false,
        next_cursor: null,
      }),
  } as unknown as Client;

  const output = await runSearch(client, "nothing");
  assertEquals(output, "No results found for query: nothing");
});

Deno.test("runSearch — paginates until has_more is false", async () => {
  let calls = 0;
  const client = {
    search: () => {
      calls++;
      return Promise.resolve({
        results: [
          {
            object: "page",
            id: "abc12345-6789-0abc-def1-234567890abc",
            properties: {
              title: { type: "title", title: [makeRich(`result-${calls}`)] },
            },
          },
        ],
        has_more: calls < 2,
        next_cursor: calls < 2 ? "cursor" : null,
      });
    },
  } as unknown as Client;

  const output = await runSearch(client, "query");
  assert(output.includes("result-1"));
  assert(output.includes("result-2"));
  assertEquals(calls, 2);
});

Deno.test("runSearch — appends truncation comment when results exceed 20", async () => {
  const client = {
    search: () =>
      Promise.resolve({
        results: Array(20).fill({
          object: "page",
          id: "abc12345-6789-0abc-def1-234567890abc",
          properties: {
            title: { type: "title", title: [makeRich("r")] },
          },
        }),
        has_more: true,
        next_cursor: "cursor",
      }),
  } as unknown as Client;

  const output = await runSearch(client, "query");
  assert(output.includes("<!-- truncated: result limit reached -->"));
});

// ── markdownToBlocks ──────────────────────────────────────────────────────────

Deno.test("markdownToBlocks — empty string returns empty array", () => {
  assertEquals(markdownToBlocks(""), []);
});

Deno.test("markdownToBlocks — blank lines are skipped", () => {
  assertEquals(markdownToBlocks("\n\n\n"), []);
});

Deno.test("markdownToBlocks — paragraph block", () => {
  const blocks = markdownToBlocks("Hello world");
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, "paragraph");
});

Deno.test("markdownToBlocks — heading_1 block", () => {
  const blocks = markdownToBlocks("# Title");
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, "heading_1");
});

Deno.test("markdownToBlocks — heading_2 block", () => {
  const blocks = markdownToBlocks("## Sub");
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, "heading_2");
});

Deno.test("markdownToBlocks — heading_3 block", () => {
  const blocks = markdownToBlocks("### Sub-sub");
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, "heading_3");
});

Deno.test("markdownToBlocks — bulleted list item", () => {
  const blocks = markdownToBlocks("- item one");
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, "bulleted_list_item");
});

Deno.test("markdownToBlocks — numbered list item", () => {
  const blocks = markdownToBlocks("1. first");
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, "numbered_list_item");
});

Deno.test("markdownToBlocks — block quote", () => {
  const blocks = markdownToBlocks("> quoted text");
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, "quote");
});

Deno.test("markdownToBlocks — divider", () => {
  const blocks = markdownToBlocks("---");
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, "divider");
});

Deno.test("markdownToBlocks — fenced code block with language", () => {
  const blocks = markdownToBlocks("```typescript\nconst x = 1;\n```");
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, "code");
  const code = blocks[0].code as { language: string };
  assertEquals(code.language, "typescript");
});

// ── runCreate ─────────────────────────────────────────────────────────────────

Deno.test("runCreate — calls pages.create and returns new page URL", async () => {
  const client = {
    pages: {
      create: () => Promise.resolve({ id: "newpage123456789012345678901234" }),
    },
  } as unknown as Client;

  const url = await runCreate(
    client,
    "https://www.notion.so/abc1234567890abcdef1234567890ab",
    "My Document",
  );
  assert(url.startsWith("https://www.notion.so/"));
  assert(url.includes("newpage"));
});

Deno.test("runCreate — throws when parent URL is unparseable", async () => {
  const client = {} as unknown as Client;
  await assertRejects(
    () => runCreate(client, "https://www.notion.so/no-hex-here", "Title"),
    Error,
    "could not parse Notion ID from URL",
  );
});

// ── runAppend ─────────────────────────────────────────────────────────────────

Deno.test("runAppend — converts markdown to blocks and calls append", async () => {
  let appendedBlocks: unknown[] = [];
  const client = {
    blocks: {
      children: {
        append: (args: { children: unknown[] }) => {
          appendedBlocks = args.children;
          return Promise.resolve({});
        },
      },
    },
  } as unknown as Client;

  await runAppend(
    client,
    "https://www.notion.so/abc1234567890abcdef1234567890ab",
    "# Hello\n\nWorld",
  );
  assert(appendedBlocks.length > 0);
});

Deno.test("runAppend — throws when page URL is unparseable", async () => {
  const client = {} as unknown as Client;
  await assertRejects(
    () =>
      runAppend(
        client,
        "https://www.notion.so/no-hex-here",
        "# Hello\n\nWorld",
      ),
    Error,
    "could not parse Notion ID from URL",
  );
});

// ── CLI: new subcommands ──────────────────────────────────────────────────────

Deno.test("CLI exits 1 with usage on create with missing title", async () => {
  const result = await new Deno.Command("deno", {
    args: [
      "run",
      "--allow-env=NOTION_TOKEN",
      "--allow-net=api.notion.com",
      scriptPath,
      "create",
      "https://www.notion.so/abc1234567890abcdef1234567890ab",
    ],
    env: { ...Deno.env.toObject(), NOTION_TOKEN: "secret_test" },
  }).output();
  assertEquals(result.code, 1);
  assert(new TextDecoder().decode(result.stderr).includes("usage:"));
});

// ── inline formatting ─────────────────────────────────────────────────────────

Deno.test("toRich — plain text is one unannotated segment", () => {
  assertEquals(toRich("plain"), [{ type: "text", text: { content: "plain" } }]);
});

Deno.test("toRich — bold, code, italic and link become annotated segments", () => {
  const segments = toRich(
    "a **bold** b `code` c _italic_ d [site](https://example.com)",
  );
  assertEquals(
    segments.map((s) => s.text.content),
    ["a ", "bold", " b ", "code", " c ", "italic", " d ", "site"],
  );
  assertEquals(segments[1].annotations, { bold: true });
  assertEquals(segments[3].annotations, { code: true });
  assertEquals(segments[5].annotations, { italic: true });
  assertEquals(segments[7].text.link, { url: "https://example.com" });
});

Deno.test("toRich — snake_case identifiers are not italicised", () => {
  const segments = toRich("user_view_pk and user_problem");
  assertEquals(segments.length, 1);
  assertEquals(segments[0].annotations, undefined);
});

Deno.test("markdownToBlocks — inline markers do not appear in block text", () => {
  const blocks = markdownToBlocks("- **Key**: `value`");
  const richText = (blocks[0].bulleted_list_item as {
    rich_text: { text: { content: string } }[];
  }).rich_text;
  assertEquals(richText.map((r) => r.text.content), ["Key", ": ", "value"]);
});

Deno.test("markdownToBlocks — pipe table becomes a table block with header row", () => {
  const blocks = markdownToBlocks(
    "| Column | Type |\n|---|---|\n| `pk` | bigserial |\n| a \\| b | text |",
  );
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, "table");
  const table = blocks[0].table as {
    table_width: number;
    has_column_header: boolean;
    children: { table_row: { cells: { text: { content: string } }[][] } }[];
  };
  assertEquals(table.table_width, 2);
  assert(table.has_column_header);
  assertEquals(table.children.length, 3);
  assertEquals(table.children[2].table_row.cells[0][0].text.content, "a | b");
});

Deno.test("markdownToBlocks — paragraph before a table stays separate", () => {
  const blocks = markdownToBlocks("Intro\n| A | B |\n|---|---|\n| 1 | 2 |");
  assertEquals(blocks.map((b) => b.type), ["paragraph", "table"]);
});

// ── runReplace ────────────────────────────────────────────────────────────────

function replaceClient(existing: { id: string; type: string }[]) {
  const calls: string[] = [];
  const client = {
    blocks: {
      children: {
        list: () => Promise.resolve({ results: existing, has_more: false }),
        append: () => {
          calls.push("append");
          return Promise.resolve({});
        },
      },
      delete: ({ block_id }: { block_id: string }) => {
        calls.push(`delete:${block_id}`);
        return Promise.resolve({});
      },
    },
    pages: {
      update: () => {
        calls.push("rename");
        return Promise.resolve({});
      },
    },
  } as unknown as Client;
  return { client, calls };
}

const PAGE_URL = "https://www.notion.so/abc1234567890abcdef1234567890ab";

Deno.test("runReplace — appends new content before deleting old blocks, sparing child pages", async () => {
  const { client, calls } = replaceClient([
    { id: "old-1", type: "paragraph" },
    { id: "child", type: "child_page" },
    { id: "old-2", type: "heading_2" },
  ]);
  await runReplace(client, PAGE_URL, "# New");
  assertEquals(calls, ["append", "delete:old-1", "delete:old-2"]);
});

Deno.test("runReplace — renames the page when a title is given", async () => {
  const { client, calls } = replaceClient([]);
  await runReplace(client, PAGE_URL, "# New", "Phase 9: Title");
  assertEquals(calls, ["append", "rename"]);
});

Deno.test("runReplace — refuses empty markdown and leaves the page untouched", async () => {
  const { client, calls } = replaceClient([{ id: "old", type: "paragraph" }]);
  await assertRejects(
    () => runReplace(client, PAGE_URL, "\n\n"),
    Error,
    "empty Markdown",
  );
  assertEquals(calls, []);
});

Deno.test("toRich — inline code inside bold keeps both annotations", () => {
  const segments = toRich("**`resolution`**: done");
  assertEquals(segments[0].text.content, "resolution");
  assertEquals(segments[0].annotations, { code: true, bold: true });
  assertEquals(segments[1].text.content, ": done");
});
