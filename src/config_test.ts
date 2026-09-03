import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import { expandHome, loadConfig } from "./config.ts";
import { join } from "@std/path";

Deno.test("loadConfig parses toml", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]

[state]
dir = "~/code/jackjennings/projects"

[tick]
concurrency = 2
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.github.repos, ["jackjennings/lazyboy"]);
  assertEquals(cfg.tick.concurrency, 2);
});

Deno.test("loadConfig defaults tick.resolveCIFailures to true when absent", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]

[state]
dir = "~/code/jackjennings/projects"

[tick]
concurrency = 1
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assert(cfg.tick.resolveCIFailures);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig parses tick.resolve_ci_failures = false", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]

[state]
dir = "~/code/jackjennings/projects"

[tick]
concurrency = 1
resolve_ci_failures = false
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertFalse(cfg.tick.resolveCIFailures);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig throws when tick.resolve_ci_failures is not a boolean", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]

[state]
dir = "~/code/jackjennings/projects"

[tick]
concurrency = 1
resolve_ci_failures = "yes"
`,
  );
  await assertRejects(
    () => loadConfig(join(dir, "config.toml")),
    Error,
    "config.toml: [tick].resolve_ci_failures must be a boolean",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig defaults tick.principles to true when absent", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]

[state]
dir = "~/code/jackjennings/projects"

[tick]
concurrency = 1
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assert(cfg.tick.principles);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig parses tick.principles = false", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]

[state]
dir = "~/code/jackjennings/projects"

[tick]
concurrency = 1
principles = false
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertFalse(cfg.tick.principles);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig throws when tick.principles is not a boolean", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]

[state]
dir = "~/code/jackjennings/projects"

[tick]
concurrency = 1
principles = "no"
`,
  );
  await assertRejects(
    () => loadConfig(join(dir, "config.toml")),
    Error,
    "config.toml: [tick].principles must be a boolean",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("expandHome replaces ~/ with HOME", () => {
  const home = Deno.env.get("HOME")!;
  assertEquals(expandHome("~/foo/bar"), `${home}/foo/bar`);
  assertEquals(expandHome("/absolute/path"), "/absolute/path");
});

Deno.test("loadConfig parses codebase.roots", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]

[state]
dir = "~/code/jackjennings/projects"

[tick]
concurrency = 2

[codebase]
roots = ["~/code", "~/code2"]
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.codebase.roots, ["~/code", "~/code2"]);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig defaults codebase.roots to [] when absent", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]

[state]
dir = "~/code/jackjennings/projects"

[tick]
concurrency = 2
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.codebase.roots, []);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig parses [pi].packages", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]

[state]
dir = "~/code/jackjennings/projects"

[tick]
concurrency = 1

[pi]
packages = ["npm:pi-lens", "agent-browser"]
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.pi.packages, ["npm:pi-lens", "agent-browser"]);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig defaults pi.packages to [] when absent", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]

[state]
dir = "~/code/jackjennings/projects"

[tick]
concurrency = 1
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.pi.packages, []);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig throws when [pi].packages is not an array", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]

[state]
dir = "~/code/jackjennings/projects"

[tick]
concurrency = 1

