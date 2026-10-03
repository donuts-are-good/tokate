# Opt-in contribution coordination

Version 2 coordinates contributions on GitHub independently of the coding tool.
The repository owner installs a small workflow; there is no hosted service or
polling daemon. Approval, the assigned-donor eligibility rule, reservations,
contribution records, exact-commit CI and owner review do not require Codex.
Tokate-launched inference currently uses Codex. Claude (#20), API providers
(#21), local models (#22), OMP (#29) and pi (#30) can already contribute through
the external exact-commit path; their launch integrations remain separate work.

## Compatibility comes first

`tokate init` still creates the unchanged version-1 policy and PR template.
Version-1 approvals, saved runs and receipts keep their original meanings and
commands. Nothing automatically converts them into reservations or interprets
their reported model usage as attested usage. Version-1 recovery remains a
version-1 operation. Explicit `recover --prepare` followed by
`recover --commit SHA --seconds N` also supports completed managed v2 turns before
first publication. It retains original source/tools and adds separate correction
provenance; `submit` still uses the original unexpired reservation and coordinator.
External v2 work is excluded. Existing default templates remain usable for version 2.

Opt-in requires an owner to commit policy version 2 and install the generated
workflow, then issue fresh approval. Changing policy, task, template or assignment
requires fresh approval in either version. Old approval refs and local work are
retained; their publication authority does not survive a changed approval or
policy. Version-2 state history retains replaced contributions and all older
outcomes in Git even when they leave the active window. Returning to version 1
requires an explicit policy edit and fresh version-1 approval. It does not erase
version-2 state or revive old authority. There is no in-place saved-run conversion.

Review amendments require Tokate 0.2.14 on the donor and the v2 coordinator.
Existing receipts remain readable without amendments; older v2 coordinators and
receipt readers reject the new amendment operation/fields. Owners upgrade their
pinned coordinator explicitly. Amendments support native v1 and v2 records
without migrating approvals or changing original execution, model, effort, time or usage meanings. Original
observations cover original execution only. Amendment tools, coding time and
usage are separately donor-reported; omitted tools mean manual editing with
unknown coding time and usage. V1 permits declared Codex/OpenAI tools with its
existing model/effort policy; v2 applies every allowed tool and model pair.
Amendments retain original evidence and exact previous/new heads locally. V2
retains the original contribution and adds UUID-bound amendment history under
the current published coordination revision.

## Owner installation after a release

Run the released binary with repository write access:

```sh
tokate coordinator-setup --repo OWNER/REPO --output tokate-coordinator.yml
```

This generates a file outside `.github`; it does not install or commit it. It
refuses an unreleased/draft/prerelease version, an existing output or coordinator
workflow, a bad archive checksum, or a binary that differs from the release
archive member. It resolves the release matching the running version, downloads
the archive and separate checksum sidecar, and pins the immutable numeric GitHub
release asset URL, archive SHA256 and exact binary member. The archive does not
contain its own checksum. Replaced assets have different numeric IDs; the pin
fails rather than silently following a replaced tag/asset.

Review the output, then install it as `.github/workflows/tokate-coordinator.yml`
and commit it yourself. Enable GitHub Actions PR creation in repository settings
if necessary. This donor contribution does not install the workflow. The workflow
never checks out/builds the repository and never runs donor code with its write
token. Job permissions are `contents: write` for the state ref, `issues: read`
for canonical comments/eligibility, and `pull-requests: write` for draft PRs.
Keep fork verification in ordinary read-only `pull_request` CI without secrets.

Extend the existing policy explicitly, for example:

```json
{
  "version": 2,
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
budget. Every declared tool must match an allowed harness/provider pair and
model/effort pair. Unknown model/effort values require explicit owner allowance;
never replace a real or unknown value with an allowed model to satisfy policy.
Expanded eligibility, pause/handoff/renewal and automated assignment/readiness
remain #12, #14, #27 and #28.

Both policy versions support optional [`protected_paths`](reference.md#commands-and-recovery)
with at most 64 literal paths, each at most 512 characters. Owners adopt it under
fresh approval and explicitly select any tools or inputs beyond the entrypoint.

## Requests and authoritative state

An owner uses the existing `approve`/`assign` commands with a version-2 policy.
`revoke` first serializes revocation in version-2 state, then removes the approval
label. Donor requests cannot approve, accept, merge, assign or change policy.

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
the reservation UUID, numeric actor, donor and trusted creation/expiry times.
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

Work in your own tool and push the result to your donor-owned upstream fork, on
`tokate/v2-RESERVATION_UUID`. Then run:

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
`codex`/`openai` tool declaration, then `work --run RUN_DIR` and `submit --run
RUN_DIR`. Omitting `--tools` uses explicit selection arguments or an eligible
Tokate-owned donor default; see [donor selection](reference.md#explicit-donor-defaults-and-selection).
An explicit declaration must match invocation choices. Tokate records its observed invocation/requested model and effort and
tool-reported usage locally. This still does not cryptographically attest model
identity or billing. `work` saves the verified commit; version-2 publication goes
through the coordinator. No silent model substitution or harness fallback occurs.

`submit` posts a stable publication UUID and exact head/fork/branch, all declared
tools, source and `verification: "donor-reported-pass"`. The privileged coordinator
does not execute checks or trust this declaration as independently observed. It
checks the fork/head and bounded GitHub comparison data, creates a draft from the
owner template, and atomically records the contribution/outcome. Repository API
comparisons reaching the 300-file truncation boundary are refused for owner review.
Raw reports, check output, credentials and execution logs stay local.

Before execution, publication and receipt validation, Tokate rechecks task,
policy, template, eligibility, approval, reservation expiry and expected state.
Before and after the PR write the coordinator revalidates authority and exact fork
head. A changed/replaced/expired donor has no valid receipt. The PR write and
state update cannot be atomic together: an interrupted response is recovered by
finding the existing exact reservation/head/receipt PR. A race can leave a physical
but unaccepted PR; it has no valid authoritative contribution and needs owner
inspection. Do not infer approval from the existence of a PR.

```sh
tokate verify-pr --repo OWNER/REPO --pr PR
tokate checks --repo OWNER/REPO --pr PR
```

Version-2 receipts bind the expected predecessor state SHA and must match the
current contribution state commit's sole parent, approval, reservation, fork,
branch and exact PR commit. `checks` requires every owner check
to pass on that commit and rechecks the head. Receipt validation is read-only and
never executes donor code. Acceptance and merging remain owner actions. An expired
reservation invalidates a receipt even when a physical PR remains; renewal is not
implemented in this initial core.

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
local evidence](reference.md#commands-and-recovery).

## Traffic and validation

Only created issue comments with a `/tokate ` prefix on real issues start a
privileged job. Ordinary comments still create **skipped workflow run records**:
count one event/workflow record per ordinary created comment, zero privileged jobs
and zero coordinator API calls. Each meaningful request creates one workflow run
and at most one privileged job. Duplicates still authenticate/read state but write
nothing after a successful recorded outcome. Failed/interrupted mutations are not
automatically retried. Operators redeliver the same request only after inspecting
state. There is no background polling or per-token update stream.

Measured deterministic actual-command budgets (successful GETs, no rate limits):

| Path | Reads | Mutations | Live 304s |
| --- | ---: | ---: | ---: |
| Claim | 9 | 3 | 1 |
| Identical replay | 4 | 0 | 0 |
| New draft publication | 31 | 4 | 19 |
| Publication recovery with existing exact PR | 31 | 3 | 19 |

Each state transition creates a tree, a single-parent commit, and a non-forced ref
update. Pacing/retry bounds and `--traffic` numeric diagnostics reuse the existing
transport. Counts exclude unseen Git/GitHub CLI transport and release downloads;
workflow records/jobs are counted separately above. Remaining lifecycle traffic
budgets remain #14/#19. The suite exercises actual binaries and real local Git
refs for competing claims, duplicate/changed replay, interrupted writes/responses,
expiry/late donors, revocation after PR creation, external verification without
Codex, bounded invalid events, released workflow setup and unchanged version-1
flows. A real native sandbox doctor remains a separate environment check.
