import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@systeminit/swamp-testing@0.20260604.20";
import { model, writeTemporaryBodyFile } from "./graphite_draft_submit.ts";

/** Run a git command in `cwd`, throwing on failure and returning trimmed stdout. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const output = await new Deno.Command("git", {
    cwd,
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
  return new TextDecoder().decode(output.stdout).trim();
}

/**
 * Build a real git repository with an origin remote and a feature worktree
 * branched off `main`. Returns the worktree path, its branch, and the base SHA.
 */
async function repoFixture(root: string): Promise<{
  main: string;
  worktree: string;
  branch: string;
  baseSha: string;
}> {
  const main = `${root}/main`;
  const origin = `${root}/origin.git`;
  const worktree = `${root}/worktree`;
  const branch = "feature-branch";
  await Deno.mkdir(main);
  await git(main, "init", "-b", "main");
  await git(main, "config", "user.name", "Runtime Test");
  await git(main, "config", "user.email", "runtime@example.com");
  await Deno.writeTextFile(`${main}/README.md`, "base\n");
  await git(main, "add", ".");
  await git(main, "commit", "-m", "chore: base");
  await git(root, "clone", "--bare", main, origin);
  await git(main, "remote", "add", "origin", origin);
  await git(main, "fetch", "origin");
  await git(main, "worktree", "add", "-b", branch, worktree, "origin/main");
  await git(worktree, "config", "user.name", "Runtime Test");
  await git(worktree, "config", "user.email", "runtime@example.com");
  return {
    main: await Deno.realPath(main),
    worktree: await Deno.realPath(worktree),
    branch,
    baseSha: await git(worktree, "rev-parse", "HEAD"),
  };
}

/**
 * Write executable `gt` and `gh` shims into `${root}/bin` and prepend that dir
 * to PATH. `gt` appends its argv to `${root}/gt.log` and exits 0; `gh` prints
 * the supplied fixed PR JSON. Returns a restore function for PATH.
 */
async function installShims(
  root: string,
  ghJson: string,
): Promise<() => void> {
  const previousPath = Deno.env.get("PATH");
  const bin = `${root}/bin`;
  await Deno.mkdir(bin);
  await Deno.writeTextFile(
    `${bin}/gt`,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${root}/gt.log'
exit 0
`,
  );
  await Deno.writeTextFile(
    `${bin}/gh`,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${root}/gh.log'
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' '${ghJson}'
fi
`,
  );
  await Deno.chmod(`${bin}/gt`, 0o755);
  await Deno.chmod(`${bin}/gh`, 0o755);
  Deno.env.set("PATH", `${bin}:${previousPath ?? ""}`);
  return () =>
    previousPath === undefined
      ? Deno.env.delete("PATH")
      : Deno.env.set("PATH", previousPath);
}

/** Execute the model-level preflight checks that apply to shipDraft. */
async function runModelPreflight(): Promise<void> {
  for (const check of Object.values(model.checks)) {
    if (!(check.appliesTo as string[]).includes("shipDraft")) continue;
    const result = await check.execute();
    if (!result.pass) throw new Error(result.errors?.join("; "));
  }
}

Deno.test("failed temporary body write removes the file created before failure", async () => {
  let createdPath = "";
  await assertRejects(
    () =>
      writeTemporaryBodyFile("WRITE-FAILURE", "body", async (path) => {
        createdPath = path;
        assertEquals((await Deno.stat(path)).isFile, true);
        throw new Error("injected body write failure");
      }),
    Error,
    "injected body write failure",
  );
  assertEquals(createdPath.length > 0, true);
  await assertRejects(() => Deno.stat(createdPath), Deno.errors.NotFound);
});

