import { assertEquals, assertExists } from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { applyTickActionLearning } from "./apply-tick-action-learning.ts";
import type { CommandRunner } from "./apfel.ts";

function runnerReturning(stdout: string, code = 0): CommandRunner {
  return spy((_args: string[]) => Promise.resolve({ code, stdout }));
}

const COMPOSE =
  `// compose.ts snippet\nconst tickActions = [existingAction()];\n`;
const INTENT =
  "After a CI failure from a missing deno fmt check, always run deno fmt before committing.";
const TICK_ACTION_SRC =
  `import type { TickAction } from "./types.ts";\nexport function runDenoFmtAction(): TickAction { return { label: "Run deno fmt", applies: () => false, run: async () => null }; }`;
const UPDATED_COMPOSE =
  `// compose.ts updated\nimport { runDenoFmtAction } from "./tick-actions/run-deno-fmt.ts";\nconst tickActions = [existingAction(), runDenoFmtAction()];\n`;

Deno.test(
  "applyTickActionLearning: extracts tick-action-source and updated-compose from response",
  async () => {
    const run = runnerReturning(
      `<tick-action-source>${TICK_ACTION_SRC}</tick-action-source>\n<updated-compose>${UPDATED_COMPOSE}</updated-compose>`,
    );
    const result = await applyTickActionLearning({
      targetFile: "src/tick-actions/run-deno-fmt.ts",
      composeContent: COMPOSE,
      intent: INTENT,
      run,
    });
    assertExists(result);
    assertEquals(result.tickActionSource, TICK_ACTION_SRC);
    assertEquals(result.updatedCompose, UPDATED_COMPOSE);
  },
);

Deno.test(
  "applyTickActionLearning: returns null when claude exits non-zero",
  async () => {
    const result = await applyTickActionLearning({
      targetFile: "src/tick-actions/run-deno-fmt.ts",
      composeContent: COMPOSE,
      intent: INTENT,
      run: runnerReturning("", 1),
    });
    assertEquals(result, null);
  },
);

Deno.test(
  "applyTickActionLearning: returns null when response is empty",
  async () => {
    const result = await applyTickActionLearning({
      targetFile: "src/tick-actions/run-deno-fmt.ts",
      composeContent: COMPOSE,
      intent: INTENT,
      run: runnerReturning("   "),
    });
    assertEquals(result, null);
  },
);

Deno.test(
  "applyTickActionLearning: returns null when tags are absent from response",
  async () => {
    const result = await applyTickActionLearning({
      targetFile: "src/tick-actions/run-deno-fmt.ts",
      composeContent: COMPOSE,
      intent: INTENT,
      run: runnerReturning("Here is some code without tags."),
    });
    assertEquals(result, null);
  },
);

Deno.test(
  "applyTickActionLearning: includes intent, targetFile, and compose content in prompt",
  async () => {
    const run = runnerReturning(
      `<tick-action-source>x</tick-action-source><updated-compose>y</updated-compose>`,
    );
    await applyTickActionLearning({
      targetFile: "src/tick-actions/run-deno-fmt.ts",
      composeContent: COMPOSE,
      intent: INTENT,
      run,
    });
    const args = (run as ReturnType<typeof spy>).calls[0].args[0] as string[];
    const prompt = args[args.length - 1];
    assertEquals(prompt.includes(INTENT), true);
    assertEquals(prompt.includes(COMPOSE), true);
    assertEquals(prompt.includes("src/tick-actions/run-deno-fmt.ts"), true);
    assertSpyCalls(run as ReturnType<typeof spy>, 1);
  },
);

Deno.test(
  "applyTickActionLearning: passes --model claude-sonnet-4-6 to claude",
  async () => {
    const run = runnerReturning(
      `<tick-action-source>x</tick-action-source><updated-compose>y</updated-compose>`,
    );
    await applyTickActionLearning({
      targetFile: "src/tick-actions/run-deno-fmt.ts",
      composeContent: COMPOSE,
      intent: INTENT,
      run,
    });
    const args = (run as ReturnType<typeof spy>).calls[0].args[0] as string[];
    const modelIdx = args.indexOf("--model");
    assertEquals(args[modelIdx + 1], "claude-sonnet-4-6");
  },
);
