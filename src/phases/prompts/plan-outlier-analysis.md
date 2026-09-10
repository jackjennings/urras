You are analyzing a plan session that was flagged as an outlier: the number of
turns significantly exceeded the spec's criterion count.

You have been given:

- The ticket directory (containing `log.ndjson`, `*-spec.md`, and
  `*-plan.usage.json`)
- The ticket ID
- The lazyboy worktree (containing `src/phases/prompts/`)
- The state directory (where learnings are queued)

Follow these steps:

1. Read `log.ndjson` from the ticket directory. Find the `phase-end` entry where
   `phase` is `"plan"` and extract its `sessionId`.

2. Search `~/.claude/projects/` for NDJSON files whose content references that
   session ID. Look for a file containing `"session_id": "<sessionId>"` or
   `"id": "<sessionId>"`. If no transcript is found, skip to step 4.

3. When the transcript is available, parse each line as JSON and collect every
   `tool_use` event. Group by `(name, path_argument)` where `path_argument` is
   the first string argument that looks like a file path. Identify the dominant
   waste pattern among:

   - Redundant reads: same spec, enrichment, or meta file read more than twice
   - Iterative rewrites: the same section of the plan output file edited more
     than twice
   - Repeated model selection: the `phases.implementation.model` or `thinking`
     field in `meta.md` changed more than once

4. Read the most recent `*-spec.md` from the ticket directory. Read
   `src/phases/prompts/plan.md` from the lazyboy worktree. Identify the missing
   or imprecise instruction that allowed the waste pattern.

5. Decide on a single, minimal instruction that should be added to
   `src/phases/prompts/plan.md` to prevent recurrence. Do not edit the file —
   describe the instruction in prose. Examples:

   - Add an instruction to read each reference file exactly once and hold its
     content in memory rather than re-reading on each section.
   - Add an instruction to commit the model/thinking selection after the first
     survey of the spec and not revisit it.
   - Add an instruction to write the full plan in one pass once all input files
     have been read, rather than iterating section by section.

   Make the instruction concrete and actionable; avoid vague directives.

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
   targetFile: "<repo-relative path of the prompt file the instruction belongs in, e.g. src/phases/prompts/plan.md>"
   ---

   <natural-language description of the instruction to add and why, from step 5>
   ```

   The body is a description, not file content. The next tick applies it: an LLM
   integrates the instruction into `targetFile` at the appropriate location and
   opens the draft PR. Do not run `git` or `gh` commands and do not edit any
   prompt file yourself.

7. Write your findings to `<YYYYMMDDTHHMMSS>-plan-outlier-analysis.md` in the
   ticket directory. Include: the turns/criterionCount ratio, the identified
   pattern, the root cause, and the intent of the instruction recorded.

If the transcript was unavailable, base your analysis on the
turns/criterionCount ratio and the plan structure alone. You may propose a
general improvement rather than a specific diagnosis. Still write the learning
entry and the findings file.

Write only the learning entry and the findings file. Do not edit any prompt file
in the lazyboy worktree, and do not run any version control or `gh` CLI
commands.
