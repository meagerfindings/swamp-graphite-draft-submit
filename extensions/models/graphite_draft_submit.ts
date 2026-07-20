// MIT License
//
// Copyright (c) 2026 Mat Greten
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @module graphite_draft_submit
 *
 * A standalone swamp model that submits an already-validated Git commit as a
 * **draft** GitHub pull request using the Graphite CLI (`gt`) and independently
 * verifies the result with the GitHub CLI (`gh`).
 *
 * The model is deliberately conservative. It never mutates the working tree,
 * never amends or rewrites the commit, and refuses to submit unless the checkout
 * matches exactly what the caller says it validated:
 *
 * - the current branch must equal `expectedBranch` (no detached HEAD);
 * - the worktree must be clean (`git status --porcelain` empty);
 * - `HEAD` must equal `expectedHeadSha`.
 *
 * After `gt track` + `gt submit --draft`, it queries `gh pr view` and requires
 * the returned pull request to point at the validated SHA, branch and base, and
 * to be a draft. Any mismatch is recorded on the persisted `pullRequest`
 * resource (`success: false`) and the method throws, so a bad submission never
 * looks like a good one.
 *
 * The base branch is configurable per invocation and defaults to `main`.
 *
 * Prerequisites on the host running the method: `git`, `gt` (Graphite) and `gh`
 * (GitHub CLI, authenticated) all on `PATH`. Declared as model checks.
 */

import { z } from "npm:zod@4";
import type {
  DataHandle,
  MethodContext,
  MethodResult,
} from "jsr:@systeminit/swamp-testing@0.20260604.20";

/**
 * Global arguments for the model. This model needs no persistent global
 * configuration — every input is supplied per method call — so the schema is
 * an empty object.
 */
export const GlobalArgsSchema: z.ZodObject<Record<string, never>> = z.object(
  {},
);

/**
 * A path-safe work-item identifier. Used to name the persisted pull-request
 * record (`pull-request-<workItem>`), so it must not contain path separators.
 */
export const WorkItemSchema: z.ZodString = z.string().min(1).regex(
  /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
  "workItem must be path-safe",
);

/** An absolute filesystem path to the repository checkout to submit from. */
export const AbsolutePathSchema: z.ZodString = z.string().min(1).regex(
  /^\//,
  "repoPath must be absolute",
);

/** A full 40-character lowercase-hex Git SHA-1. */
export const CommitShaSchema: z.ZodString = z.string().regex(
  /^[0-9a-f]{40}$/,
  "commit SHA must be a full 40-character Git SHA-1",
);

/**
 * The persisted draft pull-request record. `draft` is a literal `true`: this
 * model only ever produces draft pull requests. `success` reflects whether the
 * independent GitHub verification passed; `prUrl`/`prNumber` are present when
 * GitHub returned a pull request.
 */
export const PullRequestSchema: z.ZodObject<{
  workItem: z.ZodString;
  success: z.ZodBoolean;
  draft: z.ZodLiteral<true>;
  prUrl: z.ZodOptional<z.ZodString>;
  prNumber: z.ZodOptional<z.ZodNumber>;
  branch: z.ZodString;
  baseBranch: z.ZodString;
  commitSha: z.ZodString;
  summary: z.ZodString;
  submittedAt: z.ZodString;
}> = z.object({
  workItem: z.string(),
  success: z.boolean(),
  draft: z.literal(true),
  prUrl: z.string().optional(),
  prNumber: z.number().int().optional(),
  branch: z.string(),
  baseBranch: z.string(),
  commitSha: z.string(),
  summary: z.string(),
  submittedAt: z.string(),
});

/**
 * The subset of `gh pr view --json` fields this model reads to independently
 * verify the pull request Graphite created.
 */
export const GitHubPullRequestSchema: z.ZodObject<{
  url: z.ZodString;
  number: z.ZodNumber;
  isDraft: z.ZodBoolean;
  headRefName: z.ZodString;
  headRefOid: z.ZodString;
  baseRefName: z.ZodString;
}> = z.object({
  url: z.string().url(),
  number: z.number().int().positive(),
  isDraft: z.boolean(),
  headRefName: z.string(),
  headRefOid: z.string(),
  baseRefName: z.string(),
});

