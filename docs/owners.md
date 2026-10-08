# Accept donations

Owners need Git, the GitHub CLI, repository write access and Tokate. A coding
harness or AI subscription is not required. Use public GitHub repositories.

## Set up once

```sh
gh auth login
tokate doctor --owner --auth
tokate init --repo OWNER/REPO
```

Run setup inside your repository. Choose model restrictions, project verification
commands, required CI checks, time limits and command network permission. Review
the proposed files before accepting. Commit the policy and workflow to the default
branch before approving work. Keep fork CI read-only, without secrets, and require
its checks in branch protection.

Setup uses a matching stable release. It creates `.github/tokate.json` and a small,
immutable shared-workflow entry. Existing configuration is preserved. Allow its
`issue_comment`, `pull_request_target` and `workflow_call` events in GitHub Actions
policies, including external actors. The coordinator does not execute donor code.
It can close PRs without current owner authorization. Review that behavior before
enabling the workflow.

New setup uses Trusted access and permits managed Codex. To permit local Pi,
include this pair in the policy's `allowed_tools` array before committing:

```json
{"harness":"pi","provider":"local-chat-completions"}
```

A model whitelist must include the exact local model ID with `["absent"]` effort.
Use `tokate init --help` for scripted setup and policy options. Optional root
`DECREE.md` contains task instructions captured at approval. It cannot expand
permissions or donor budgets. Use `protected_paths` to protect verification tooling
and other authority files beyond Tokate's built-in protections.

## Approve an issue and donor

Write a small issue with scope, acceptance criteria and failure cases, then run:

```sh
tokate access --repo OWNER/REPO --operation init
tokate approve --repo OWNER/REPO --issue 42
tokate access --repo OWNER/REPO --operation trust --donor DONOR
```

Initialize access once. Trust permits future approved tasks. Use `--operation grant
--donor DONOR --issue 42` for one issue instead. `--operation list` shows requests
and trusted donors. Requests grant no access. Open eligibility accepts authenticated,
non-denied donors. Manual eligibility requires an issue grant. Explicit denial
blocks participation in every mode.

Issue, policy or PR-format changes require fresh approval. Revoking donor access
also blocks new work and publication. Share the [donor guide](donors.md) and the
project's build prerequisites.

## Review and merge

```sh
tokate verify-pr --repo OWNER/REPO --pr 10
tokate checks --repo OWNER/REPO --pr 10 --watch
```

Inspect the diff before approving a first-time fork workflow. Every required check
must pass on the current PR head. Check scope, acceptance criteria, limitations and
conflicts before merging. Receipts validate recorded authority and commits. They
do not prove model identity, billing or semantic correctness. Tokate leaves final
acceptance and merging to you.

## Update the coordinator

Updating your local CLI does not update the repository's pinned coordinator:

```sh
tokate update
tokate coordinator-setup --repo OWNER/REPO --output tokate-coordinator.yml --yes
```

Review the generated entry and replace the existing coordinator workflow, preserving
necessary customization. Commit it before using features that need the new coordinator,
including readable request comments and continued-run submissions. Do not add a
second coordinator. See [recovery](recovery.md) when existing work needs attention.
