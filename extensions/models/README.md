# @mgreten/graphite-draft-submit

A [swamp](https://swamp.club) model that submits an already-validated Git commit
as a **draft** GitHub pull request using the [Graphite](https://graphite.dev)
CLI (`gt`), then independently verifies the result with the GitHub CLI (`gh`).

The model is deliberately conservative. It never touches the working tree,
never amends or rewrites the commit, and refuses to submit unless the checkout
matches exactly what you say you validated: the current branch must equal
`expectedBranch` (no detached HEAD), the worktree must be clean, and `HEAD` must
equal `expectedHeadSha`. After `gt track` + `gt submit --draft` it queries
`gh pr view` and requires the returned pull request to point at the validated
SHA, branch and base, and to be a draft. Any mismatch is recorded on the
persisted `pullRequest` resource with `success: false` and the method throws, so
a bad submission never masquerades as a good one. The base branch is
configurable and defaults to `main`.

## Installation

```sh
swamp extension pull @mgreten/graphite-draft-submit
```

## Setup

Create a model instance. This model needs no global arguments — everything is
supplied per method call.

```sh
swamp model create graphite-draft-submit \
  --type @mgreten/graphite-draft-submit
```

## Usage

Submit the validated commit on the current feature branch as a draft PR based on
`main`:

```sh
swamp model method run graphite-draft-submit shipDraft \
  --arg workItem=WORK-201 \
  --arg repoPath=/absolute/path/to/checkout \
  --arg expectedBranch=feature-branch \
  --arg expectedHeadSha=<40-char-sha> \
  --arg baseBranch=main
```

The `submittedAt`, `prUrl` and `prNumber` fields are populated on the persisted
`pullRequest` resource, which you can then reference with a CEL expression such
as `data.latest("graphite-draft-submit", "pullRequest").attributes.prUrl`.

## Global Arguments

This model declares no global arguments.

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| _(none)_ | — | — | All inputs are supplied per method call. |

## Method: shipDraft

Submits an unchanged validated commit through Graphite and requires a
discoverable draft GitHub pull request.

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `workItem` | string (path-safe) | _required_ | Identifier used to name the persisted record (`pull-request-<workItem>`). |
| `repoPath` | string (absolute path) | _required_ | Absolute path to the repository checkout to submit from. |
| `baseBranch` | string | `main` | Parent branch the pull request targets. A leading `origin/` is stripped. |
| `expectedHeadSha` | string (40-char SHA-1) | _required_ | The exact commit that was validated; `HEAD` must match it. |
| `expectedBranch` | string | _required_ | The branch that must be checked out; refuses a detached or mismatched HEAD. |
| `draft` | literal `true` | `true` | Always a draft; the model only produces draft pull requests. |

On success the method writes a `pullRequest` resource with `success: true`,
`draft: true`, the PR URL/number, branch, base, commit SHA and a summary. On any
verification failure it writes the same record with `success: false` and a
summary explaining every mismatch, then throws.

## How It Works

1. `git rev-parse --abbrev-ref HEAD` — confirm the branch equals `expectedBranch`
   and the checkout is not detached.
2. `git status --porcelain --untracked-files=all` — refuse a dirty worktree.
3. `git rev-parse HEAD` — refuse a commit that differs from `expectedHeadSha`.
4. `gt track <branch> --parent <baseBranch> --no-interactive` then
   `gt submit -q --no-edit --no-verify --draft`.
5. `gh pr view --json url,number,isDraft,headRefName,headRefOid,baseRefName`
   inside a three-attempt retry with a one-second backoff, to tolerate the short
   delay before GitHub reports the new pull request.
6. Independent verification: the returned PR must be a draft and its
   `headRefOid`, `headRefName` and `baseRefName` must match the validated SHA,
   branch and base — otherwise the record is marked `success: false` and the
   method throws.

Prerequisites on the host running the method: `git`, `gt` (Graphite) and `gh`
(GitHub CLI, authenticated) must all be on `PATH`. The model declares these as
`git-available` and `submission-tools-available` checks.

## License

MIT — see LICENSE for details.