[pi]
packages = "not-an-array"
`,
  );
  await assertRejects(
    () => loadConfig(join(dir, "config.toml")),
    Error,
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig parses [jira.projects.*] section", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]

[state]
dir = "~/code"

[tick]
concurrency = 1

[jira.projects.nw]
base_url = "https://myorg.atlassian.net"
project = "NW"
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.jira?.nw?.baseUrl, "https://myorg.atlassian.net");
  assertEquals(cfg.jira?.nw?.project, "NW");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig sets config.jira to undefined when [jira] absent", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.jira, undefined);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig throws when [jira.projects.*] present but base_url missing", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1

[jira.projects.nw]
project = "NW"
`,
  );
  await assertRejects(
    () => loadConfig(join(dir, "config.toml")),
    Error,
    "config.toml: [jira.projects.nw].base_url is required",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig throws when [jira.projects.*] present but project missing", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1

[jira.projects.nw]
base_url = "https://myorg.atlassian.net"
`,
  );
  await assertRejects(
    () => loadConfig(join(dir, "config.toml")),
    Error,
    "config.toml: [jira.projects.nw].project is required",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig parses two [jira.projects.*] entries", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1

[jira.projects.nw]
base_url = "https://nw.atlassian.net"
project = "NW"

[jira.projects.acme]
base_url = "https://acme.atlassian.net"
project = "ACME"
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.jira?.nw?.baseUrl, "https://nw.atlassian.net");
  assertEquals(cfg.jira?.nw?.project, "NW");
  assertEquals(cfg.jira?.acme?.baseUrl, "https://acme.atlassian.net");
  assertEquals(cfg.jira?.acme?.project, "ACME");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig parses [pi].provider", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1

[pi]
provider = "bedrock"
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.pi.provider, "bedrock");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig defaults pi.provider to anthropic when [pi] absent", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.pi.provider, "anthropic");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig throws when [pi].provider is not a string", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1

[pi]
provider = 123
`,
  );
  await assertRejects(
    () => loadConfig(join(dir, "config.toml")),
    Error,
    "config.toml: [pi].provider must be a string",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig parses [phases.defaults] per-phase entries", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1

[phases.defaults.intake]
model = "claude-haiku-4-5"
thinking = "off"

[phases.defaults.spec]
model = "claude-sonnet-4-6"
thinking = "high"
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.phases?.defaults?.intake?.model, "claude-haiku-4-5");
  assertEquals(cfg.phases?.defaults?.intake?.thinking, "off");
  assertEquals(cfg.phases?.defaults?.spec?.thinking, "high");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig: phases is undefined when [phases] absent", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.phases, undefined);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig: per-phase entry with only model set", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1

[phases.defaults.intake]
model = "claude-opus-4-5"
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.phases?.defaults?.intake?.model, "claude-opus-4-5");
  assertEquals(cfg.phases?.defaults?.intake?.thinking, undefined);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig parses [agent].type", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1

[agent]
type = "claude-code"
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.agent.type, "claude-code");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig defaults agent.type to pi when [agent] absent", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.agent.type, "pi");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig throws when [agent].type is not a string", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1

[agent]
type = 123
`,
  );
  await assertRejects(
    () => loadConfig(join(dir, "config.toml")),
    Error,
    "config.toml: [agent].type must be a string",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig parses [github.accounts.*] and [github.orgs]", async () => {
  const dir = await Deno.makeTempDir();
  Deno.env.set("GITHUB_TOKEN_PERSONAL", "tok_personal");
  Deno.env.set("GITHUB_TOKEN_WORK", "tok_work");
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]

[github.accounts.personal]
token_env = "GITHUB_TOKEN_PERSONAL"
login     = "jackjennings"

[github.accounts.work]
token_env = "GITHUB_TOKEN_WORK"
login     = "jack-jennings-sdx"

[github.orgs]
jackjennings = "personal"
smarterdx    = "work"

[state]
dir = "~/code"

[tick]
concurrency = 1
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.github.accounts?.personal, {
    tokenEnv: "GITHUB_TOKEN_PERSONAL",
    login: "jackjennings",
  });
  assertEquals(cfg.github.accounts?.work, {
    tokenEnv: "GITHUB_TOKEN_WORK",
    login: "jack-jennings-sdx",
  });
  assertEquals(cfg.github.orgs?.jackjennings, "personal");
  assertEquals(cfg.github.orgs?.smarterdx, "work");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig: github.accounts absent leaves accounts/orgs undefined", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]

[state]
dir = "~/code"

[tick]
concurrency = 1
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.github.accounts, undefined);
  assertEquals(cfg.github.orgs, undefined);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig throws when token_env env var is not set", async () => {
  const dir = await Deno.makeTempDir();
  Deno.env.delete("GITHUB_TOKEN_MISSING");
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[github.accounts.personal]
token_env = "GITHUB_TOKEN_MISSING"
login     = "jackjennings"

[state]
dir = "~/code"

[tick]
concurrency = 1
`,
  );
  await assertRejects(
    () => loadConfig(join(dir, "config.toml")),
    Error,
    `config.toml: [github.accounts.personal].token_env "GITHUB_TOKEN_MISSING" is not set`,
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig parses [todo_txt] section", async () => {
  const dir = await Deno.makeTempDir();
  const home = Deno.env.get("HOME")!;
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1

[todo_txt]
file = "~/todo.txt"
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.todoTxt?.file, `${home}/todo.txt`);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig sets config.todoTxt to undefined when [todo_txt] absent", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.todoTxt, undefined);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig throws when [todo_txt] present but file absent", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1

