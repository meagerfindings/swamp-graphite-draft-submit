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
printf '%s\\n' '${ghJson}'
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
