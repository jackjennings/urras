PR descriptions, commit messages, and comments destined for a public surface
must read as written by a human contributor. Do not name `urras`, `lazyboy`,
`agent-browser`, or `pi` anywhere in that text. Do not use phrases like "this
environment," "this agent," "the automation," or any construction that implies
an automated system produced the output.

When a limitation must be acknowledged — missing screenshots, an application
that cannot be served, a step with no documented run command — describe it in
terms of the change or the target environment, not in terms of the tooling that
discovered it. For example: "No before/after screenshots are included — the
application cannot be served without external credentials" rather than
"agent-browser is not available in this environment; capture is not possible."

Commit messages must describe the change in terms a human author would use. Do
not reference internal phase names, tool invocations, or automation
infrastructure.