[todo_txt]
`,
  );
  await assertRejects(
    () => loadConfig(join(dir, "config.toml")),
    Error,
    "config.toml: [todo_txt].file is required",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig parses tick.max_prompt_tokens", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1
max_prompt_tokens = 8000
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.tick.maxPromptTokens, 8000);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig defaults tick.maxPromptTokens to undefined when absent", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.tick.maxPromptTokens, undefined);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig throws when tick.max_prompt_tokens is not a number", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1
max_prompt_tokens = "oops"
`,
  );
  await assertRejects(
    () => loadConfig(join(dir, "config.toml")),
    Error,
    "config.toml: [tick].max_prompt_tokens must be a number",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig throws when [github.orgs] references unknown account", async () => {
  const dir = await Deno.makeTempDir();
  Deno.env.set("GITHUB_TOKEN_PERSONAL", "tok");
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[github.accounts.personal]
token_env = "GITHUB_TOKEN_PERSONAL"
login     = "jackjennings"

[github.orgs]
jackjennings = "nonexistent"

[state]
dir = "~/code"

[tick]
concurrency = 1
`,
  );
  await assertRejects(
    () => loadConfig(join(dir, "config.toml")),
    Error,
    `config.toml: [github.orgs] references unknown account "nonexistent"`,
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig defaults tick.agentsMdMaxTokens to 8000 when absent", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]

[state]
dir = "~/code"

[tick]
concurrency = 1
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.tick.agentsMdMaxTokens, 8000);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig parses tick.agents_md_max_tokens", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]

[state]
dir = "~/code"

[tick]
concurrency = 1
agents_md_max_tokens = 5000
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.tick.agentsMdMaxTokens, 5000);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig accepts 0 for tick.agents_md_max_tokens", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]

[state]
dir = "~/code"

[tick]
concurrency = 1
agents_md_max_tokens = 0
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.tick.agentsMdMaxTokens, 0);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig throws when tick.agents_md_max_tokens is not a non-negative integer", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]

[state]
dir = "~/code"

[tick]
concurrency = 1
agents_md_max_tokens = -1
`,
  );
  await assertRejects(
    () => loadConfig(join(dir, "config.toml")),
    Error,
    "config.toml: [tick].agents_md_max_tokens must be a non-negative integer",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig defaults tick.maxTurns to 100 when absent", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.tick.maxTurns, 100);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig parses tick.max_turns", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1
max_turns = 200
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.tick.maxTurns, 200);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig accepts 0 for tick.max_turns", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1
max_turns = 0
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.tick.maxTurns, 0);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig throws when tick.max_turns is not a non-negative integer", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1
max_turns = -1
`,
  );
  await assertRejects(
    () => loadConfig(join(dir, "config.toml")),
    Error,
    "config.toml: [tick].max_turns must be a non-negative integer",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig defaults tick.checkNewComments to undefined when absent", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]

[state]
dir = "~/code/jackjennings/projects"

[tick]
concurrency = 1
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.tick.checkNewComments, undefined);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig parses tick.check_new_comments = false", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]

[state]
dir = "~/code/jackjennings/projects"

[tick]
concurrency = 1
check_new_comments = false
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertFalse(cfg.tick.checkNewComments);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig throws when tick.check_new_comments is not a boolean", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]

[state]
dir = "~/code/jackjennings/projects"

[tick]
concurrency = 1
check_new_comments = "yes"
`,
  );
  await assertRejects(
    () => loadConfig(join(dir, "config.toml")),
    Error,
    "[tick].check_new_comments must be a boolean",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig: defaults extensions.dir to lazyboyDir()/extensions when [extensions] absent", async () => {
  const dir = await Deno.makeTempDir();
  const lazyboyDir = await Deno.makeTempDir();
  const originalLazyboyDir = Deno.env.get("URRAS_DIR");
  Deno.env.set("URRAS_DIR", lazyboyDir);
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]

[state]
dir = "~/code/jackjennings/projects"

