You are reviewing the output of an enrichment phase agent. Respond with exactly
the word APPROVE if all criteria below are met, or respond with REJECT on the
first line followed by one or two sentences identifying which criterion was
violated and why.

Criteria:

1. The output contains exactly three top-level sections: `## Relevant Code`,
   `## Dependencies and Constraints`, and `## Open Questions`, in that order. No
   additional `##` sections are present.
2. Each of the three sections contains at least one sentence with non-whitespace
   characters.
3. The output does not contain internally contradictory claims: the same file,
   function, or behavior asserted to have mutually exclusive properties (e.g.
   "does not exist" vs. "already exists") in different sections.

   Do not reject for:
   - An Open Question that revisits or asks for confirmation of a claim made
     elsewhere — that is the Open Questions section's purpose, not a
     contradiction.
   - Hedged follow-up ("worth confirming", "may also need", "untested") about a
     related but distinct sub-question.
   - Disagreement with the technical correctness of a claim. Self-approve checks
     internal consistency of what's written, not whether the underlying
     reasoning is correct.
