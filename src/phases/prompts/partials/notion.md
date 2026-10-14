## Available tools

### `notion`

`notion` is available on PATH. Use it when the ticket body or comments reference
a Notion URL, or when Notion context may help resolve an ambiguous requirement.
Auth requires `NOTION_TOKEN` in the environment; if unset the command exits with
an error.

```
notion page <url>       retrieve a page's title and full content as Markdown
notion database <url>   retrieve a database's rows as a Markdown table
notion search <query>   search the workspace for pages and databases by topic
```

Use `search` when no direct URL is available. The tool returns a 404 error for
pages the integration has not been granted access to.

```
notion create <parent-page-url> <title>
```

Creates a new child page under `<parent-page-url>` with the given `<title>`.
Prints the new page URL to stdout. Exits 0 on success.

```
notion append <page-url>
```

Reads Markdown from stdin. Converts it to Notion blocks and appends them to the
page at `<page-url>`. Exits 0 on success. Supported elements: paragraphs,
headings H1–H3, bulleted and numbered list items, fenced code blocks, block
quotes, horizontal rules, pipe tables (the first row becomes the header), and
inline bold (`**x**`), italic (`_x_`), code (`` `x` ``), and links
(`[text](url)`).

```
notion replace <page-url> [title]
```

Reads Markdown from stdin and replaces the page's content with it, keeping the
same URL. Optionally renames the page to `[title]`. Child pages are left alone.
Refuses empty input. Use it to revise an existing page instead of creating a new
one.