Deno.test("shipDraft rejects a PR whose headRefOid differs from the validated SHA", async () => {
  const root = await Deno.makeTempDir();
  let restorePath: (() => void) | undefined;
  try {
    const fixture = await repoFixture(root);
    restorePath = await installShims(
      root,
      `{"url":"https://example.test/pr/1","number":1,"state":"OPEN","isDraft":true,"headRefName":"${fixture.branch}","headRefOid":"${
        "d".repeat(40)
      }","baseRefName":"main"}`,
    );
    const test = createModelTestContext({ globalArgs: {} });

    await assertRejects(
      () =>
        model.methods.shipDraft.execute({
          workItem: "WORK-200",
          repoPath: fixture.worktree,
          baseBranch: "main",
          expectedHeadSha: fixture.baseSha,
          expectedBranch: fixture.branch,
          draft: true,
        }, test.context),
      Error,
      "pull request does not point at the validated commit",
    );
    assertEquals(
      (await Deno.readTextFile(`${root}/gt.log`)).trim().split("\n"),
      [
        `track ${fixture.branch} --parent main --no-interactive`,
        "submit -q --no-edit --no-verify --no-stack --draft",
      ],
    );
    assertEquals(test.getWrittenResources()[0].data.success, false);
  } finally {
    restorePath?.();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("shipDraft accepts a PR that matches the validated SHA, branch and base", async () => {
  const root = await Deno.makeTempDir();
  let restorePath: (() => void) | undefined;
  try {
    const fixture = await repoFixture(root);
    restorePath = await installShims(
      root,
      `{"url":"https://example.test/pr/7","number":7,"state":"OPEN","isDraft":true,"headRefName":"${fixture.branch}","headRefOid":"${fixture.baseSha}","baseRefName":"main"}`,
    );
    const test = createModelTestContext({ globalArgs: {} });

    const result = await model.methods.shipDraft.execute({
      workItem: "WORK-201",
      repoPath: fixture.worktree,
      baseBranch: "main",
      expectedHeadSha: fixture.baseSha,
      expectedBranch: fixture.branch,
      draft: true,
    }, test.context);

    assertEquals(result.dataHandles?.length, 1);
    const written = test.getWrittenResources();
    assertEquals(written.length, 1);
    assertEquals(written[0].name, "pull-request-WORK-201");
    assertEquals(written[0].data.success, true);
    assertEquals(written[0].data.draft, true);
    assertEquals(written[0].data.prNumber, 7);
    assertEquals(written[0].data.prUrl, "https://example.test/pr/7");
    assertEquals(written[0].data.branch, fixture.branch);
    assertEquals(written[0].data.baseBranch, "main");
    assertEquals(written[0].data.commitSha, fixture.baseSha);
    assertEquals(
      (await Deno.readTextFile(`${root}/gt.log`)).trim().split("\n"),
      [
        `track ${fixture.branch} --parent main --no-interactive`,
        "submit -q --no-edit --no-verify --no-stack --draft",
      ],
    );
  } finally {
    restorePath?.();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("shipDraft applies a caller-supplied body via gh pr edit after gt submit", async () => {
  const root = await Deno.makeTempDir();
  let restorePath: (() => void) | undefined;
  try {
    const fixture = await repoFixture(root);
    restorePath = await installShims(
      root,
      `{"url":"https://example.test/pr/9","number":9,"state":"OPEN","isDraft":true,"headRefName":"${fixture.branch}","headRefOid":"${fixture.baseSha}","baseRefName":"main"}`,
    );
    const test = createModelTestContext({ globalArgs: {} });
    const body =
      "### Description\n\nHouse-style narrative.\n\n**Key Changes:**\n- one\n- two\n";

    const result = await model.methods.shipDraft.execute({
      workItem: "WORK-202",
      repoPath: fixture.worktree,
      baseBranch: "main",
      expectedHeadSha: fixture.baseSha,
      expectedBranch: fixture.branch,
      draft: true,
      body,
    }, test.context);

    assertEquals(result.dataHandles?.length, 1);
    assertEquals(test.getWrittenResources()[0].data.success, true);

    // gt submit succeeded, so the gh path is: pr edit (apply body) + pr view.
    const ghCalls = (await Deno.readTextFile(`${root}/gh.log`))
      .trim().split("\n");
    const editCall = ghCalls.find((c) => c.startsWith("pr edit "));
    if (!editCall) {
      throw new Error(
        `expected a 'gh pr edit' call, saw: ${ghCalls.join(" | ")}`,
      );
    }
    // Shape: pr edit <branch> --body-file <path>
    const parts = editCall.split(/\s+/);
    assertEquals(parts[0], "pr");
    assertEquals(parts[1], "edit");
    assertEquals(parts[2], fixture.branch);
    assertEquals(parts[3], "--body-file");
    const bodyFilePath = parts[4];
    assertEquals(typeof bodyFilePath, "string");
    await assertRejects(() => Deno.stat(bodyFilePath), Deno.errors.NotFound);
    assertEquals(ghCalls.some((c) => c.includes("--fill")), false);
  } finally {
    restorePath?.();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("shipDraft preflight permits update mode without gt", async () => {
  const root = await Deno.makeTempDir();
  const previousPath = Deno.env.get("PATH");
  try {
    const fixture = await repoFixture(root);
    const bin = `${root}/bin`;
    await Deno.mkdir(bin);
    const realGit = new TextDecoder().decode(
      (await new Deno.Command("which", { args: ["git"], stdout: "piped" })
        .output()).stdout,
    ).trim();
    await Deno.writeTextFile(
      `${bin}/git`,
      `#!/bin/sh\nexec '${realGit}' "$@"\n`,
    );
    await Deno.writeTextFile(
      `${bin}/gh`,
      `#!/bin/sh\nif [ "$1 $2" = "pr view" ]; then printf '%s\\n' '{"url":"https://example.test/pr/71","number":71,"state":"OPEN","isDraft":true,"headRefName":"${fixture.branch}","headRefOid":"${fixture.baseSha}","baseRefName":"main"}'; fi\n`,
    );
    await Deno.chmod(`${bin}/git`, 0o755);
    await Deno.chmod(`${bin}/gh`, 0o755);
    Deno.env.set("PATH", bin);
    await runModelPreflight();
    const test = createModelTestContext({ globalArgs: {} });
    await model.methods.shipDraft.execute({
      workItem: "WORK-UPDATE-NO-GT",
      repoPath: fixture.worktree,
      baseBranch: "main",
      expectedHeadSha: fixture.baseSha,
      expectedBranch: fixture.branch,
      submissionMode: "update",
      draft: true,
    }, test.context);
    assertEquals(test.getWrittenResources()[0].data.success, true);
  } finally {
    previousPath === undefined
      ? Deno.env.delete("PATH")
      : Deno.env.set("PATH", previousPath);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("shipDraft create mode requires gt after shared preflight", async () => {
  const root = await Deno.makeTempDir();
  const previousPath = Deno.env.get("PATH");
  try {
    const fixture = await repoFixture(root);
    const bin = `${root}/bin`;
    await Deno.mkdir(bin);
    const realGit = new TextDecoder().decode(
      (await new Deno.Command("which", { args: ["git"], stdout: "piped" })
        .output()).stdout,
    ).trim();
    await Deno.writeTextFile(
      `${bin}/git`,
      `#!/bin/sh\nexec '${realGit}' "$@"\n`,
    );
    await Deno.writeTextFile(`${bin}/gh`, "#!/bin/sh\nexit 0\n");
    await Deno.chmod(`${bin}/git`, 0o755);
    await Deno.chmod(`${bin}/gh`, 0o755);
    Deno.env.set("PATH", bin);
    await runModelPreflight();
    await assertRejects(
      () =>
        model.methods.shipDraft.execute({
          workItem: "WORK-CREATE-NO-GT",
          repoPath: fixture.worktree,
          baseBranch: "main",
          expectedHeadSha: fixture.baseSha,
          expectedBranch: fixture.branch,
          submissionMode: "create",
          draft: true,
        }, createModelTestContext({ globalArgs: {} }).context),
      Error,
      "create mode: gt",
    );
  } finally {
    previousPath === undefined
      ? Deno.env.delete("PATH")
      : Deno.env.set("PATH", previousPath);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("shipDraft create body edit failure is a persisted warning", async () => {
  const root = await Deno.makeTempDir();
  const previousPath = Deno.env.get("PATH");
  try {
    const fixture = await repoFixture(root);
    const bin = `${root}/bin`;
    await Deno.mkdir(bin);
    await Deno.writeTextFile(`${bin}/gt`, "#!/bin/sh\nexit 0\n");
    await Deno.writeTextFile(
      `${bin}/gh`,
      `#!/bin/sh\nif [ "$1 $2" = "pr edit" ]; then echo edit-failed >&2; exit 1; fi\nif [ "$1 $2" = "pr view" ]; then printf '%s\\n' '{"url":"https://example.test/pr/72","number":72,"state":"OPEN","isDraft":true,"headRefName":"${fixture.branch}","headRefOid":"${fixture.baseSha}","baseRefName":"main"}'; fi\n`,
    );
    await Deno.chmod(`${bin}/gt`, 0o755);
    await Deno.chmod(`${bin}/gh`, 0o755);
    Deno.env.set("PATH", `${bin}:${previousPath ?? ""}`);
    const test = createModelTestContext({ globalArgs: {} });
    await model.methods.shipDraft.execute({
      workItem: "WORK-CREATE-WARNING",
      repoPath: fixture.worktree,
      baseBranch: "main",
      expectedHeadSha: fixture.baseSha,
      expectedBranch: fixture.branch,
      submissionMode: "create",
      draft: true,
      body: "body",
    }, test.context);
    const result = test.getWrittenResources()[0].data;
    assertEquals(result.success, true);
    assertStringIncludes(
      String(result.summary),
      "warning: PR body not applied: edit-failed",
    );
  } finally {
    previousPath === undefined
      ? Deno.env.delete("PATH")
      : Deno.env.set("PATH", previousPath);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("shipDraft falls back to gh when gt track fails (local parent not in history)", async () => {
  const root = await Deno.makeTempDir();
  const previousPath = Deno.env.get("PATH");
  try {
    const fixture = await repoFixture(root);
    const bin = `${root}/bin`;
    await Deno.mkdir(bin);
    // gt track FAILS (exit 1) — simulates the feature being rebased onto the
    // REMOTE base while the local <base> branch diverged, so `gt track --parent
    // <local>` reports "<base> is not in the history of <branch>".
    await Deno.writeTextFile(
      `${bin}/gt`,
      `#!/bin/sh
printf '%s\\n' "$*" >> '${root}/gt.log'
if [ "$1" = "track" ]; then
  echo "ERROR: main is not in the history of ${fixture.branch}." 1>&2
  exit 1
fi
exit 0
`,
    );
    // gh pr create succeeds; gh pr view returns the matching draft PR.
    await Deno.writeTextFile(
      `${bin}/gh`,
      `#!/bin/sh
printf '%s\\n' "$*" >> '${root}/gh.log'
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' '{"url":"https://example.test/pr/12","number":12,"state":"OPEN","isDraft":true,"headRefName":"${fixture.branch}","headRefOid":"${fixture.baseSha}","baseRefName":"main"}'
fi
`,
    );
    await Deno.chmod(`${bin}/gt`, 0o755);
    await Deno.chmod(`${bin}/gh`, 0o755);
    Deno.env.set("PATH", `${bin}:${previousPath ?? ""}`);
    const test = createModelTestContext({ globalArgs: {} });

    const result = await model.methods.shipDraft.execute({
      workItem: "WORK-203",
      repoPath: fixture.worktree,
      baseBranch: "main",
      expectedHeadSha: fixture.baseSha,
      expectedBranch: fixture.branch,
      draft: true,
    }, test.context);

    // Despite gt track failing, the gh fallback created + verified the draft PR.
    assertEquals(result.dataHandles?.length, 1);
    const written = test.getWrittenResources();
    assertEquals(written[0].data.success, true);
    assertEquals(written[0].data.prNumber, 12);
    const ghCalls = (await Deno.readTextFile(`${root}/gh.log`)).trim().split(
      "\n",
    );
    assertEquals(ghCalls.some((c) => c.startsWith("pr create ")), true);
  } finally {
    previousPath === undefined
      ? Deno.env.delete("PATH")
      : Deno.env.set("PATH", previousPath);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("shipDraft correction fallback uses the exact explicit lease and reuses the existing PR", async () => {
  const root = await Deno.makeTempDir();
  const previousPath = Deno.env.get("PATH");
  try {
    const fixture = await repoFixture(root);
    const oldHead = fixture.baseSha;
    await Deno.writeTextFile(`${fixture.worktree}/README.md`, "corrected\n");
    await git(fixture.worktree, "add", "README.md");
    await git(fixture.worktree, "commit", "-m", "fix: corrected draft");
    const correctedHead = await git(fixture.worktree, "rev-parse", "HEAD");
    const realGit = await new Deno.Command("which", {
      args: ["git"],
      stdout: "piped",
    }).output();
    const gitPath = new TextDecoder().decode(realGit.stdout).trim();
    const bin = `${root}/bin`;
    await Deno.mkdir(bin);
    await Deno.writeTextFile(`${root}/remote-head`, oldHead);
    await Deno.writeTextFile(
      `${bin}/git`,
      `#!/bin/sh
if [ "$1" = "push" ]; then
  printf '%s\\n' "$*" >> '${root}/git.log'
  actual=$(cat '${root}/remote-head')
  [ "$2" = "--force-with-lease=refs/heads/${fixture.branch}:$actual" ] || { echo stale-info >&2; exit 1; }
  printf '%s' '${correctedHead}' > '${root}/remote-head'
  exit 0
fi
exec '${gitPath}' "$@"
`,
    );
    await Deno.writeTextFile(
      `${bin}/gt`,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${root}/gt.log'\nexit 1\n`,
    );
    await Deno.writeTextFile(
      `${bin}/gh`,
      `#!/bin/sh
printf '%s\\n' "$*" >> '${root}/gh.log'
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  if [ "$(cat '${root}/remote-head')" = '${correctedHead}' ]; then
    printf '%s\\n' '{"url":"https://example.test/pr/12","number":12,"state":"OPEN","isDraft":true,"headRefName":"${fixture.branch}","headRefOid":"${correctedHead}","baseRefName":"main"}'
  else
    printf '%s\\n' '{"url":"https://example.test/pr/12","number":12,"state":"OPEN","isDraft":true,"headRefName":"${fixture.branch}","headRefOid":"${oldHead}","baseRefName":"main"}'
  fi
fi
`,
    );
    for (const command of ["git", "gt", "gh"]) {
      await Deno.chmod(`${bin}/${command}`, 0o755);
    }
    Deno.env.set("PATH", `${bin}:${previousPath ?? ""}`);
    const test = createModelTestContext({ globalArgs: {} });

    await model.methods.shipDraft.execute({
      workItem: "WORK-204",
      repoPath: fixture.worktree,
      baseBranch: "main",
      expectedHeadSha: correctedHead,
      expectedBranch: fixture.branch,
      submissionMode: "update",
      draft: true,
    }, test.context);

    assertEquals(
      (await Deno.readTextFile(`${root}/git.log`)).trim(),
      `push --force-with-lease=refs/heads/${fixture.branch}:${oldHead} origin refs/heads/${fixture.branch}:refs/heads/${fixture.branch}`,
    );
    const ghCalls = (await Deno.readTextFile(`${root}/gh.log`)).trim().split(
      "\n",
    );
    assertEquals(ghCalls.some((call) => call.startsWith("pr create ")), false);
    assertEquals(ghCalls.some((call) => call.startsWith("pr view ")), true);
    assertEquals(await Deno.readTextFile(`${root}/gt.log`).catch(() => ""), "");
    assertEquals(
      (await Deno.readTextFile(`${root}/git.log`)).includes(" --force "),
      false,
    );
  } finally {
    previousPath === undefined
      ? Deno.env.delete("PATH")
      : Deno.env.set("PATH", previousPath);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("shipDraft correction fallback fails closed when the explicit lease push fails", async () => {
  const root = await Deno.makeTempDir();
  const previousPath = Deno.env.get("PATH");
  try {
    const fixture = await repoFixture(root);
    const realGit = new TextDecoder().decode(
      (await new Deno.Command("which", { args: ["git"], stdout: "piped" })
        .output()).stdout,
    ).trim();
    const bin = `${root}/bin`;
    await Deno.mkdir(bin);
    await Deno.writeTextFile(
      `${bin}/git`,
      `#!/bin/sh
if [ "$1" = "push" ]; then printf '%s\\n' "$*" >> '${root}/git.log'; echo 'stale info' >&2; exit 1; fi
exec '${realGit}' "$@"
`,
    );
    await Deno.writeTextFile(
      `${bin}/gt`,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${root}/gt.log'\nexit 1\n`,
    );
    await Deno.writeTextFile(
      `${bin}/gh`,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${root}/gh.log'\nif [ "$1" = "pr" ] && [ "$2" = "view" ]; then printf '%s\\n' '{"url":"https://example.test/pr/12","number":12,"state":"OPEN","isDraft":true,"headRefName":"${fixture.branch}","headRefOid":"${
        "1".repeat(40)
      }","baseRefName":"main"}'; fi\n`,
    );
    for (const command of ["git", "gt", "gh"]) {
      await Deno.chmod(`${bin}/${command}`, 0o755);
    }
    Deno.env.set("PATH", `${bin}:${previousPath ?? ""}`);
    const test = createModelTestContext({ globalArgs: {} });

    await assertRejects(
      () =>
        model.methods.shipDraft.execute({
          workItem: "WORK-205",
          repoPath: fixture.worktree,
          baseBranch: "main",
          expectedHeadSha: fixture.baseSha,
          expectedBranch: fixture.branch,
          submissionMode: "update",
          draft: true,
        }, test.context),
      Error,
      "git push failed: stale info",
    );

    assertEquals(
      (await Deno.readTextFile(`${root}/git.log`)).includes(
        "--force-with-lease=refs/heads/",
      ),
      true,
    );
    const ghCalls = await Deno.readTextFile(`${root}/gh.log`);
    assertEquals(ghCalls.includes("pr edit "), false);
    assertEquals(ghCalls.includes("pr create "), false);
    assertEquals(await Deno.readTextFile(`${root}/gt.log`).catch(() => ""), "");
    assertEquals(test.getWrittenResources().length, 0);
  } finally {
    previousPath === undefined
      ? Deno.env.delete("PATH")
      : Deno.env.set("PATH", previousPath);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("shipDraft update retry at the corrected remote head skips every push and reuses the same PR", async () => {
  const root = await Deno.makeTempDir();
  const previousPath = Deno.env.get("PATH");
  try {
    const fixture = await repoFixture(root);
    const realGit = new TextDecoder().decode(
      (await new Deno.Command("which", {
        args: ["git"],
        stdout: "piped",
      }).output()).stdout,
    ).trim();
    const bin = `${root}/bin`;
    await Deno.mkdir(bin);
    await Deno.writeTextFile(
      `${bin}/git`,
      `#!/bin/sh\nif [ "$1" = "push" ]; then echo "$*" >> '${root}/git.log'; exit 1; fi\nexec '${realGit}' "$@"\n`,
    );
    await Deno.writeTextFile(
      `${bin}/gt`,
      `#!/bin/sh\necho "$*" >> '${root}/gt.log'\nexit 1\n`,
    );
    await Deno.writeTextFile(
      `${bin}/gh`,
      `#!/bin/sh\necho "$*" >> '${root}/gh.log'\nif [ "$1" = "pr" ] && [ "$2" = "view" ]; then printf '%s\\n' '{"url":"https://example.test/pr/161","number":161,"state":"OPEN","isDraft":true,"headRefName":"${fixture.branch}","headRefOid":"${fixture.baseSha}","baseRefName":"main"}'; fi\n`,
    );
    for (const command of ["git", "gt", "gh"]) {
      await Deno.chmod(`${bin}/${command}`, 0o755);
    }
    Deno.env.set("PATH", `${bin}:${previousPath ?? ""}`);

    const test = createModelTestContext({ globalArgs: {} });
    await model.methods.shipDraft.execute({
      workItem: "WORK-206",
      repoPath: fixture.worktree,
      baseBranch: "main",
      expectedHeadSha: fixture.baseSha,
      expectedBranch: fixture.branch,
      submissionMode: "update",
      draft: true,
    }, test.context);
    assertEquals(
      await Deno.readTextFile(`${root}/git.log`).catch(() => ""),
      "",
    );
    assertEquals(await Deno.readTextFile(`${root}/gt.log`).catch(() => ""), "");
    assertEquals(
      (await Deno.readTextFile(`${root}/gh.log`)).includes("pr create "),
      false,
    );
    assertEquals(test.getWrittenResources()[0].data.prNumber, 161);
  } finally {
    previousPath === undefined
      ? Deno.env.delete("PATH")
      : Deno.env.set("PATH", previousPath);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("shipDraft update pins all mutations and reads to the discovered PR number", async () => {
  const root = await Deno.makeTempDir();
  const previousPath = Deno.env.get("PATH");
  try {
    const fixture = await repoFixture(root);
    const realGit = new TextDecoder().decode(
      (await new Deno.Command("which", { args: ["git"], stdout: "piped" })
        .output()).stdout,
    ).trim();
    const bin = `${root}/bin`;
    await Deno.mkdir(bin);
    await Deno.writeTextFile(
      `${bin}/git`,
      `#!/bin/sh\nexec '${realGit}' "$@"\n`,
    );
    // The branch selector discovers #41. A replacement #42 then appears for
    // that branch; any later branch-based edit/view would target #42.
    await Deno.writeTextFile(
      `${bin}/gh`,
      `#!/bin/sh
printf '%s\\n' "$*" >> '${root}/gh.log'
if [ "$1" = pr ] && [ "$2" = view ]; then
  selector="$3"
  if [ "$selector" = "${fixture.branch}" ] && [ -f '${root}/discovered' ]; then number=42; else number=41; fi
  touch '${root}/discovered'
  printf '{"url":"https://example.test/pr/%s","number":%s,"state":"OPEN","isDraft":true,"headRefName":"${fixture.branch}","headRefOid":"${fixture.baseSha}","baseRefName":"main"}\\n' "$number" "$number"
fi
`,
    );
    for (const command of ["git", "gh"]) {
      await Deno.chmod(`${bin}/${command}`, 0o755);
    }
    Deno.env.set("PATH", `${bin}:${previousPath ?? ""}`);
    const test = createModelTestContext({ globalArgs: {} });
    await model.methods.shipDraft.execute({
      workItem: "WORK-207",
      repoPath: fixture.worktree,
      baseBranch: "main",
      expectedHeadSha: fixture.baseSha,
      expectedBranch: fixture.branch,
      submissionMode: "update",
      draft: true,
      body: "corrected body",
    }, test.context);
    const calls = (await Deno.readTextFile(`${root}/gh.log`)).trim().split(
      "\n",
    );
    assertEquals(calls[0].startsWith(`pr view ${fixture.branch} `), true);
    assertEquals(
      calls.slice(1).every((call) => /^pr (edit|view) 41 /.test(call)),
      true,
    );
    assertEquals(calls.some((call) => call.includes(" 42 ")), false);
    assertEquals(test.getWrittenResources()[0].data.prNumber, 41);
    // No gt executable exists in the shim path; update mode must not invoke it.
    assertEquals(calls.length, 3);
  } finally {
    previousPath === undefined
      ? Deno.env.delete("PATH")
      : Deno.env.set("PATH", previousPath);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("shipDraft update rejects invalid existing PR observations before mutation", async () => {
  const cases = [
    ["missing", "", 1],
    [
      "closed",
      `{"url":"https://example.test/pr/1","number":1,"state":"CLOSED","isDraft":true,"headRefName":"feature-branch","headRefOid":"${
        "a".repeat(40)
      }","baseRefName":"main"}`,
      0,
    ],
    [
      "non-draft",
      `{"url":"https://example.test/pr/1","number":1,"state":"OPEN","isDraft":false,"headRefName":"feature-branch","headRefOid":"${
        "a".repeat(40)
      }","baseRefName":"main"}`,
      0,
    ],
    [
      "wrong head",
      `{"url":"https://example.test/pr/1","number":1,"state":"OPEN","isDraft":true,"headRefName":"other","headRefOid":"${
        "a".repeat(40)
      }","baseRefName":"main"}`,
      0,
    ],
    [
      "wrong base",
      `{"url":"https://example.test/pr/1","number":1,"state":"OPEN","isDraft":true,"headRefName":"feature-branch","headRefOid":"${
        "a".repeat(40)
      }","baseRefName":"other"}`,
      0,
    ],
    [
      "malformed oid",
      `{"url":"https://example.test/pr/1","number":1,"state":"OPEN","isDraft":true,"headRefName":"feature-branch","headRefOid":"deadbeef","baseRefName":"main"}`,
      0,
    ],
  ] as const;
  for (const [name, response, exitCode] of cases) {
    const root = await Deno.makeTempDir();
    const previousPath = Deno.env.get("PATH");
    try {
      const fixture = await repoFixture(root);
      const realGit = new TextDecoder().decode(
        (await new Deno.Command("which", { args: ["git"], stdout: "piped" })
          .output()).stdout,
      ).trim();
      const bin = `${root}/bin`;
      await Deno.mkdir(bin);
      await Deno.writeTextFile(
        `${bin}/git`,
        `#!/bin/sh\nif [ "$1" = "push" ]; then echo push >> '${root}/mutations.log'; fi\nexec '${realGit}' "$@"\n`,
      );
      await Deno.writeTextFile(
        `${bin}/gt`,
        `#!/bin/sh\necho gt >> '${root}/mutations.log'\n`,
      );
      await Deno.writeTextFile(
        `${bin}/gh`,
        `#!/bin/sh\nif [ "$1" = "pr" ] && [ "$2" = "view" ]; then printf '%s\\n' '${response}'; exit ${exitCode}; fi\necho "$*" >> '${root}/mutations.log'\n`,
      );
      for (const command of ["git", "gt", "gh"]) {
        await Deno.chmod(`${bin}/${command}`, 0o755);
      }
      Deno.env.set("PATH", `${bin}:${previousPath ?? ""}`);
      const test = createModelTestContext({ globalArgs: {} });
      await assertRejects(() =>
        model.methods.shipDraft.execute({
          workItem: `BAD-${name.replace(" ", "-")}`,
          repoPath: fixture.worktree,
          baseBranch: "main",
          expectedHeadSha: fixture.baseSha,
          expectedBranch: fixture.branch,
          submissionMode: "update",
          draft: true,
        }, test.context)
      );
      assertEquals(
        await Deno.readTextFile(`${root}/mutations.log`).catch(() => ""),
        "",
        name,
      );
    } finally {
      previousPath === undefined
        ? Deno.env.delete("PATH")
        : Deno.env.set("PATH", previousPath);
      await Deno.remove(root, { recursive: true });
    }
  }
});