/** The result of running a single external command via {@link runCommand}. */
export interface CommandResult {
  success: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The method-execution context this model relies on: the swamp-provided
 * {@link MethodContext} with a concretely-typed `writeResource` for persisting
 * the {@link PullRequestSchema} record.
 */
export type RuntimeContext =
  & Omit<MethodContext<Record<string, unknown>>, "writeResource">
  & {
    writeResource: (
      specName: string,
      name: string,
      data: Record<string, unknown>,
      overrides?: { tags?: Record<string, string> },
    ) => Promise<DataHandle>;
  };

/**
 * Run an external command in `cwd`, capturing stdout/stderr as trimmed strings.
 * A thin wrapper over `Deno.Command` used for all `git`, `gt` and `gh` calls.
 */
export async function runCommand(
  command: string[],
  cwd: string,
): Promise<CommandResult> {
  const output = await new Deno.Command(command[0], {
    args: command.slice(1),
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();

  return {
    success: output.success,
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr).trim(),
  };
}

/**
 * Return `true` if an executable named `name` exists as a file on any `PATH`
 * entry. Used by the model checks to verify `git`, `gt` and `gh` are installed.
 */
export async function commandAvailable(name: string): Promise<boolean> {
  for (const directory of (Deno.env.get("PATH") ?? "").split(":")) {
    if (!directory) continue;
    try {
      const stat = await Deno.stat(`${directory}/${name}`);
      if (stat.isFile) return true;
    } catch { /* continue searching PATH */ }
  }
  return false;
}

/** Arguments accepted by the {@link model}'s `shipDraft` method. */
export const ShipDraftArgsSchema: z.ZodObject<{
  workItem: z.ZodString;
  repoPath: z.ZodString;
  baseBranch: z.ZodDefault<z.ZodString>;
  expectedHeadSha: z.ZodString;
  expectedBranch: z.ZodString;
  draft: z.ZodDefault<z.ZodLiteral<true>>;
}> = z.object({
  workItem: WorkItemSchema,
  repoPath: AbsolutePathSchema,
  baseBranch: z.string().min(1).default("main"),
  expectedHeadSha: CommitShaSchema,
  expectedBranch: z.string().min(1),
  draft: z.literal(true).default(true),
});

/**
 * The swamp model. Exposes a single method, `shipDraft`, which submits a
 * validated commit as a draft GitHub pull request via Graphite and verifies it
 * independently through the GitHub CLI. Declares checks for the required CLIs.
 */
export const model = {
  type: "@mgreten/graphite-draft-submit",
  version: "2026.07.20.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    pullRequest: {
      description: "The draft pull request produced for a work item",
      schema: PullRequestSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  checks: {
    "git-available": {
      description: "Verify git is available for checkout validation",
      labels: ["dependency"],
      appliesTo: ["shipDraft"],
      execute: async (): Promise<{ pass: boolean; errors?: string[] }> =>
        await commandAvailable("git")
          ? { pass: true }
          : { pass: false, errors: ["Missing required tool: git"] },
    },
    "submission-tools-available": {
      description:
        "Verify Graphite and GitHub CLIs are available before submission",
      labels: ["dependency"],
      appliesTo: ["shipDraft"],
      execute: async (): Promise<{ pass: boolean; errors?: string[] }> => {
        const missing: string[] = [];
        for (const command of ["gt", "gh"]) {
          if (!await commandAvailable(command)) missing.push(command);
        }
        return missing.length === 0 ? { pass: true } : {
          pass: false,
          errors: [`Missing required tools: ${missing.join(", ")}`],
        };
      },
    },
  },
  methods: {
    shipDraft: {
      description:
        "Submit an unchanged validated commit through Graphite and require a discoverable draft GitHub pull request that points at the validated SHA, branch and base",
      arguments: ShipDraftArgsSchema,
      execute: async (
        args: {
          workItem: string;
          repoPath: string;
          baseBranch: string;
          expectedHeadSha: string;
          expectedBranch: string;
          draft: true;
        },
        context: RuntimeContext,
      ): Promise<MethodResult> => {
        context.logger.info("Preparing draft submission for {workItem}", {
          workItem: args.workItem,
        });
        const branchResult = await runCommand(
          ["git", "rev-parse", "--abbrev-ref", "HEAD"],
          args.repoPath,
        );
        const branch = branchResult.stdout;
        if (!branchResult.success || branch === "HEAD") {
          throw new Error("cannot ship a detached checkout");
        }
        if (branch !== args.expectedBranch) {
          throw new Error(
            `refusing to submit ${branch}; expected ${args.expectedBranch}`,
          );
        }

        const status = await runCommand(
          ["git", "status", "--porcelain", "--untracked-files=all"],
          args.repoPath,
        );
        const head = await runCommand(
          ["git", "rev-parse", "HEAD"],
          args.repoPath,
        );
        if (!status.success || status.stdout !== "") {
          throw new Error("refusing to submit a dirty worktree");
        }
        if (!head.success || head.stdout !== args.expectedHeadSha) {
          throw new Error("refusing to submit a commit that was not validated");
        }

        const expectedBase = args.baseBranch.replace(/^origin\//, "");
        const track = await runCommand(
          [
            "gt",
            "track",
            branch,
            "--parent",
            expectedBase,
            "--no-interactive",
          ],
          args.repoPath,
        );
        const submitCommand = [
          "gt",
          "submit",
          "-q",
          "--no-edit",
          "--no-verify",
        ];
        submitCommand.push("--draft");
        const submit = track.success
          ? await runCommand(submitCommand, args.repoPath)
          : { success: false, stdout: "", stderr: "" };

        let prInfo: z.infer<typeof GitHubPullRequestSchema> | null = null;
        if (submit.success) {
          for (let attempt = 0; attempt < 3 && !prInfo; attempt++) {
            if (attempt > 0) {
              await new Promise((resolve) => setTimeout(resolve, 1_000));
            }
            const view = await runCommand(
              [
                "gh",
                "pr",
                "view",
                "--json",
                "url,number,isDraft,headRefName,headRefOid,baseRefName",
              ],
              args.repoPath,
            );
            if (view.success) {
              try {
                const parsed = GitHubPullRequestSchema.safeParse(
                  JSON.parse(view.stdout),
                );
                if (parsed.success) prInfo = parsed.data;
              } catch {
                prInfo = null;
              }
            }
          }
        }

        const errors: string[] = [];
        if (!track.success) {
          errors.push(`gt track failed: ${track.stderr || track.stdout}`);
        } else if (!submit.success) {
          errors.push(`gt submit failed: ${submit.stderr || submit.stdout}`);
        }
        if (!prInfo) {
          errors.push("GitHub did not return a pull request for the branch");
        }
        if (
          prInfo?.headRefName !== undefined && prInfo.headRefName !== branch
        ) {
          errors.push(
            `pull request head is ${prInfo.headRefName}, expected ${branch}`,
          );
        }
        if (
          prInfo?.headRefOid !== undefined &&
          prInfo.headRefOid !== args.expectedHeadSha
        ) {
          errors.push("pull request does not point at the validated commit");
        }
        if (
          prInfo?.baseRefName !== undefined &&
          prInfo.baseRefName !== expectedBase
        ) {
          errors.push(
            `pull request base is ${prInfo.baseRefName}, expected ${expectedBase}`,
          );
        }
        if (prInfo?.isDraft !== true) {
          errors.push("pull request is not a draft");
        }

        const pullRequest = {
          workItem: args.workItem,
          success: errors.length === 0,
          draft: true as const,
          prUrl: prInfo?.url,
          prNumber: prInfo?.number,
          branch,
          baseBranch: expectedBase,
          commitSha: head.stdout,
          summary: errors.length === 0
            ? `Draft PR #${prInfo?.number} submitted for ${branch}`
            : errors.join("; "),
          submittedAt: new Date().toISOString(),
        };
        const handle = await context.writeResource(
          "pullRequest",
          `pull-request-${args.workItem}`,
          pullRequest,
          {
            tags: {
              workItem: args.workItem,
              success: String(pullRequest.success),
            },
          },
        );
        if (errors.length > 0) throw new Error(pullRequest.summary);

        context.logger.info("Submitted {url}", { url: prInfo?.url });
        return { dataHandles: [handle] };
      },
    },
  },
};
