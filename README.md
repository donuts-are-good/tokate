# Tokate

**toh-KAH-teh**. Donate local Codex compute to approved GitHub issues.

One G# NativeAOT executable. GitHub holds the task, owner policy, assignment, approval, claim branch, PR, and checks. No coordinator server or Python runtime. This release supports Linux x64 and public GitHub repositories.

## Install

Build with .NET 10 and an installed NativeAOT toolchain (Clang and zlib development headers):

```sh
dotnet publish Tokate.gsproj -c Release -r linux-x64 -o artifacts/linux-x64
install -m 755 artifacts/linux-x64/tokate ~/.local/bin/tokate
```

The binary needs `git`, `gh`, `setsid`, and a current native `codex` executable with restrictive permission-profile support. Tested with Codex 0.159.3. It does not need .NET or Python installed on the donor machine. Verification commands also need the repository's build tools installed in standard system locations.

```sh
gh auth login
codex login
tokate --help
tokate doctor
```

Codex must use a ChatGPT subscription login. No quota or credentials move between people. Tokate runs work locally against the donor's allowance.

## Owner setup

From the repository:

```sh
tokate init
```

Edit `.github/tokate.json`, then commit it and `.github/tokate-pr.md` to the default branch:

```json
{
  "version": 1,
  "models": {
    "gpt-6.1-sol": ["high", "xhigh"]
  },
  "max_seconds": 1800,
  "allow_network": false,
  "required_checks": ["verify"],
  "verification": [["bash", "scripts/verify.sh"]]
}
```

Model names are exact. Efforts are allowed per model, not one global list. There are no silent fallbacks. Select names supported by your donors' Codex installation. `verification` is a nonempty list of argument arrays. Tokate runs these commands independently after the agent finishes. Replace the example with checks your repository actually provides. `required_checks` contains exact GitHub check names and cannot be empty.

Write an issue with explicit acceptance criteria and a bounded scope. Then approve and assign it:

```sh
tokate approve --repo owner/project --issue 42 --donor contributor
```

The donor must be eligible for GitHub issue assignment. A contributor who has commented on the issue can normally be assigned. Approval requires repository write permission. Tokate uses one assignee per issue.

Approval creates `tokate:approved` and an owner-written approval record on `tokate/approvals/42`. The record pins the issue text, donor, base commit, policy, and PR template. It does not change the default branch. Removing the label revokes approval. Editing the issue, policy, template, or assignment requires fresh approval.

```sh
tokate assign --repo owner/project --issue 42 --donor another-contributor
tokate revoke --repo owner/project --issue 42
tokate policy --repo owner/project
```

`assign` replaces approval for an already approved issue. `approve` can also issue fresh approval after a failed or abandoned attempt. Existing runs then fail revalidation. Revocation prevents compliant clients from publishing, but cannot remotely stop computation already running on another person's machine.

## Donating

Create a fork once, then run an approved task:

```sh
gh repo fork owner/project --clone=false
tokate work --repo owner/project --issue 42 \
  --model gpt-6.1-sol --effort high --seconds 1200
```

Tokate checks approval and policy before compute, reserves a deterministic branch in your fork, creates a separate checkout, runs Codex once, runs owner verification, and opens a **draft PR** upstream. The GitHub identity must match the assigned donor. `--fork contributor/renamed-fork` supports a renamed fork owned by that donor. Network access requires both `allow_network: true` in owner policy and `--allow-network` from the donor.

Claims for the same approval use the same branch and GitHub's atomic ref creation. A duplicate claim fails before compute. Exactly one donor is assigned. Changing the assignment replaces approval and invalidates the previous donor's claim.

To reserve now and execute later:

```sh
tokate claim --repo owner/project --issue 42 --model gpt-6.1-sol --effort high
tokate work --run /path/printed/by/claim
```

Runs live in `~/.local/state/tokate/runs/`, or the explicit `--runs` directory. Each contains the saved claim, agent events, report, independent verification output, patch, PR body, and check results. The agent cannot read or modify these control files through sandboxed commands.

