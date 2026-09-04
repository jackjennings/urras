import { assertEquals, assertRejects } from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import {
  applyLearningToRepo,
  ensureStatePrompts,
  GitHubAuthError,
  preflightGitHubCredentials,
  readPhaseOutput,
  resolveGitHubAccount,
} from "./compose.ts";
import { PHASE_SEQUENCE } from "./phases/types.ts";
import { join } from "@std/path";
import type { Config, LearningState } from "./state/types.ts";

function makeConfig(overrides: Partial<Config["github"]> = {}): Config {
  return {
    github: { repos: [], ...overrides },
    state: { dir: "/tmp" },
    extensions: { dir: "/tmp/extensions" },
    tick: {
      concurrency: 1,
      resolveCIFailures: true,
      principles: true,
      agentsMdMaxTokens: 8000,
      maxTurns: 100,
    },
    codebase: { roots: [] },
    pi: { provider: "anthropic", packages: [] },
    agent: { type: "pi" },
  };
}

Deno.test("resolveGitHubAccount: accounts absent falls back to GITHUB_TOKEN/GITHUB_LOGIN", () => {
  Deno.env.set("GITHUB_TOKEN", "tok_fallback");
  Deno.env.set("GITHUB_LOGIN", "login_fallback");
  const result = resolveGitHubAccount("anyorg", makeConfig());
  assertEquals(result.token, "tok_fallback");
  assertEquals(result.login, "login_fallback");
});

Deno.test("resolveGitHubAccount: accounts present, org mapped → returns account creds", () => {
  Deno.env.set("GITHUB_TOKEN_PERSONAL", "tok_personal");
  const cfg = makeConfig({
    accounts: {
      personal: { tokenEnv: "GITHUB_TOKEN_PERSONAL", login: "jackjennings" },
    },
    orgs: { jackjennings: "personal" },
  });
  const result = resolveGitHubAccount("jackjennings", cfg);
  assertEquals(result.token, "tok_personal");
  assertEquals(result.login, "jackjennings");
});

Deno.test(
  "resolveGitHubAccount: currentSlug org used for token resolution after org transfer",
  () => {
    Deno.env.set("NEW_ORG_TOKEN", "newtoken");
    const cfg = makeConfig({
      repos: ["oldorg/repo"],
      accounts: {
        neworgAccount: { tokenEnv: "NEW_ORG_TOKEN", login: "new-user" },
      },
      orgs: { neworg: "neworgAccount" },
    });
    const { token } = resolveGitHubAccount("oldorg/repo", cfg, "neworg/repo");
    assertEquals(token, "newtoken");
  },
);

Deno.test("resolveGitHubAccount: accounts present, org not in orgs → falls back to GITHUB_TOKEN/GITHUB_LOGIN", () => {
  Deno.env.set("GITHUB_TOKEN", "tok_fallback");
  Deno.env.set("GITHUB_LOGIN", "login_fallback");
  Deno.env.set("GITHUB_TOKEN_PERSONAL", "tok_personal");
  const cfg = makeConfig({
    accounts: {
      personal: { tokenEnv: "GITHUB_TOKEN_PERSONAL", login: "jackjennings" },
    },
    orgs: { jackjennings: "personal" },
  });
  const result = resolveGitHubAccount("unknownorg", cfg);
  assertEquals(result.token, "tok_fallback");
  assertEquals(result.login, "login_fallback");
});

