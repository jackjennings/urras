You are analyzing an implementation session that was flagged as an outlier: the
number of turns significantly exceeded the plan's task count.

You have been given:

- The ticket directory (containing `log.ndjson`, `*-plan.md`, and
  `*-implementation.usage.json`)
- The ticket ID
- The lazyboy worktree (containing `src/phases/prompts/`)
- The state directory (where learnings are queued)

Follow these steps:

1. Read `log.ndjson` from the ticket directory. Find the `phase-end` entry where
   `phase` is `"implementation"` and extract its `sessionId`.

2. Search `~/.claude/projects/` for NDJSON files whose content references that
   session ID. Look for a file containing `"session_id": "<sessionId>"` or
   `"id": "<sessionId>"`. If no transcript is found, skip to step 4.

3. When the transcript is available, parse each line as JSON and collect every
   `tool_use` event. Group by `(name, path_argument)` where `path_argument` is
   the first string argument that looks like a file path. Identify the dominant
   pattern: fragmented edits (many Edit calls against one file), redundant reads
   (same file read more than three times), or retry loops (repeated identical
   tool calls). Note the plan task or section that correlates with the spike.

4. Read the most recent `*-plan.md` from the ticket directory. Read the
   implementation prompt at `src/phases/prompts/implementation.md` (and
   `src/phases/prompts/plan.md` if the pattern implicates the plan phase).
   Identify the missing or imprecise instruction that allowed the inefficient
   pattern.

5. Decide on a single, minimal instruction that should be added to one file in
   `src/phases/prompts/` to prevent recurrence. Do not edit the file — describe
   the instruction in prose. Examples:
   - Enumerate all call sites before making edits when changing a function
     signature.
   - Use a scripted pass (`sed -i`) for repetitive same-file changes rather than
     repeated Edit calls.
   - Read a file once and hold its content in memory rather than re-reading it
     on each edit.

   Make the instruction concrete and actionable; avoid vague directives.

   Write the improvement as a language-agnostic principle; abstract any
   project-specific tool name to a generic equivalent (e.g. "the project's test
   runner", not "deno task test"; "the project's formatter", not "deno fmt").

6. Write a learning entry to `<State directory>/learnings/<YYYYMMDDTHHMMSS>.md`
   using the current UTC time for the filename slug. The file is Markdown with
   YAML frontmatter. The frontmatter must have exactly these fields, and the
   Markdown body is the intent — the natural-language description of the
   instruction to add and why, from step 5 (not file content):

   ```markdown
   ---
   id: "<YYYYMMDDTHHMMSS>"
   ticketId: "<ticket ID from context>"
   repo: jackjennings/lazyboy
   targetFile: "<repo-relative path of the prompt file the instruction belongs in, e.g. src/phases/prompts/implementation.md>"
   ---

   <natural-language description of the instruction to add and why, from step 5>
   ```

   The body is a description, not file content. The next tick applies it: an LLM
   integrates the instruction into `targetFile` at the appropriate location and
   opens the draft PR. Do not run `git` or `gh` commands and do not edit any
   prompt file yourself.

7. Write your findings to `<YYYYMMDDTHHMMSS>-outlier-analysis.md` in the ticket
   directory. Include: the turns/task_count ratio, the identified pattern, the
   root cause, and the intent of the instruction you recorded.

If the transcript was unavailable, base your analysis on the turns/task_count
ratio and the plan structure alone. You may propose a general improvement (e.g.
requiring explicit enumeration of all call sites for any rename task) rather
than a specific diagnosis. Still write the learning entry and the findings file.

Write only the learning entry and the findings file. Do not edit any prompt file
in the lazyboy worktree, and do not run any version control or `gh` CLI
commands.
