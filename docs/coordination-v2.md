# Contribution coordination

Version 2 coordinates contributions on GitHub independently of the coding tool.
The repository owner installs a small workflow; there is no hosted service or
polling daemon. Approval, donor eligibility, reservations,
contribution records, exact-commit CI and owner review do not require Codex.
Managed execution supports native Codex with a ChatGPT login and
[Pi local execution](pi.md) with its pinned SDK/runtime and existing no-auth
loopback endpoint. Other coding tools can contribute through the external
exact-commit path; this does not provide their managed launch integrations.

## Setup

New `tokate init` setup uses version 2 and Trusted task eligibility. Existing policy
and custom templates are preserved; `init --upgrade` explicitly upgrades legacy
policy without removing model restrictions. Commit the reviewed policy and workflow
and approve again. Existing runs and receipts retain their original authority;
there is no automatic conversion.

Changes to task, policy or template require fresh approval. Assignment changes
also invalidate assignment-bound approvals. Old work and state history remain
available, but changed approval does not preserve publication authority. Returning
to version 1 requires another policy edit and fresh approval; it does not erase
version-2 history or revive old authority.

Upgrade both the donor CLI and owner-pinned coordinator before using these features:

| Feature | Minimum version |
| --- | --- |
| Review amendments | 0.2.17 |
| Synchronization amendments | 0.2.21 |
| Independent task eligibility | 0.2.22 |