Deno.test(
  "ensureStatePrompts: creates prompts dir and all phase files when absent",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      await ensureStatePrompts(stateDir);
      for (const phase of PHASE_SEQUENCE) {
        const content = await Deno.readTextFile(
          join(stateDir, "prompts", `${phase}.md`),
        );
        assertEquals(content, "");
      }
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "ensureStatePrompts: no-op when all files already exist",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(join(stateDir, "prompts"), { recursive: true });
      for (const phase of PHASE_SEQUENCE) {
        await Deno.writeTextFile(join(stateDir, "prompts", `${phase}.md`), "");
      }
      const before = await Deno.stat(join(stateDir, "prompts", "intake.md"));
      await ensureStatePrompts(stateDir);
      const after = await Deno.stat(join(stateDir, "prompts", "intake.md"));
      assertEquals(before.mtime?.getTime(), after.mtime?.getTime());
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "ensureStatePrompts: creates only missing files, leaves existing untouched",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(join(stateDir, "prompts"), { recursive: true });
      await Deno.writeTextFile(
        join(stateDir, "prompts", "intake.md"),
        "existing content",
      );
      await ensureStatePrompts(stateDir);
      assertEquals(
        await Deno.readTextFile(join(stateDir, "prompts", "intake.md")),
        "existing content",
      );
      for (const phase of PHASE_SEQUENCE.filter((p) => p !== "intake")) {
        assertEquals(
          await Deno.readTextFile(join(stateDir, "prompts", `${phase}.md`)),
          "",
        );
      }
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "ensureStatePrompts: created files are empty (zero bytes)",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      await ensureStatePrompts(stateDir);
      for (const phase of PHASE_SEQUENCE) {
        const stat = await Deno.stat(
          join(stateDir, "prompts", `${phase}.md`),
        );
        assertEquals(stat.size, 0);
      }
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "ensureStatePrompts: phases come from PHASE_SEQUENCE, not hardcoded list",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      await ensureStatePrompts(stateDir);
      const entries: string[] = [];
      for await (const entry of Deno.readDir(join(stateDir, "prompts"))) {
        entries.push(entry.name);
      }
      const revisionPhases = ["spec", "plan", "implementation"];
      assertEquals(
        entries.sort(),
        [
          ...PHASE_SEQUENCE.map((p) => `${p}.md`),
          ...revisionPhases.map((p) => `${p}-revision.md`),
        ].sort(),
      );
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "ensureStatePrompts: creates github repo subdirectory with phase files",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      await ensureStatePrompts(stateDir, ["jackjennings/lazyboy"]);
      for (const phase of PHASE_SEQUENCE) {
        const content = await Deno.readTextFile(
          join(
            stateDir,
            "prompts",
            "github",
            "jackjennings",
            "lazyboy",
            `${phase}.md`,
          ),
        );
        assertEquals(content, "");
      }
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "ensureStatePrompts: creates jira board subdirectory with phase files",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      await ensureStatePrompts(stateDir, [], ["FOO"]);
      for (const phase of PHASE_SEQUENCE) {
        const content = await Deno.readTextFile(
          join(stateDir, "prompts", "jira", "FOO", `${phase}.md`),
        );
        assertEquals(content, "");
      }
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "ensureStatePrompts: scaffolds multiple jira projects independently",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      await ensureStatePrompts(stateDir, [], ["NW", "ACME"]);
      for (const project of ["NW", "ACME"]) {
        const content = await Deno.readTextFile(
          join(stateDir, "prompts", "jira", project, "intake.md"),
        );
        assertEquals(content, "");
      }
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "ensureStatePrompts: scaffolds multiple github repos independently",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      await ensureStatePrompts(stateDir, [
        "jackjennings/lazyboy",
        "jackjennings/other",
      ]);
      for (const repo of ["lazyboy", "other"]) {
        const content = await Deno.readTextFile(
          join(
            stateDir,
            "prompts",
            "github",
            "jackjennings",
            repo,
            "intake.md",
          ),
        );
        assertEquals(content, "");
      }
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "ensureStatePrompts: does not overwrite existing files in subdirectories",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(
        join(stateDir, "prompts", "github", "jackjennings", "lazyboy"),
        { recursive: true },
      );
      await Deno.writeTextFile(
        join(
          stateDir,
          "prompts",
          "github",
          "jackjennings",
          "lazyboy",
          "spec.md",
        ),
        "existing",
      );
      await ensureStatePrompts(stateDir, ["jackjennings/lazyboy"]);
      assertEquals(
        await Deno.readTextFile(
          join(
            stateDir,
            "prompts",
            "github",
            "jackjennings",
            "lazyboy",
            "spec.md",
          ),
        ),
        "existing",
      );
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "ensureStatePrompts: empty repos list and no jira creates no subdirectories",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      await ensureStatePrompts(stateDir, []);
      const entries: string[] = [];
      for await (const entry of Deno.readDir(join(stateDir, "prompts"))) {
        if (entry.isDirectory) entries.push(entry.name);
      }
      assertEquals(entries, []);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "ensureStatePrompts: creates spec-revision, plan-revision, implementation-revision in prompts dir",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      await ensureStatePrompts(stateDir);
      for (const phase of ["spec", "plan", "implementation"]) {
        const content = await Deno.readTextFile(
          join(stateDir, "prompts", `${phase}-revision.md`),
        );
        assertEquals(content, "");
      }
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "ensureStatePrompts: creates revision files in github repo subdirectory",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      await ensureStatePrompts(stateDir, ["jackjennings/lazyboy"]);
      for (const phase of ["spec", "plan", "implementation"]) {
        const content = await Deno.readTextFile(
          join(
            stateDir,
            "prompts",
            "github",
            "jackjennings",
            "lazyboy",
            `${phase}-revision.md`,
          ),
        );
        assertEquals(content, "");
      }
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "ensureStatePrompts: creates revision files in jira project subdirectory",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      await ensureStatePrompts(stateDir, [], ["FOO"]);
      for (const phase of ["spec", "plan", "implementation"]) {
        const content = await Deno.readTextFile(
          join(stateDir, "prompts", "jira", "FOO", `${phase}-revision.md`),
        );
        assertEquals(content, "");
      }
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

Deno.test(
  "ensureStatePrompts: does not overwrite existing revision files",
  async () => {
    const stateDir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(join(stateDir, "prompts"), { recursive: true });
      await Deno.writeTextFile(
        join(stateDir, "prompts", "implementation-revision.md"),
        "operator content",
      );
      await ensureStatePrompts(stateDir);
      assertEquals(
        await Deno.readTextFile(
          join(stateDir, "prompts", "implementation-revision.md"),
        ),
        "operator content",
      );
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
);

// ── preflightGitHubCredentials ────────────────────────────────────────────────

function makeOkResponse(login: string): Response {
  return new Response(JSON.stringify({ login }), { status: 200 });
}

function makeErrorResponse(status: 401 | 403): Response {
  return new Response("{}", { status });
}

Deno.test(
  "preflightGitHubCredentials: gh auth token exits nonzero → throws GitHubAuthError",
  async () => {
    const saved = Deno.env.get("GITHUB_TOKEN");
    Deno.env.delete("GITHUB_TOKEN");
    try {
      const runSpy = spy((_cmd: string[]) =>
        Promise.resolve({
          code: 1,
          stdout: "",
          stderr: "not logged in",
        })
      );
      await assertRejects(
        () =>
          preflightGitHubCredentials(makeConfig(), {
            run: runSpy,
            fetch: () => Promise.resolve(makeOkResponse("u")),
          }),
        GitHubAuthError,
        "gh auth token",
      );
    } finally {
      if (saved !== undefined) Deno.env.set("GITHUB_TOKEN", saved);
      else Deno.env.delete("GITHUB_TOKEN");
    }
  },
);

Deno.test(
  "preflightGitHubCredentials: gh auth token exits 0 with empty stdout → throws GitHubAuthError",
  async () => {
    const saved = Deno.env.get("GITHUB_TOKEN");
    Deno.env.delete("GITHUB_TOKEN");
    try {
      const runSpy = spy((_cmd: string[]) =>
        Promise.resolve({
          code: 0,
          stdout: "   ",
          stderr: "",
        })
      );
      await assertRejects(
        () =>
          preflightGitHubCredentials(makeConfig(), {
            run: runSpy,
            fetch: () => Promise.resolve(makeOkResponse("u")),
          }),
        GitHubAuthError,
        "gh auth token",
      );
    } finally {
      if (saved !== undefined) Deno.env.set("GITHUB_TOKEN", saved);
      else Deno.env.delete("GITHUB_TOKEN");
    }
  },
);

Deno.test(
  "preflightGitHubCredentials: token resolved from gh but GET /user returns 401 → throws GitHubAuthError",
  async () => {
    const savedToken = Deno.env.get("GITHUB_TOKEN");
    Deno.env.delete("GITHUB_TOKEN");
    try {
      await assertRejects(
        () =>
          preflightGitHubCredentials(makeConfig(), {
            run: () =>
              Promise.resolve({ code: 0, stdout: "gh-token", stderr: "" }),
            fetch: () => Promise.resolve(makeErrorResponse(401)),
          }),
        GitHubAuthError,
        "GitHub authentication failed",
      );
    } finally {
      if (savedToken !== undefined) Deno.env.set("GITHUB_TOKEN", savedToken);
      else Deno.env.delete("GITHUB_TOKEN");
    }
  },
);

Deno.test(
  "preflightGitHubCredentials: token from env but GET /user returns 401 → throws GitHubAuthError",
  async () => {
    const saved = Deno.env.get("GITHUB_TOKEN");
    Deno.env.set("GITHUB_TOKEN", "existing-token");
    try {
      await assertRejects(
        () =>
          preflightGitHubCredentials(makeConfig(), {
            run: spy(() =>
              Promise.resolve({ code: 0, stdout: "", stderr: "" })
            ),
            fetch: () => Promise.resolve(makeErrorResponse(401)),
          }),
        GitHubAuthError,
        "GitHub authentication failed",
      );
    } finally {
      if (saved !== undefined) Deno.env.set("GITHUB_TOKEN", saved);
      else Deno.env.delete("GITHUB_TOKEN");
    }
  },
);

Deno.test(
  "preflightGitHubCredentials: token from env and GET /user 200 → sets GITHUB_LOGIN when unset",
  async () => {
    const savedToken = Deno.env.get("GITHUB_TOKEN");
    const savedLogin = Deno.env.get("GITHUB_LOGIN");
    Deno.env.set("GITHUB_TOKEN", "existing-token");
    Deno.env.delete("GITHUB_LOGIN");
    try {
      await preflightGitHubCredentials(makeConfig(), {
        run: spy(() => Promise.resolve({ code: 0, stdout: "", stderr: "" })),
        fetch: () => Promise.resolve(makeOkResponse("testuser")),
      });
      assertEquals(Deno.env.get("GITHUB_LOGIN"), "testuser");
    } finally {
      if (savedToken !== undefined) Deno.env.set("GITHUB_TOKEN", savedToken);
      else Deno.env.delete("GITHUB_TOKEN");
      if (savedLogin !== undefined) Deno.env.set("GITHUB_LOGIN", savedLogin);
      else Deno.env.delete("GITHUB_LOGIN");
    }
  },
);

Deno.test(
  "preflightGitHubCredentials: GITHUB_TOKEN already set → does not shell to gh",
  async () => {
    const saved = Deno.env.get("GITHUB_TOKEN");
    const savedLogin = Deno.env.get("GITHUB_LOGIN");
    Deno.env.set("GITHUB_TOKEN", "existing-token");
    Deno.env.set("GITHUB_LOGIN", "existinguser");
    try {
      const runSpy = spy((_cmd: string[]) =>
        Promise.resolve({
          code: 0,
          stdout: "",
          stderr: "",
        })
      );
      await preflightGitHubCredentials(makeConfig(), {
        run: runSpy,
        fetch: () => Promise.resolve(makeOkResponse("existinguser")),
      });
      assertSpyCalls(runSpy, 0);
    } finally {
      if (saved !== undefined) Deno.env.set("GITHUB_TOKEN", saved);
      else Deno.env.delete("GITHUB_TOKEN");
      if (savedLogin !== undefined) Deno.env.set("GITHUB_LOGIN", savedLogin);
      else Deno.env.delete("GITHUB_LOGIN");
    }
  },
);

Deno.test(
  "preflightGitHubCredentials: named account with unset env var → throws GitHubAuthError, no gh invoked",
  async () => {
    const savedEnv = Deno.env.get("GITHUB_TOKEN_PERSONAL");
    Deno.env.delete("GITHUB_TOKEN_PERSONAL");
    try {
      const runSpy = spy((_cmd: string[]) =>
        Promise.resolve({
          code: 0,
          stdout: "",
          stderr: "",
        })
      );
      const cfg = makeConfig({
        accounts: {
          personal: {
            tokenEnv: "GITHUB_TOKEN_PERSONAL",
            login: "jackjennings",
          },
        },
        orgs: { jackjennings: "personal" },
      });
      await assertRejects(
        () =>
          preflightGitHubCredentials(cfg, {
            run: runSpy,
            fetch: () => Promise.resolve(makeOkResponse("u")),
          }),
        GitHubAuthError,
        "GITHUB_TOKEN_PERSONAL is not set",
      );
      assertSpyCalls(runSpy, 0);
    } finally {
      if (savedEnv !== undefined) {
        Deno.env.set("GITHUB_TOKEN_PERSONAL", savedEnv);
      } else Deno.env.delete("GITHUB_TOKEN_PERSONAL");
    }
  },
);

Deno.test(
  "preflightGitHubCredentials: named account token present and GET /user 200 → no env mutation",
  async () => {
    const savedEnv = Deno.env.get("GITHUB_TOKEN_PERSONAL");
    Deno.env.set("GITHUB_TOKEN_PERSONAL", "named-token");
    try {
      const cfg = makeConfig({
        accounts: {
          personal: {
            tokenEnv: "GITHUB_TOKEN_PERSONAL",
            login: "jackjennings",
          },
        },
        orgs: { jackjennings: "personal" },
      });
      await preflightGitHubCredentials(cfg, {
        run: spy(() => Promise.resolve({ code: 0, stdout: "", stderr: "" })),
        fetch: () => Promise.resolve(makeOkResponse("jackjennings")),
      });
    } finally {
      if (savedEnv !== undefined) {
        Deno.env.set("GITHUB_TOKEN_PERSONAL", savedEnv);
      } else Deno.env.delete("GITHUB_TOKEN_PERSONAL");
    }
  },
);

Deno.test(
  "preflightGitHubCredentials: accounts configured but a repo's org is unmapped and GITHUB_TOKEN unset → throws GitHubAuthError",
  async () => {
    const savedPersonal = Deno.env.get("GITHUB_TOKEN_PERSONAL");
    const savedToken = Deno.env.get("GITHUB_TOKEN");
    Deno.env.set("GITHUB_TOKEN_PERSONAL", "named-token");
    Deno.env.delete("GITHUB_TOKEN");
    try {
      const cfg = makeConfig({
        repos: ["someneworg/somerepo"],
        accounts: {
          personal: {
            tokenEnv: "GITHUB_TOKEN_PERSONAL",
            login: "jackjennings",
          },
        },
        orgs: { jackjennings: "personal" },
      });
      const runSpy = spy((_cmd: string[]) =>
        Promise.resolve({ code: 1, stdout: "", stderr: "not logged in" })
      );
      await assertRejects(
        () =>
          preflightGitHubCredentials(cfg, {
            run: runSpy,
            fetch: () => Promise.resolve(makeOkResponse("jackjennings")),
          }),
        GitHubAuthError,
        "gh auth token",
      );
      assertSpyCalls(runSpy, 1);
    } finally {
      if (savedPersonal !== undefined) {
        Deno.env.set("GITHUB_TOKEN_PERSONAL", savedPersonal);
      } else Deno.env.delete("GITHUB_TOKEN_PERSONAL");
      if (savedToken !== undefined) Deno.env.set("GITHUB_TOKEN", savedToken);
      else Deno.env.delete("GITHUB_TOKEN");
    }
  },
);

Deno.test(
  "preflightGitHubCredentials: accounts configured, all repo orgs mapped → does not validate bare GITHUB_TOKEN",
  async () => {
    const savedPersonal = Deno.env.get("GITHUB_TOKEN_PERSONAL");
    const savedToken = Deno.env.get("GITHUB_TOKEN");
    Deno.env.set("GITHUB_TOKEN_PERSONAL", "named-token");
    Deno.env.delete("GITHUB_TOKEN");
    try {
      const cfg = makeConfig({
        repos: ["jackjennings/lazyboy"],
        accounts: {
          personal: {
            tokenEnv: "GITHUB_TOKEN_PERSONAL",
            login: "jackjennings",
          },
        },
        orgs: { jackjennings: "personal" },
      });
      const runSpy = spy((_cmd: string[]) =>
        Promise.resolve({ code: 1, stdout: "", stderr: "not logged in" })
      );
      await preflightGitHubCredentials(cfg, {
        run: runSpy,
        fetch: () => Promise.resolve(makeOkResponse("jackjennings")),
      });
      assertSpyCalls(runSpy, 0);
    } finally {
      if (savedPersonal !== undefined) {
        Deno.env.set("GITHUB_TOKEN_PERSONAL", savedPersonal);
      } else Deno.env.delete("GITHUB_TOKEN_PERSONAL");
      if (savedToken !== undefined) Deno.env.set("GITHUB_TOKEN", savedToken);
      else Deno.env.delete("GITHUB_TOKEN");
    }
  },
);

// ── readPhaseOutput ───────────────────────────────────────────────────────────

Deno.test(
  "readPhaseOutput: no .exit file → null",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    try {
      const result = await readPhaseOutput(ticketDir, "intake");
      assertEquals(result, null);
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
    }
  },
);

Deno.test(
  "readPhaseOutput: .exit present but no .md → null",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(ticketDir, "20260817T120000-intake.md.exit"),
        "0",
      );
      const result = await readPhaseOutput(ticketDir, "intake");
      assertEquals(result, null);
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
    }
  },
);