```sh
tokate status --run /path/to/run
tokate publish --run /path/to/run
tokate checks --run /path/to/run --watch
```

`publish` retries Git/PR publication without inference. It checks the saved patch and commit, current owner approval, and remote branch before publishing. Failed or interrupted compute is never retried automatically. Ask the owner for fresh approval for a new attempt. Claims and approval branches are retained for inspection and can be deleted manually after review.

## Quality and review

The model whitelist controls eligible runs. It does not prove task correctness or cryptographically attest which model an arbitrary donor actually used.

Tokate applies these gates:

1. Pin owner-approved task text, base revision, policy, and template.
2. Enforce the selected model/effort pair and a runtime budget, including independent verification.
3. Require a completed agent turn, a report, and a nonempty patch.
4. Run every owner verification command separately. A failure prevents PR creation even if the agent claims success.
5. Reject changes to `.github/workflows/` and Tokate policy, approval, and template files.
6. Open a draft PR with acceptance-criteria reporting, actual verification commands, limitations, and a compute receipt.
7. Require all named GitHub checks to pass for the exact PR commit. Missing, pending, cancelled, and skipped required checks never count as success.
8. Leave acceptance and merging to the owner.

Owners can inspect a PR without the donor's local run directory:

```sh
tokate verify-pr --repo owner/project --pr 43
tokate checks --repo owner/project --pr 43 --watch
```

`verify-pr` checks PR author, claim branch, commit, current approval, issue text, policy, and the reported model/effort pair. It is read-only and does not check out or execute PR code. Receipt validation is not independent proof of inference usage. `checks` also validates the receipt and checks the head before and after reading CI. It exits 0 on pass, 8 on pending or watch timeout, and 1 on failure. It never marks the PR ready or merges it.

Keep required checks and human review enforced in GitHub branch protection. Use ordinary `pull_request` CI without repository secrets for fork code. Do not execute untrusted PR code in a privileged `pull_request_target` job. Client-side rules do not stop a malicious person from bypassing Tokate and submitting an ordinary PR. Tests also cannot prove every aspect of correctness. Clear acceptance criteria and owner review remain necessary.

## Isolation

Tokate invokes tools with argument arrays, never interpolated shell command strings. Git hooks, filesystem monitors, external transports, and user/system Git configuration are disabled for orchestration. The repository is cloned without templates or submodules. GitHub credentials stay with the host-side GitHub/publishing commands.

Codex gets an allowlisted environment without GitHub/API-key credentials. User configuration, exec rules, hooks, plugins, host skill discovery, multi-agent features, and web search are disabled. Repository `.codex` configuration is rejected. Sandboxed commands have filesystem reads denied by default, with only minimal system runtime paths, the native Codex executable, and the checkout allowed. `.git` is denied. The shell has a scratch home and temp directory inside the checkout. A preflight probes read denial before spending compute. Unsupported sandbox configurations fail closed.

Verification runs under the same filesystem boundary and a clean environment, with read-only access to Git metadata. Agent network access defaults off. Allowing it permits outbound command network access and should be limited to repositories the donor trusts. The Codex host still needs network access for inference. Installed Codex and system administrators are trusted. This is OS sandboxing, not a separate VM or protection against kernel vulnerabilities. Run unfamiliar projects on a dedicated donor machine or VM.

Process groups are killed on timeout, cancellation, and normal completion to clean up their background children. No automatic repair loop burns additional compute. Time caps are not exact token or subscription-percentage caps.

## Development

```sh
scripts/verify.sh
```

The pinned public G# SDK is 0.4.591. Verification runs strict GSLint, builds and publishes NativeAOT, and tests the actual binary with two simulated GitHub identities, real local Git repositories, and a deterministic Codex fixture. Python is only a development test dependency. Tests do not spend compute or modify GitHub.

The earlier Python prototype remains in Git history. Its `.state` and `.runs` artifacts are preserved locally, but native Tokate does not resume legacy runs.
