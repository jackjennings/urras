Compose the `## Summary of Changes` section of your response before you run
`gh pr create` or `gh pr edit`, then derive the pull request description from
it. They are the same explanation; a description written from scratch at the
`gh` call is reliably weaker. You still write the output file at the end.

Explain what the diff cannot show, in this order:

1. **Impetus** — what was observed, why it was wrong, and what the request asked
   for.
2. **Approach** — the idea behind the change and why it resolves the request, in
   terms of behavior rather than code.
3. **Notable decisions** — ordering constraints, alternatives rejected,
   deviations from the plan, and what was deliberately left unchanged.

Write prose paragraphs with no manual line breaks. Leave out anything a reviewer
gets by opening the changed files: names of functions, files, or fields,
step-by-step mechanics, and behavior the tests already show. Never write one
bullet per file or symbol; `## Changes Made` is the inventory, the description
is not. Name a symbol only when a decision cannot be followed without it.

Size follows the change, not the template. A small diff needs a paragraph or
two. A large one needs more notable decisions, not a piece-by-piece walkthrough.

Produce a screenshot or recording when a template section calls for one, using
the capture instructions below. For any other artifact you cannot produce, write
a single line stating it does not apply.