Deno.test(
  "readPhaseOutput: .exit present and .md present → returns content",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(ticketDir, "20260817T120000-intake.md.exit"),
        "0",
      );
      await Deno.writeTextFile(
        join(ticketDir, "20260817T120000-intake.md"),
        "phase output content",
      );
      const result = await readPhaseOutput(ticketDir, "intake");
      assertEquals(result, "phase output content");
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
    }
  },
);

Deno.test(
  "readPhaseOutput: prior run .md present, current run .exit present but no .md → null",
  async () => {
    const ticketDir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(ticketDir, "20260817T110000-intake.md"),
        "prior run content",
      );
      await Deno.writeTextFile(
        join(ticketDir, "20260817T120000-intake.md.exit"),
        "0",
      );
      const result = await readPhaseOutput(ticketDir, "intake");
      assertEquals(result, null);
    } finally {
      await Deno.remove(ticketDir, { recursive: true });
    }
  },
);

// ── applyLearningToRepo ───────────────────────────────────────────────────────

Deno.test(
  "applyLearningToRepo: kind=procedure routes to procedurePath",
  async () => {
    const prosePath = spy(() => Promise.resolve("prose-url"));
    const procedurePath = spy(() => Promise.resolve("proc-url"));
    const l = { kind: "procedure" } as unknown as LearningState;
    const url = await applyLearningToRepo(l, "intent", {
      prosePath,
      procedurePath,
    });
    assertEquals(url, "proc-url");
    assertSpyCalls(procedurePath, 1);
    assertSpyCalls(prosePath, 0);
  },
);

Deno.test(
  "applyLearningToRepo: kind absent routes to prosePath",
  async () => {
    const prosePath = spy(() => Promise.resolve("prose-url"));
    const procedurePath = spy(() => Promise.resolve("proc-url"));
    const l = {} as unknown as LearningState;
    const url = await applyLearningToRepo(l, "intent", {
      prosePath,
      procedurePath,
    });
    assertEquals(url, "prose-url");
    assertSpyCalls(prosePath, 1);
    assertSpyCalls(procedurePath, 0);
  },
);

Deno.test(
  "applyLearningToRepo: kind=fact routes to prosePath",
  async () => {
    const prosePath = spy(() => Promise.resolve("prose-url"));
    const procedurePath = spy(() => Promise.resolve("proc-url"));
    const l = { kind: "fact" } as unknown as LearningState;
    const url = await applyLearningToRepo(l, "intent", {
      prosePath,
      procedurePath,
    });
    assertEquals(url, "prose-url");
    assertSpyCalls(prosePath, 1);
    assertSpyCalls(procedurePath, 0);
  },
);
