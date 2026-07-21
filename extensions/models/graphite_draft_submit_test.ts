import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@systeminit/swamp-testing@0.20260604.20";
import { model } from "./graphite_draft_submit.ts";

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

Deno.test("shipDraft rejects a PR whose headRefOid differs from the validated SHA", async () => {
  const root = await Deno.makeTempDir();
  let restorePath: (() => void) | undefined;
  try {
    const fixture = await repoFixture(root);
    restorePath = await installShims(
      root,
      `{"url":"https://example.test/pr/1","number":1,"isDraft":true,"headRefName":"${fixture.branch}","headRefOid":"deadbeef","baseRefName":"main"}`,
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
      `{"url":"https://example.test/pr/7","number":7,"isDraft":true,"headRefName":"${fixture.branch}","headRefOid":"${fixture.baseSha}","baseRefName":"main"}`,
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
      `{"url":"https://example.test/pr/9","number":9,"isDraft":true,"headRefName":"${fixture.branch}","headRefOid":"${fixture.baseSha}","baseRefName":"main"}`,
    );
    const test = createModelTestContext({ globalArgs: {} });
    const body = "### Description\n\nHouse-style narrative.\n\n**Key Changes:**\n- one\n- two\n";

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
      throw new Error(`expected a 'gh pr edit' call, saw: ${ghCalls.join(" | ")}`);
    }
    // Shape: pr edit <branch> --body-file <path>
    const parts = editCall.split(/\s+/);
    assertEquals(parts[0], "pr");
    assertEquals(parts[1], "edit");
    assertEquals(parts[2], fixture.branch);
    assertEquals(parts[3], "--body-file");
    const bodyFilePath = parts[4];
    // The temp file is removed after the method returns, so assert the call
    // shape and that no --fill was used for creation.
    assertEquals(typeof bodyFilePath, "string");
    assertEquals(ghCalls.some((c) => c.includes("--fill")), false);
  } finally {
    restorePath?.();
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
  printf '%s\\n' '{"url":"https://example.test/pr/12","number":12,"isDraft":true,"headRefName":"${fixture.branch}","headRefOid":"${fixture.baseSha}","baseRefName":"main"}'
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
