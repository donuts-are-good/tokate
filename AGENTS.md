# Help a user with Tokate

Tokate lets a donor use their own local Codex subscription to implement an issue approved by a repository owner. It runs local verification and opens a draft PR. The owner reviews and merges it. No subscription quota or credentials transfer between people.

This guide is for helping someone set up or use Tokate. If you are already executing an approved donor task, implement that task within its permissions. Do not start another Tokate run, change owner policy, publish, or merge from inside the task.

## Start here

1. Identify the user's role: repository owner, compute donor, or both. Infer it from the conversation when possible.
2. Confirm the upstream repository, issue, and GitHub usernames. Read the issue and existing configuration before suggesting changes. Ask only for missing information.
3. Explain the next action in one or two sentences, perform authorized work, and report the result. Keep track of which account and repository each command affects.
4. Use [README.md](README.md) for installation and [docs/reference.md](docs/reference.md) for commands and limits. Check `tokate --help` against the installed version.

Supported: Linux x64, public GitHub repositories, and the native Codex CLI with a ChatGPT login. Owners do not need Codex installed.

## Guide a repository owner

### 1. Inspect the project

Find the default branch, existing build/test scripts, CI jobs, and contributor instructions. Inspect `.github/tokate.json` and `.github/tokate-pr.md` if present. Reuse existing checks and preserve local changes.

Use `gh auth status` and `gh api user --jq .login` to confirm the active GitHub account. Owner approval needs repository write access.

### 2. Set up appropriate checks and policy

Run `tokate init` from the target repository only if its Tokate files do not exist. Otherwise edit the existing files.

Customize `.github/tokate.json` for the actual project:

| Field | What to choose |
| --- | --- |
| `models` | Exact model names and effort levels the owner accepts and the donor can use |
| `max_seconds` | A bounded time budget covering the agent and independent verification |
| `verification` | Nonempty argument arrays for commands that genuinely validate this project |
| `required_checks` | Exact GitHub check names that must pass on the PR commit |
| `allow_network` | False by default. Enable only when the task or build requires network access |

Prefer the project's existing verification command. A small HTML/JS project might need page structure and `node --check`. A library might need a build and existing regression tests. Add a focused behavior check only where a real failure would otherwise go undetected. Do not create a large test suite just to adopt Tokate.

Required checks must fail if their tools are missing or broken. A skipped syntax check is not a passed syntax check. Explain what the checks cannot prove, such as browser layout or gameplay behavior. Keep those items in the owner's review criteria.

Run the selected checks before approval. Ensure CI runs on draft fork PRs with a stable job name, read-only permissions, and no secrets exposed to contributor code. Preserve the PR template placeholders. Commit the policy, template, and any agreed verification setup to the default branch before approving work.

### 3. Approve a concrete task

Help the owner write a small issue with the desired behavior, acceptance criteria, scope, and relevant failure cases. Have the donor comment if they are not eligible for assignment. Check existing comments before posting, and post only when authorized.

```sh
tokate approve --repo OWNER/REPO --issue ISSUE --donor DONOR
```

Send the donor the issue URL, allowed model/effort pair, and build prerequisites. Changing the issue title/body, policy, template, or assignment requires fresh approval. Additional comments alone do not invalidate approval.

### 4. Review the result

```sh
tokate verify-pr --repo OWNER/REPO --pr PR
tokate checks --repo OWNER/REPO --pr PR --watch
```

For a first-time donor, GitHub may wait for the owner to approve the fork workflow. Inspect the diff before approving it. Check acceptance criteria as well as CI. Leave final acceptance and merging with the owner.

## Guide a compute donor

### 1. Confirm readiness

Use the donor's own GitHub and ChatGPT accounts. Never ask them to paste tokens or copy credentials into the repository.

Run `tokate doctor`, then check the project's actual tool versions too. Doctor does not verify repository dependencies, model availability, or remaining subscription allowance. A tool appearing on PATH does not prove it starts.

The sandbox cannot use home-directory tools or package caches. Build tools need to work from standard system paths. Dependency downloads need both owner `allow_network: true` and donor `--allow-network`. Inference connectivity is separate from repository command network access.

### 2. Check approval and prepare a fork

Read the approved issue and policy. Confirm the assigned donor matches the active account. Do not grant approval on the owner's behalf.

```sh
tokate policy --repo OWNER/REPO
gh repo fork OWNER/REPO --clone=false
```

Reuse an existing fork. Use `--fork DONOR/NAME` if it has a different name.

### 3. Run once

Use an allowed model and effort. Running this command spends the donor's allowance, so it needs the user's authorization to donate compute.

```sh
tokate work --repo OWNER/REPO --issue ISSUE --model MODEL --effort EFFORT
```

Save the printed run directory. Tokate creates its own checkout, verifies the result, and publishes a draft PR. Do not run the task again just because output is quiet. Use `tokate claim` with the same options only when the user wants to reserve work for later, then `tokate work --run DIR` to execute that claim.

### 4. Report the outcome

```sh
tokate status --run DIR
tokate checks --run DIR --watch
```

Report the PR URL, verification result, and any action needed from the owner. Keep logs private and remove secrets before sharing them. Report usage as supplied by the runner, not as independently proven model identity or billing.

## Recover without wasting compute

| Situation | Next action |
| --- | --- |
| Missing or broken tool | Repair it before another run |
| Donor cannot be assigned | Have the donor comment, then let the owner approve again |
| Claim branch already exists | Find the existing run. Do not delete the branch and silently start another attempt |
| Approval changed or was revoked | Stop and return to the owner |
| Compute or verification failed | Inspect the saved logs. A new attempt needs fresh owner approval |
| Successful compute, publication failed | `tokate publish --run DIR` retries publication without inference |
| CI pending | Check for fork-workflow approval, a missing job, or a job still running. Pending is not success |

Never weaken owner checks, switch models silently, bypass the sandbox, or automatically retry failed compute to obtain a green result.