[tick]
concurrency = 1
`,
  );
  try {
    const cfg = await loadConfig(join(dir, "config.toml"));
    assertEquals(cfg.extensions.dir, join(lazyboyDir, "extensions"));
  } finally {
    if (originalLazyboyDir !== undefined) {
      Deno.env.set("URRAS_DIR", originalLazyboyDir);
    } else {
      Deno.env.delete("URRAS_DIR");
    }
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(lazyboyDir, { recursive: true });
  }
});

Deno.test("loadConfig: parses [extensions] dir and expands home", async () => {
  const dir = await Deno.makeTempDir();
  const home = Deno.env.get("HOME")!;
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = ["jackjennings/lazyboy"]

[state]
dir = "~/code/jackjennings/projects"

[tick]
concurrency = 1

[extensions]
dir = "~/my-extensions"
`,
  );
  try {
    const cfg = await loadConfig(join(dir, "config.toml"));
    assertEquals(cfg.extensions.dir, join(home, "my-extensions"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadConfig parses [jira.projects.*.statuses] fields", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1

[jira.projects.nw]
base_url = "https://myorg.atlassian.net"
project = "NW"

[jira.projects.nw.statuses]
pickup = "In Review"
done = "Closed"
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.jira?.nw?.statuses?.pickup, "In Review");
  assertEquals(cfg.jira?.nw?.statuses?.done, "Closed");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig leaves statuses undefined when [jira.projects.*.statuses] absent", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1

[jira.projects.nw]
base_url = "https://myorg.atlassian.net"
project = "NW"
`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.jira?.nw?.statuses, undefined);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig throws when [jira.projects.*.statuses].pickup is not a string", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1

[jira.projects.nw]
base_url = "https://myorg.atlassian.net"
project = "NW"

[jira.projects.nw.statuses]
pickup = 42
done = "Done"
`,
  );
  await assertRejects(
    () => loadConfig(join(dir, "config.toml")),
    Error,
    "config.toml: [jira.projects.nw.statuses].pickup must be a string",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig throws when [jira.projects.*.statuses].done is not a string", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `
[github]
repos = []

[state]
dir = "~/code"

[tick]
concurrency = 1

[jira.projects.nw]
base_url = "https://myorg.atlassian.net"
project = "NW"

[jira.projects.nw.statuses]
pickup = "In Progress"
done = 99
`,
  );
  await assertRejects(
    () => loadConfig(join(dir, "config.toml")),
    Error,
    "config.toml: [jira.projects.nw.statuses].done must be a string",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig: absent [ollama] section leaves config.ollama undefined", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `[github]\nrepos = []\n[state]\ndir = "~/tmp"\n[tick]\nconcurrency = 1\n`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.ollama, undefined);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig: [ollama] with models parses correctly", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `[github]\nrepos = []\n[state]\ndir = "~/tmp"\n[tick]\nconcurrency = 1\n[ollama]\nmodels = ["qwen2.5:7b"]\n`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.ollama, { models: ["qwen2.5:7b"], url: undefined });
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig: [ollama] with models and url parses correctly", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `[github]\nrepos = []\n[state]\ndir = "~/tmp"\n[tick]\nconcurrency = 1\n[ollama]\nmodels = ["qwen2.5:7b"]\nurl = "http://host:11434"\n`,
  );
  const cfg = await loadConfig(join(dir, "config.toml"));
  assertEquals(cfg.ollama, {
    models: ["qwen2.5:7b"],
    url: "http://host:11434",
  });
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig: [ollama] without models throws", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `[github]\nrepos = []\n[state]\ndir = "~/tmp"\n[tick]\nconcurrency = 1\n[ollama]\n`,
  );
  await assertRejects(
    () => loadConfig(join(dir, "config.toml")),
    Error,
    "config.toml: [ollama].models must be a non-empty array of strings",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig: [ollama] with empty models array throws", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `[github]\nrepos = []\n[state]\ndir = "~/tmp"\n[tick]\nconcurrency = 1\n[ollama]\nmodels = []\n`,
  );
  await assertRejects(
    () => loadConfig(join(dir, "config.toml")),
    Error,
    "config.toml: [ollama].models must be a non-empty array of strings",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadConfig: [ollama] with non-string url throws", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "config.toml"),
    `[github]\nrepos = []\n[state]\ndir = "~/tmp"\n[tick]\nconcurrency = 1\n[ollama]\nmodels = ["qwen2.5:7b"]\nurl = 42\n`,
  );
  await assertRejects(
    () => loadConfig(join(dir, "config.toml")),
    Error,
    "config.toml: [ollama].url must be a string",
  );
  await Deno.remove(dir, { recursive: true });
});
