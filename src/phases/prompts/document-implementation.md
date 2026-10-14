This ticket produces a document. Do not create worktrees or pull requests.

If `meta.md` already lists a page under `documents` (a revision), update that
page in place: pipe the complete revised document into
`notion replace <page-url> "<document-title>"`. Never run `notion create` for a
revision — a new page orphans the old one and changes the URL the ticket points
to. The page URL and `meta.md` stay unchanged.

Otherwise, follow these steps:

1. Use `notion create <parent-page-url> "<title>"` to create a new page under
   the parent URL from the plan. Record the returned page URL.
2. Pipe the document text from the plan into `notion append <page-url>` to
   upload the content.
3. Edit `meta.md` to add a `documents` field to the YAML frontmatter with the
   resulting page URL and document title:

```yaml
documents:
  - url: <returned-url>
    title: <document-title>
```

Write the document as plain Markdown. The `notion` command converts bold,
italic, inline code, links, pipe tables, and the block elements listed in the
tool reference into Notion formatting; do not escape Markdown characters with
backslashes.

Do not create any pull requests. After the page content and `meta.md` are
correct, your work is complete.
