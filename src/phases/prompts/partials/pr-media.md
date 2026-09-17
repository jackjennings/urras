When the change alters what a user sees, capture before/after evidence and embed
it in the description. A sentence describing what a reviewer would have seen is
not evidence.

Check for the capture tool before planning any of this:

```
command -v agent-browser
```

If that prints nothing the tool is unavailable on this host — skip capture and
do not install it. When it is present:

1. Serve the application the way this repository documents. If no documented way
   to run it exists, or it cannot run without credentials or services you do not
   have, skip capture.
2. `agent-browser open <url>`, then drive the UI to the state the change
   affects. `agent-browser snapshot -i` lists interactive elements as `@eN`
   refs; `agent-browser click @e1` and `agent-browser fill @e2 "text"` take
   those refs.
3. Capture the after state: `agent-browser screenshot /tmp/<slug>-after.png`.
   Use video only when the change is in the transition rather than the end state
   — `agent-browser record start /tmp/<slug>-after.webm`, drive the UI, then
   `agent-browser record stop`.
4. Capture the before state from the base revision, never from uncommitted work.
   Your changes are already committed at this point: confirm
   `git status --porcelain` is empty,
   `git switch --detach origin/<base branch>`, restart or reload the
   application, capture to `/tmp/<slug>-before.png`, then `git switch -` to
   return to the ticket branch. Omit the before capture when the change adds a
   surface that did not previously exist.
5. Compose the PR body with Markdown image references using the captured local
   absolute paths, then invoke `gh pr create` or `gh pr edit` with `--attach`
   for each file. Use Markdown image syntax —
   `![before](/tmp/<slug>-before.png)` and `![after](/tmp/<slug>-after.png)` —
   not HTML `<img>` tags. The path in each Markdown reference must be the exact
   absolute path passed to the corresponding `--attach` flag; `gh` rewrites each
   matching reference in the body to the uploaded GitHub URL. Insertion order in
   the body determines which URL replaces which reference.

   **On the create path** (`gh pr create`):

   ```
   gh pr create --body "<body with local-path img references>" \
     --attach /tmp/<slug>-before.png \
     --attach /tmp/<slug>-after.png
   ```

   **On the revision path** (`gh pr edit`):

   ```
   gh pr edit <pr-url> \
     --body "<body with local-path img references>" \
     --attach /tmp/<slug>-before.png \
     --attach /tmp/<slug>-after.png
   ```

   `--body` and `--attach` are combined in one call. The `--attach` flag
   rewrites local-path references in the new body string, not in the existing PR
   body.

An uploaded asset is readable by everyone who can read the repository. Never
capture real customer data; use synthetic or test data only.

Fall back when the tool is absent, the application cannot be served here, or the
change has no user-visible effect: write a single line in that section stating
that, and delete any before/after table the template provides. Never substitute
prose for the artifact — a table holding sentences where images belong reads as
a fabricated screenshot.