Original execution evidence stays separate from later edits. Amendment tools,
coding time and usage are donor-reported; omitted tools mean manual editing with
unknown time and usage. Synchronization requires a live owner grant for the exact
candidate and upstream revision. Revocation or target movement invalidates
readiness even after a physical PR update. See [amendments](#review-amendments)
and [synchronization](reference.md#synchronize-with-upstream).

For completed managed v2 work before publication, [explicit correction](reference.md#recover-or-correct-work)
retains original source/tools and uses the original unexpired reservation through
`submit`. External v2 work is excluded.

## Owner installation after a release

Use a stable Tokate release with its hosted shared workflow. Setup verifies the
release before writing adopter files.

For ordinary adoption, use `tokate init --repo OWNER/REPO`. To prepare only the
short workflow entry outside protected paths:

```sh
tokate coordinator-setup --repo OWNER/REPO --output tokate-coordinator.yml --yes
```

The entry pins the central workflow to the release tag's resolved commit, the
immutable numeric archive asset URL, archive SHA256 and exact binary member.
Setup checks the checksum sidecar and verifies the running binary against that
member before proposing files. It rejects unreleased, draft or prerelease versions.
The matching release must already host the reviewed central reusable workflow;
bootstrap refusal writes no adopter files. Review and install the entry as
`.github/workflows/tokate-coordinator.yml` yourself;
setup does not commit it. Ordinary public Actions runners suffice. The shared
workflow passes the event file to the released binary, without checkout or donor
code execution. Coordination uses contents write, issues read and pull-requests
write; admission reduces contents to read. The same entry handles PR admission
through `pull_request_target`, without executing contributor code. Setup checks
Actions event policies; allow the entry's events and external actors before use.
Keep fork verification in read-only CI without secrets. Rejection occurs after PR
creation and cannot stop CI already triggered or provide an unspoofable merge gate.
GitHub-token-created PRs do not trigger `pull_request_target`; coordinator creation
checks remain necessary, and later human events recheck admission. Completed
receipts, CI readiness and final acceptance remain separate owner checks.

For a task-scoped policy allowing managed Codex and external Claude work, for example:

```json
{
  "version": 2,
  "approval_scope": "task",
  "eligibility": "trusted",
  "model_policy": "whitelist",
  "models": {"gpt-6.1-sol": ["high"], "claude-sonnet-4-6": ["unknown"]},
  "allowed_tools": [
    {"harness": "codex", "provider": "openai"},
    {"harness": "claude", "provider": "anthropic"}
  ],
  "reservation_seconds": 86400,
  "max_seconds": 3600,
  "allow_network": false,
  "verification": [["bash", "scripts/verify.sh"]],
  "required_checks": ["verify"]
}
```

Use your project's actual checks. Reservations default to 24 hours, bounded
between 300 and 604800 seconds. They are separate from the compute/verification
budget. Every declared tool must match an allowed harness/provider pair. The
[model policy](reference.md#set-owner-policy-and-approve) defaults to the existing exact model/effort whitelist;
explicit `model_policy: "unrestricted"` permits any valid declared pair and requires
omitted or empty `models`. External unknown model/effort values retain their legacy
meaning and need an exact whitelist allowance when filtering is enabled. Under
either explicit mode, external effort `"absent"` declares a known lack of an effort
control and needs its exact pair in whitelist mode. Managed Codex rejects unknown
or absent controls; managed Pi requires `absent` under its explicit model policy.
See the [Pi policy requirements](pi.md). Never substitute a declaration to satisfy policy.

Both policy versions support optional [`protected_paths`](reference.md#set-owner-policy-and-approve)
with at most 64 literal paths, each at most 512 characters. Owners adopt it under
fresh approval and explicitly select any tools or inputs beyond the entrypoint.

## Independent task eligibility (0.2.22)

Upgrade the donor CLI and pinned coordinator to 0.2.22 before adopting this mode.
Existing v1/v2 policies without these fields keep exactly their assignment-bound
approval behavior. No approval, run or receipt is migrated. For an existing policy, add both
fields to a version-2 policy and commit it to the authority branch:

```json
"approval_scope": "task",
"eligibility": "trusted"
```

The mode must be exactly `open`, `trusted` or `manual`. Missing one field,
duplicates, other values and v1 declarations are rejected. The full policy text
remains hashed, so a mode change requires fresh approval. Initialize the separate
owner-controlled access ref, then approve task scope without a donor:

```sh
tokate access --repo OWNER/REPO --operation init
tokate approve --repo OWNER/REPO --issue 42
```

Task-scoped approvals retain task fingerprint, target, policy, template,
instructions and revocation checks. They neither assign a donor nor use issue
assignment to authorize access. `--donor` and `assign` conflict with task scope.
New approvals bind the numeric repository ID. The independent `tokate/access`
ref stores a bounded `access.json` with that ID and only current numeric account
membership: persistent trust, denied status and issue numbers. Login arguments
are resolved through GitHub's user identity API; stored usernames never grant access.

Authenticated repository writers can perform these noninteractive operations:

```sh
tokate access --repo OWNER/REPO --operation trust --donor LOGIN
tokate access --repo OWNER/REPO --operation untrust --donor LOGIN
tokate access --repo OWNER/REPO --operation grant --donor LOGIN --issue 42
tokate access --repo OWNER/REPO --operation remove --donor LOGIN --issue 42
tokate access --repo OWNER/REPO --operation deny --donor LOGIN
tokate access --repo OWNER/REPO --operation restore --donor LOGIN
tokate access --repo OWNER/REPO --operation check --issue 42 --json
```

`check` evaluates the authenticated donor against current task authority. Open
allows authenticated donors, Trusted requires persistent trust or an issue grant,
and Manual requires an issue grant. Deny overrides every mode and grant. Restore
removes denial; it does not create trust or grants. Removing one issue grant leaves
other grants intact; removing trust leaves issue grants intact. Missing, malformed,
unavailable or mismatched access authority fails closed, including in Open mode.
The JSON result uses the existing schema-version-1 envelope and bounded gate data.
Eligibility does not prove model availability, subscription quota or correctness.

Membership changes take effect without rewriting policy, approvals or saved work.
Claims recheck access before and after the contribution ref CAS; saved work and
receipts recheck current access, with another check immediately before inference
or publication. Access-ref and contribution-ref writes are separate transactions.
A concurrent revocation can leave a reservation or physical PR for inspection,
without valid execution/publication authority. Updates have one expected parent,
never force, and never automatically repeat uncertain writes. Access writes inspect
the remote result; contribution writes retain existing UUID-bound reconciliation.
Inspect current refs and saved artifacts before an explicit next operation.

## Requests and authoritative state

New task-scoped setup uses `approve --repo OWNER/REPO --issue 42` and separate
[donor access](reference.md#set-owner-policy-and-approve). Legacy assignment-bound
policies retain `approve --donor` and `assign`. `revoke` first serializes revocation
in version-2 state, then removes the approval label. Donor requests cannot approve,
accept, merge, assign or change policy.

```sh
tokate coordination --repo OWNER/REPO --issue 42
```

The output includes `sha` and `state.approval_id`. Put those exact values into a
new request file. A claim has this schema (replace the example identities):

```json
{
  "uuid": "ba8934f1-9a8b-4b22-9380-323fd7d9a5d3",
  "expected": "0123456789012345678901234567890123456789",
  "approval": "0123456789012345678901234567890123456789012345678901234567890123",
  "action": "claim",
  "metadata": {}
}
```

```sh
tokate request --repo OWNER/REPO --issue 42 --file claim.json
```

The CLI posts `/tokate ` followed by strict JSON; it does not acquire authority
locally. Read `coordination` after the workflow completes. The outcome records
the stable contribution UUID, lease UUID, active attempt, numeric actor and expiry.
Use the new state SHA to prepare work. The authenticated numeric comment author
comes from a fresh canonical GitHub comment. Request actor fields are forbidden.
Repository ID, issue URL, comment ID, author ID and unchanged comment body are
checked. Events are at most 1 MiB with depth 32; request JSON is at most 8 KiB,
with no duplicate/unknown keys, trailing data, commands, patches, credentials or
expressions. Tool/usage declarations admit only bounded identifiers and integers.

Authoritative state lives at `refs/heads/tokate/contributions/42`, in `state.json`.
Each update has exactly one parent: the expected previous state commit (the first
approval uses the approved base as its parent). Updates never force the ref.
Competing siblings cannot both advance it. Workflow concurrency only paces jobs;
correctness comes from the non-forced Git fast-forward. Approval identity is a
canonical content digest including an owner-generated nonce, not its own commit
hash. UUIDs bind the numeric actor, expected SHA, approval identity and canonical
allowed metadata. The latest 32 successful outcomes are stored in the same atomic
state update. Identical replay returns the recorded outcome without writes;
changed actor/content fails. An evicted request remains stale and cannot repeat
its effect. Replayed expired outcomes are historical results, not renewed authority.

## Lease transitions

Use the same request schema with `action` set to `renew`, `pause`, `resume` or
`release` and empty `metadata`. Each new request needs the current state SHA
and a new UUID. Saved requests are immutable; inspect current state after a lost
response and redeliver only the exact original request.

Renewal extends the lease without changing contribution identity, branch, PR,
active attempt or saved time budgets. Pause reserves the contribution for the
owner's `reservation_seconds` (default 24 hours) and fences out executing work.
Resume grants a fresh attempt fence; it never resumes coding automatically.
Release requires the current numeric lease owner even after eligibility revocation.
Renewal, resume, preparation and publication require current eligibility.

Release and expiry preserve saved work and publication evidence. Same-donor
reacquisition keeps contribution identity with a fresh attempt. A different donor
gets a new identity referencing the predecessor's immutable revision.
Fresh preparation uses an attempt-specific directory and preserves previous runs.
The stable branch can be reused only at the approved base without publication;
otherwise saved-work continuation remains unsupported. Legacy v2 leases remain
readable, but new lifecycle transitions require fresh owner approval.

## External or Tokate-launched work

Declare all tools in a JSON array. Fields are `harness`, `provider`, `model`,
`effort`, optional `usage` (numeric input/cached-input/output token counts) and
optional `coding_seconds`. Null/absent usage and time mean unknown. Mixed-tool
work declares each tool. These records never contain credential values. Keep
authentication in the donor's own GitHub and coding tools.

```sh
tokate prepare --repo OWNER/REPO --issue 42 --state STATE_SHA \
  --source external --tools tools.json --fork DONOR/REPO
```

Preparation creates or reuses a verified donor fork and prepares `RUN_DIR/coding`
at the approved source revision on `tokate/v2-RESERVATION_UUID`. Code with your own
tool, then push that branch to the selected fork. The upstream itself is allowed
only when its numeric owner ID equals your authenticated donor ID. Write access
alone does not qualify. `tokate prepare --run RUN_DIR` resumes recorded preparation
before coding; dirty or divergent work is preserved for explicit inspection.
See `tokate prepare --help` and [transparency](transparency.md).

Then run:

```sh
tokate external --run RUN_DIR --commit EXACT_COMMIT_SHA
tokate submit --run RUN_DIR
```

`external` authenticates fork ownership and its exact branch head, initializes a
fresh self-contained checkout, fetches the declared commit and approved base,
requires base ancestry, and refuses protected policy/workflow changes. It imports
no donor local Git configuration, hooks, alternates or arbitrary metadata. All
owner checks run through the existing independent bubblewrap verifier with clean
environment, read-only Git metadata, private temporary storage and both network
gates. A changed commit/checkout or failed check blocks submission. No inference
or ChatGPT login runs for external work. The local record labels verifier results
`tokate-observed locally` and tool identity, usage and coding time `donor-reported`.
Tokate cannot attest external identity or time. `max_seconds` bounds local
verification, not independently unobservable external coding time.

For Tokate-launched execution, prepare with `--source tokate` and exactly one
`codex`/`openai` or `pi`/`local-chat-completions` tool declaration, then
`work --run RUN_DIR` and `submit --run RUN_DIR`. Use the
[Codex preparation sequence](reference.md#run-and-inspect-work) or [Pi guide](pi.md).
Omitting `--tools` uses explicit selection arguments, or eligible Codex donor
defaults; see [donor selection](reference.md#prepare-donor-tools-and-defaults).
Optional `--verification-reserve N` allocates a positive part of the unchanged
total budget to independent verification; see [budgets](reference.md#allocate-time-and-network-consent).
The saved allocation is reused by `work --run` and cannot be overridden there.
An explicit declaration must match invocation choices. Tokate records its observed invocation/requested model and effort and
tool-reported usage locally. This still does not cryptographically attest model
identity or billing. `work` saves the verified commit; version-2 publication goes
through the coordinator. No silent model substitution or harness fallback occurs.

Optional root [DECREE.md instructions](reference.md#owner-codebase-instructions)
use the same approved snapshot and shared task context as managed v1 sessions.
Snapshot-bearing approvals also bind current target presence/content and protect
both donor rename endpoints. External sessions are not launched by Tokate and
receive no automatic instruction delivery. Use a supporting coordinator release.

`submit` posts a stable publication UUID and exact head/fork/branch, all declared
tools, source and `verification: "donor-reported-pass"`. The privileged coordinator
does not execute checks or trust this declaration as independently observed. It
checks the fork/head and bounded GitHub comparison data, creates a draft from the
owner template, and atomically records the contribution/outcome. Repository API
comparisons reaching the 300-file truncation boundary are refused for owner review.
Raw reports, check output, credentials and execution logs stay local.

Before execution, publication and receipt validation, Tokate rechecks task,
policy, template, eligibility and approval. Execution and publication also require
a live active attempt; publication requests use the exact current state SHA.
Before and after the PR write the coordinator revalidates authority and exact fork
head. A replaced contribution cannot authorize further publication. The PR write and
state update cannot be atomic together: an interrupted response is recovered by
finding the existing exact reservation/head/receipt PR. A race can leave a physical
but unaccepted PR; it has no valid authoritative contribution and needs owner
inspection. Do not infer approval from the existence of a PR.

```sh
tokate verify-pr --repo OWNER/REPO --pr PR
tokate checks --repo OWNER/REPO --pr PR
```

Version-2 receipts bind the expected predecessor state SHA and must match the
authenticated publication revision's sole parent, approval, contribution, fork,
branch and exact PR commit. `checks` requires every owner check
to pass on that commit and rechecks the head. Receipt validation is read-only and
never executes donor code. Acceptance and merging remain owner actions. Published
receipts remain verifiable across renewal, pause, release and expiry,
subject to current approval, eligibility and exact-head checks. Historical
publication evidence grants no current execution or publication authority.

## Review amendments

After review, commit corrections in the saved checkout and run
`tokate amend --run DIR --commit SHA --seconds N [--tools FILE]`.
Manual editing omits tools or uses `[]`. Every declared tool must satisfy policy.
The command reruns every original check in isolation, pushes without force and
posts a stable `amend` UUID against current published state. Its metadata contains
`fork`, `branch`, `previous`, `head`, `pr`, `seconds`, `tools` and
`verification: "donor-reported-pass"`; it grants no inference authority.
The coordinator reuses the open PR, replaces only owned report/receipt regions,
and appends amendment history while retaining the original contribution.
After the coordinator completes, repeat the identical command to record the new
head locally. Interrupted push/body/state responses are resolved by reading saved
previous/candidate state; applied writes are skipped. Changed authority, expired
reservations and ambiguous physical states require inspection, not a new attempt.
Exact-head CI and owner acceptance remain required. See [amendment recovery and
local evidence](reference.md#amend-a-published-pr).

## Traffic and validation

Only created `/tokate ` comments on issues can start a privileged coordinator
job. Ordinary comments create skipped workflow records. There is no background
polling or per-token update stream. Repeated requests authenticate and read state
but do not repeat a successfully recorded write. Failed mutations are not retried
automatically.

Keep `FILE.posting.json` beside its original `request --file FILE`. It records
private posting intent. Lost responses require unique remote evidence matching
the repository, issue, numeric actor, UUID and complete payload. Ambiguous or
changed evidence refuses another POST. Current approval and reservation remain
required, including for an already recorded submission. Cross-machine comment
POSTs cannot be atomic; local locks and state compare-and-swap protect local
duplicates and authoritative effects.

Check reads allow ten pages per endpoint; comment evidence allows twenty pages.
Larger histories fail closed. `checks --watch` shares one `--timeout` deadline
across authority reads, commands, retries and waits. Server polling and rate-limit
delays take precedence over the two-second minimum. Both receipt versions recheck
authority and head after reading checks. Unchanged snapshots produce no repeated
output or local state write. Check rows retain status, name and link; `workflow`
is empty because the REST endpoints do not supply it.

`--traffic` reports this command's API reads, mutations, live 304s and retries.
It excludes unseen Git/GitHub CLI traffic and release downloads. The
[traffic regressions](../tests/Scenarios/Traffic.gs) enforce request budgets with
fixtures; their workflow counts are event-derived bounds, not measurements of
hosted runner executions. See the [API limits](reference.md#automate-commands).
