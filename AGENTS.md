# Help a user with Tokate

Tokate coordinates owner-approved issues, donor work, verification and draft PRs. Donors use their own accounts and tools; no subscription quota or credentials transfer. Owners review and merge.

If you are executing an approved donor task, implement it within its permissions. Do not start another run, change owner policy, publish or merge from inside the task.

## Start here

1. Infer the user's role. Confirm the repository, issue and active GitHub account; read the issue and policy. Ask only for missing information.
2. Explain the next action briefly, perform authorized work and report the result. Track the affected account and repository; post comments only when authorized.
3. Use [README.md](README.md) for installation and `tokate help COMMAND` for installed syntax. New setup uses version 2 with Trusted task eligibility; assignment-bound approvals remain supported.

Supported: Linux x86_64, glibc 2.34+ and public GitHub repositories. Managed routes are native Codex with a ChatGPT login and version-2 [Pi](docs/pi.md) with its pinned SDK/runtime and existing no-auth loopback endpoint. Owners need neither harness. See [tested systems and limits](docs/reference.md#install-and-check-support).

## Guide a repository owner

1. Inspect the default branch, contributor instructions, checks and CI. Preserve local changes and customization. Confirm the account with `gh auth status` and `gh api user --jq .login`; owner actions need repository write access.
2. Run `tokate doctor --owner --auth`, then `tokate init --repo OWNER/REPO` from the repository. Review model restrictions, existing checks, policy, workflow and permissions before confirming. Setup requires the matching stable release and hosted shared workflow. Use [owner setup](docs/reference.md#set-owner-policy-and-approve) for Actions prerequisites and fields.
3. Run the checks and commit the reviewed configuration to the default authority branch before approval. Preserve template placeholders. Required checks must fail on broken tools; fork CI must be read-only without secrets. Leave unverified behavior in owner review criteria.
4. Write a small issue with scope, acceptance criteria and failure cases. Initialize access once, approve the task and grant access:

```sh
tokate access --repo OWNER/REPO --operation init
tokate approve --repo OWNER/REPO --issue ISSUE
tokate access --repo OWNER/REPO --operation list
tokate access --repo OWNER/REPO --operation trust --donor DONOR
```

Use `--operation grant --donor DONOR --issue ISSUE` for one issue. Requests grant no access. See `tokate access --help` for revocation and eligibility modes. Task, policy or PR-format changes need fresh approval; revocation separately blocks work and publication.

5. Share the issue, allowed selections and build prerequisites. Use `tokate verify-pr` and `tokate checks`; inspect the diff before approving fork workflows. Review acceptance criteria and [exact-commit CI](docs/reference.md#review-and-accept). The owner accepts and merges.

## Guide a donor

1. Use the donor's GitHub account and harness. Never request tokens or put credentials in files. Follow [Codex setup](docs/reference.md#prepare-donor-tools-and-defaults) or [Pi setup](docs/pi.md); `doctor --managed --auth` diagnoses Codex. Check project tools too; diagnostics do not prove dependencies, model availability or allowance.
2. Read the approved issue and `tokate policy --repo OWNER/REPO`. For Trusted access, request it if needed:

```sh
tokate access --repo OWNER/REPO --operation request --issue ISSUE --scope trust
```

Wait for the owner to grant access, then check eligibility and coordination:

```sh
tokate access --repo OWNER/REPO --operation check --issue ISSUE
tokate coordination --repo OWNER/REPO --issue ISSUE
```

3. Send [a claim request](docs/coordination-v2.md#requests-and-authoritative-state), wait for the coordinator and read the new state SHA. Use it for [managed preparation](docs/reference.md#run-and-inspect-work) or [external work](docs/coordination-v2.md#external-or-tokate-launched-work). Tokate discovers or creates a donor fork; `--fork DONOR/NAME` selects one explicitly.
4. Explain [budgets and network consent](docs/reference.md#allocate-time-and-network-consent); obtain authorization to spend usage. Run `tokate work --run DIR` once, then `tokate submit --run DIR` for v2 publication. Save the run directory; quiet output does not justify restarting.
5. Inspect local state with `tokate status --run DIR`. Wait for `tokate coordination --repo OWNER/REPO --issue ISSUE` to record the PR, then use `tokate checks --repo OWNER/REPO --pr PR --watch`. Report actual verification and owner action. Pending CI is not success. Keep logs private; reported usage does not prove model identity or billing.

Build tools must be system-accessible. Downloads need owner `allow_network: true` and donor `--allow-network`; inference connectivity is separate. See [transparency](docs/transparency.md) and the Pi guide for isolation limits.

## Legacy operations and recovery

Assignment-bound policies require the approved assigned donor. [V1 direct work](docs/reference.md#run-and-inspect-work) publishes after verification; v2 requires reservation, preparation and submission. Do not silently upgrade policy.

Inspect saved state before [recovery or correction](docs/reference.md#recover-or-correct-work); variants depend on policy version and completion. Use [amendments](docs/reference.md#amend-a-published-pr) for published work. Failed inference needs fresh approval. Preserve branches and evidence, repair prerequisites and return stale authority to the owner.

Never weaken owner checks, switch tools or models silently, bypass isolation or automatically retry failed work to obtain a green result.
