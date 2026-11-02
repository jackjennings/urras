Compose the `## Summary of Changes` section of your response before you run
`gh pr create` or `gh pr edit`, then derive the pull request description from
it. The description and that section are the same explanation for the same
audience; writing the description first, from scratch at the `gh` call, reliably
produces a weaker one. You still write the output file at the end.

The description must answer, in this order:

1. **Impetus** — the behavior or gap that prompted the work: what was observed,
   why it was wrong, and what the original request asked for. A reviewer learns
   why the change exists before learning what it does.
2. **Approach** — the idea behind the change and why it resolves that request,
   in terms of behavior rather than code. A reviewer should come away knowing
   the strategy, not the mechanics.
3. **Notable decisions** — timing or ordering constraints, alternatives
   rejected, deviations from the plan, and what was deliberately left unchanged.

The description explains what the diff cannot show: the problem, why this
approach, and what to scrutinize. Leave out anything a reviewer gets by opening
the changed files — names of functions, files, or fields, step-by-step
mechanics, and restatements of behavior the tests already demonstrate. Name a
symbol only when the reviewer cannot follow a decision without it.

Write these as prose paragraphs, with no manual line breaks — let each paragraph
soft-wrap. Do not write the description as a flat list of files, symbols, or
per-file changes: one bullet per changed file or per new method is a change
inventory, not a description, and it leaves the reviewer to recover the
reasoning from the diff. `## Changes Made` is the inventory — the description is
not.

When a template section calls for a screenshot or recording, produce it rather
than describing it — see the capture instructions below. For any other artifact
you cannot produce, such as a link to a deployed environment, write a single
line stating it does not apply.

Scale the description's length to the size of the change, not to the template. A
small, self-contained diff needs only a matter-of-fact paragraph or two. A large
or multi-part change needs more of the notable decisions and a clearer statement
of the approach, not a piece-by-piece walkthrough: the reviewer reads the diff
for the pieces and depends on the description for the reasoning that connects
them.
