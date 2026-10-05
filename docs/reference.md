# Tokate reference

[Setup guide](../README.md) · [Coordination](coordination-v2.md) · [Data transparency](transparency.md)

## Install and check support

```sh
curl -qfsSL https://tokate.dev/install.sh | sh
tokate update
tokate uninstall
```

Requires **Linux x86_64, glibc 2.34+, and public GitHub repositories**. ARM64,
musl, Windows and macOS are unsupported. Observations cover Ubuntu 24.04 x86_64 CI
and a rolling CachyOS x86_64 host, not every distribution or end-to-end inference
on every system. Blocked bubblewrap user namespaces, incompatible Codex permission
profiles and inaccessible system toolchains prevent managed execution.

The installer needs `curl`, `tar`, `sha256sum` and standard system tools; no sudo,
Codex or .NET runtime. It verifies the release archive checksum and binary version
before replacing `~/.local/bin/tokate`. Checksums detect corruption, not a compromised
release account. [Inspect the installer](../site/install.sh) or install a verified
archive manually from [Releases](https://github.com/obselate/tokate/releases).

PATH setup supports Bash, Zsh and Fish, using the account shell when `SHELL` is absent.
Open a new terminal if prompted; otherwise follow the printed PATH instructions.
Update/uninstall manage the installer location;
uninstall works offline and preserves saved work and credentials. Inactive shell
hooks remain for reinstall. Manual locations are not managed.

## Find a command

```sh
tokate --help
tokate work --help
tokate help work
```

Focused help gives complete syntax, defaults and effects; `-h` also works.
Help and completion require no login, GitHub access or inference.

Issue commands accept `--repo OWNER/REPO --issue 42` or a GitHub issue URL:

```sh
tokate work https://github.com/OWNER/REPO/issues/42 --model MODEL --effort EFFORT
```

Without `--repo`, Tokate uses the issue URL or unambiguous local GitHub remotes.
Conflicting remotes require explicit input. Value options accept `--name=value`.

Generate completion with `tokate completion bash`, `zsh` or `fish`. Load Bash
with `source <(tokate completion bash)`, Zsh likewise after `compinit`, or Fish
with `tokate completion fish | source`. Regenerate after updates.

## Set owner policy and approve

```sh
tokate doctor --owner --auth
tokate init
tokate policy --repo OWNER/REPO
tokate approve --repo OWNER/REPO --issue 42 --donor DONOR
```

Owners need GitHub CLI and `setsid`; approval requires repository write access.
`init` creates version-1 `.github/tokate.json` and `.github/tokate-pr.md`;
edit existing files. Commit policy, template and checks to the default branch
before approval; preserve template placeholders.

| Policy field | Owner choice |
| --- | --- |
| `models` | Nonempty map of exact model names to allowed effort arrays. |
| `model_policy` | Omitted/`whitelist` enforces that map; `unrestricted` requires omitted or empty `models`. |
| `max_seconds` | Total execution and verification limit, 1–86400 seconds. |
| `verification` | Nonempty argument arrays running the project's real checks. |
| `required_checks` | Exact GitHub check names required on the PR commit. |
| `allow_network` | False by default; permit only when needed. |
| `protected_paths` | Optional literal repository paths; final `/` protects a directory and descendants. No globs. |

Protected paths allow 64 entries of 512 characters each. `.github/workflows/`
and the `.github/tokate` prefix remain protected. Protect check dependencies too.

`--base-branch BRANCH` selects an approval target; omission prompts on a terminal
and otherwise uses the upstream default. Approval pins its exact base; policy and
template come from the default authority branch. Changed issue text, policy,
template or assignment needs fresh approval. `assign` replaces approval/donor;
`revoke` blocks publication, but cannot stop computation on another machine.

Version 2 is explicit opt-in. See [coordination setup and commands](coordination-v2.md)
for workflow installation, external tools, reservations and independent eligibility.

## Owner codebase instructions

Optional root `DECREE.md` supplies owner instructions captured from the approved
target commit. Use regular UTF-8 Git files, without NUL, at most 64 KiB; links and
LFS pointers are refused. New approvals capture presence, text and hash. Changes
to that snapshot require fresh approval; donors cannot edit or rename it.

Managed sessions receive owner instructions; external sessions receive no automatic
delivery. Instructions cannot expand permissions or donor budgets, and delivery
does not prove compliance.

## Prepare donor tools and defaults

```sh
gh auth login
codex login
tokate doctor --managed --auth
tokate select --repo OWNER/REPO --non-interactive
```

Use your own GitHub account and ChatGPT login. Fresh preparation discovers a
writable fork or creates one once; `--fork DONOR/NAME` selects a renamed fork.
Ambiguous or incomplete discovery requires explicit selection. Managed execution supports native Codex/OpenAI.
Credentials remain with their tools; never paste tokens into repository files.

`doctor` defaults to managed diagnostics; `--owner` and `--external` select other
scopes. It checks tool startup and applicable isolation without inference;
`--auth` adds tool-owned login status. Run from the repository root to probe a
pinned `global.json` SDK too. Missing, failed or skipped required probes block work.
Diagnostics do not establish dependencies, build success, account permissions,
model availability or remaining allowance. Repair prerequisites before donating.

Managed Codex supports Linux x64 native executables (including symlinks) and the
official npm `bin/codex.js` launcher with a matching nested
`node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`
or sibling platform package. These layouts are verified with Codex 0.160.0.
Tokate reads only bounded package metadata and executable headers to resolve the
native executable; it does not run launchers to discover files. Only that canonical
executable is exposed read-only; Node, package directories, home settings, credentials
and caches are not exposed. Offline selection uses the same native executable.
Other launcher/runtime layouts are unsupported. Codex prerequisites apply only to
the managed Codex route; owners and external donations do not require Codex.

Other tools and dependencies must work from standard system paths: repository
commands cannot use unrelated home tools or caches. Managed runs, harness homes
and tool installations must be outside `/tmp`. Run `tokate doctor --managed`
before donating; no global installation or sudo is required for Codex.

```sh
tokate defaults set --harness codex --provider openai --model gpt-6.1-sol --effort high
tokate defaults read
tokate defaults remove
```

Defaults store only donor choices locally. New work uses eligible defaults;
explicit model/effort options override them. `select` checks policy and the offline
Codex catalog without reserving or spending usage. Catalog presence does not prove
account availability; `--availability` is donor-reported. Missing/rejected choices
require explicit selection; noninteractive/JSON mode never picks a substitute.
Terminal choices require confirmation; `--yes` confirms, without choosing a replacement.

## Allocate time and network consent

`--seconds` covers coding plus independent verification, defaults to
`min(3600, owner max_seconds)`, and must be 1–86400 within the owner limit.
It is a time cap, not a token or subscription-percentage cap.

For new managed claims or v2 managed preparation, `--verification-reserve N`
reserves a positive amount smaller than the total. Coding and candidate capture
share `total - reserve`; checks use the remaining total, including unused coding
time. Omission reserves zero. Saved runs retain allocation; external work,
recovery and amendments reject this option. Timeouts preserve evidence and stop;
a reserve guarantees neither completion nor successful checks.

Command network access defaults off and needs **both** owner `allow_network: true`
and donor `--allow-network`. This includes dependency downloads. Inference
connectivity is separate. Isolation fails closed; it is OS sandboxing, not a VM.
Tokate does not sandbox external coding work. See [transparency](transparency.md)
for credential, environment, filesystem and published-data boundaries.

## Run and inspect work

```sh
tokate work --repo OWNER/REPO --issue 42 --model MODEL --effort EFFORT
tokate status --run DIR
tokate checks --run DIR --watch
```

**Inference spends donor usage.** Obtain donor authorization before `work`.
Tokate does not automatically retry failed inference or switch models. A new
inference attempt after failure requires fresh owner approval.

Version 1 prepares a checkout, runs inference and every owner check, then publishes
a draft PR. Version 2 saves a verified commit; use `submit --run DIR` for coordinated
publication. To reserve v1 work without inference, use `claim` with the same task
options, then `work --run DIR`. Saved work retains its original selection; do not
combine `--run` with new-claim options.

Save the run directory (default `~/.local/state/tokate/runs/`, configurable
with `--runs`). Keep raw events, reports, patches, logs and publication previews
private; they may contain secrets. Editing previews does not change requests.
Quiet output is not a reason to restart.

Foreground runs show phase, elapsed time and remaining allowance on stderr.
Plain, redirected and JSON output uses increasingly spaced updates. Raw output
stays in private artifacts. Progress does not prove agent activity or extend the
budget.

## Recover or correct work

Inspect `status` and private evidence first. No recovery command starts inference.

| Situation | Explicit next action |
| --- | --- |
| Failed/incomplete inference | Inspect logs; request fresh approval before another inference attempt. |
| Completed v1 turn, verification failed | Fix the cause; `tokate recover --run DIR --seconds 300` reruns all checks under unchanged approval. |
| Successful v1 work, publication failed | `tokate publish --run DIR` inspects existing publication and resumes without inference. |
| Stale approval or expired reservation | Return to the owner. |
| Interrupted fresh preparation | `tokate prepare --run DIR` inspects recorded fork, branch and checkout state without inference, checks or publication. |
| Dirty, divergent or unidentified preparation | Inspect preserved work and use its original run, or move local files aside explicitly; do not delete branches to restart. |

To seed a **fresh v1 attempt** from unpublished interrupted managed work, the
owner first names its still-current, valid, unrevoked approval:

```sh
tokate approve --repo OWNER/REPO --issue 42 --donor DONOR --continue-approval PRIOR_APPROVAL_SHA
```

This grant retains the predecessor's exact original base, target branch, issue
scope, policy, template and root owner instructions, with a fresh nonce and an
explicit predecessor binding. It refuses changed or revoked authority and cannot
be combined with `--base-branch`. Advancing the target's code alone does not
change the imported work's approved base.

The same authenticated numeric donor explicitly selects a new total budget and
positive verification reserve, then confirms inference normally:

```sh
tokate work --repo OWNER/REPO --issue 42 --continue-from PRIOR_RUN_DIR --model MODEL --effort EFFORT --seconds 3600 --verification-reserve 1200 --yes
```

`claim` accepts the same import options to prepare without inference. This first
bridge supports only stopped, unpublished same-donor v1 managed runs with the
recorded preparation protections and explicit owner-instruction snapshot. V2
lease continuation, published-PR handoff and unsupported legacy layouts are
excluded. The source's exclusive lease must be free. Its checkout, branch,
metadata, logs, failure and attribution remain preserved; no missing completion,
usage, report or verification is reconstructed.

Capture is limited to 1000 changed regular files, 32 MiB of edit bytes and 100000
inventory paths. Protected paths, unsafe names, symbolic/hard links, mount
crossings, submodules, file/directory replacements and inconsistent staged edits
are refused. Known
generated directories, including `.verification-data/`, `.tokate-scratch/`,
credential homes, package caches and build output, are excluded by name without
reading their contents; logs and runtime artifacts stay with the source. Approved
bases that track excluded paths are unsupported. Git metadata is freshly prepared
from the approved base; donor hooks, configuration and credentials are not copied.

Interrupted capture/preparation retains one identified local attempt. Repeating
the import command identifies it and refuses a new reservation. Inspect `status
--run DIR`, explicitly use `prepare --run DIR`, then `work --run DIR --yes`.
Preparation accepts only the captured edits or a consistent partial import;
unrelated dirty work and changed manifests require explicit inspection. The
manifest is checked again immediately before inference. Imported edits are
untrusted task input: a new completed turn, every independent owner check on the
complete final diff from the original base, exact-head receipt validation and
owner review are still required. Private state and public provenance retain the
interrupted predecessor; the fresh attempt does not make it retroactively successful.

For an explicit correction **before first publication**:

```sh
tokate recover --run DIR --prepare
# Edit and commit DIR/checkout; leave it clean at exact SHA.
tokate recover --run DIR --commit SHA --seconds N --tools FILE
```

Preparation archives original evidence. This path supports completed
managed v1/v2 turns, including candidate or verification failures; external work
and failed/incomplete inference are excluded. Omit `--tools` for manual/unknown
editing; otherwise declare every editing tool using the [tool schema](coordination-v2.md#external-or-tokate-launched-work).
Recovery budgets must fit the original owner limit; corrections require explicit
positive `--seconds`.
Protected edits, changed candidates and stale authority block publication. Failed
correction checks preserve progress and require a new corrected commit.
V1 publishes after success; v2 retains the corrected commit for `submit`.

## Amend a published PR

Commit review edits in `DIR/checkout`, leaving it clean at an exact descendant of
the published head and approved base:

```sh
tokate amend --run DIR --commit SHA --seconds N --tools FILE
```

Omit tools for manual edits; declared tools must satisfy owner policy. Amendment
reruns all original checks within a separate positive budget bounded by owner
`max_seconds`, then updates the same
open PR with a nonforce push. Original evidence/usage stays separate from editing
provenance. Failed checks need a corrected commit. After interrupted publication,
explicitly repeat the identical command to inspect state and resume applied work;
v2 awaits its coordinator. Writes are not atomic; inspect uncertain remote state.

`original-evidence` preserves the original records and verification log directories
under a checked manifest. Linked evidence paths and changed or incomplete archives
block amendment and retry; the archive is never silently rebuilt.
Older amendment archives remain unsealed with logs in the run directory. Tokate
checks preserved records and log paths without reconstructing or sealing history.

## Repair when the original local run is unavailable

For an existing open, unmerged **v1 draft PR**, prepare a separate, self-contained
Git checkout from its exact remote head. Apply the owner-reviewed correction and,
when needed, merge the current target. Commit the result and leave the checkout
clean. The owner must explicitly authorize exact correction C and current target U
using the existing synchronization grant command:

```sh
tokate authorize-sync --repo OWNER/REPO --pr 10 --commit C --upstream U
tokate repair --repo OWNER/REPO --pr 10 --run REPAIR_DIR --path CHECKOUT --commit C --sync G --seconds N
```

`REPAIR_DIR` is a new, empty evidence directory outside the candidate checkout;
it is not a replacement original run. The authenticated numeric donor must match
the PR author and own the original writable branch repository. The exact receipt,
issue, approval, approved base, policy, template and live owner grant must agree.
Ambiguous ownership markers, legacy unmarked reports, v2, closed, merged and
ready-for-review PRs are refused. No handoff, inference, automatic merge or
reconstruction of private logs, usage or verification is performed.

Repair checks the complete candidate diff and protected trees, then runs every
original owner command independently with a separate positive `--seconds` budget
bounded by owner `max_seconds`. Network requires explicit `--allow-network` and
owner permission. The new report and receipt disclose unavailable original
private state and bind new verification to C. Original public observations remain
claims about original work only. Publication preserves maintainer text and Tokate
ownership markers; an exact head lease and ancestry checks prevent replacing a
changed remote branch. Required CI and final owner review remain outstanding.

`repair.json`, `candidate.patch`, verification logs and `publication.json` preserve
the same intent across interruption. Explicitly repeat the identical command to
inspect and resume publication without repeating passed checks. Failed or
interrupted verification refuses a repeat; inspect the evidence and prepare a
new corrected commit and owner grant in a new evidence directory. Writes are not
atomic: a lost push or body response can leave a temporarily invalid receipt.
Changed authority, candidate or owned regions block resume. Use `verify-pr` to
validate the exact remote receipt and `checks` to inspect CI; pending is not success.

## Synchronize with upstream

Prepare a local merge retaining the published head and exact current target;
resolve conflicts explicitly with the owner. The owner grants exact candidate C
and upstream U; the donor uses the printed grant G:

```sh
tokate authorize-sync --repo OWNER/REPO --pr 10 --commit C --upstream U
tokate amend --run DIR --commit C --sync G --seconds N
tokate revoke-sync --repo OWNER/REPO --grant G
```

Tokate checks ancestry and protected trees against authenticated U and reruns all
checks on C. Grants neither inspect private candidates nor grant final acceptance.
Revocation or target movement invalidates readiness. No automatic rebase, conflict
resolver, force push or inference is supplied. See [coordination](coordination-v2.md#compatibility-comes-first)
for v2 state and coordinator requirements.

## Check contribution overlap

```sh
tokate overlaps --repo OWNER/REPO --prs 12,34
```

Select 2 to 16 distinct PRs in one repository. This read-only command reports
observed heads, selected targets, checks, filename overlap and native GitHub
`blocked_by` dependencies. It never executes PR code.

Filename overlap is advisory; disjoint files do not prove compatibility.
Incomplete comparison evidence remains unknown. Open dependencies block their
dependency gate; closed-completed removes only that gate. Other resolutions need
owner review. The report grants no acceptance or merge order. Recheck `verify-pr`
and exact-head `checks` after changes.

## Review and accept

```sh
tokate verify-pr --repo OWNER/REPO --pr 10
tokate checks --repo OWNER/REPO --pr 10 --watch --timeout 1200
```

These read-only GitHub checks validate approval, receipt and exact head; they do
not execute PR code or attest model usage. Remote comparison requires fewer than
300 files. `checks --run DIR` also saves local results. Exit 0 means passed,
8 pending/watch timeout, 1 failure. **Pending, missing, cancelled or skipped required
checks are not success.**

Owners review acceptance criteria and limitations, approve first-time fork
workflows after inspecting the diff, and accept/merge changes themselves. Use
ordinary read-only `pull_request` CI without secrets and enforce checks in branch
protection. Verification cannot prove all correctness or human review; Tokate
never marks a PR ready or merges it.

## Automate commands

Every command accepts explicit `--json`; use `tokate help --json` and
`tokate help work --json` for arguments, required inputs and potential effects.
Parse stdout as one object; progress/diagnostics stay on stderr:

```json
{"schema_version":1,"command":"checks","status":"pending","exit_code":8,"data":{},"error":null,"next_actions":[],"truncated":false}
```

JSON never prompts. Schema version is independent of policy/receipt versions.
`command` names the invoked command. Status is `ok`, `pending` or `error`;
exit code matches the process. `error` is null or
`{code,message}`. `data` is a public command projection: successful `status` can
still describe a failed run. Use codes, not displayed messages:
`invalid_arguments`, `missing_tools`, `authentication_required`, `stale_approval`,
`invalid_state`, `verification_failed`, `inference_failed`, `command_failed`,
`output_too_large`.

`next_actions` contains executable argument arrays for separately authorized
invocations, never automatic retries. Output is bounded to 64 KiB including newline;
prose to 2048 characters and summary lists to 64 entries with total counts.
`truncated` signals omitted summaries. Paths, hashes, identities, scripts and
arguments stay complete; oversized safe output fails with exit 1, possibly after
effects completed. Inspect state before reinvoking.

Owner verification, including review amendments, runs in one private disposable
copy of the exact candidate. Commands run in order and share that copy; Git
metadata is read-only, and verification cannot write the saved checkout. The
copy is removed on success, failure or handled interruption. Tracked candidate
changes still fail verification. Logs and results remain in the run; ignored
and untracked donor files are never cleaned.

`status --run DIR` reports `storage.retained_bytes` and `storage.checkout_bytes`
(regular-file bytes without following symlinks), plus `storage.next_safe_cleanup`.
Keep runs for recovery and amendment. After acceptance and evidence backup, deletion
of a completed run must be explicit: later amendment will no longer be available.

Managed summaries include total `seconds`, `coding_seconds`, `verification_reserve`,
safe check arguments/exit codes and private `data.artifacts` paths, excluding raw
logs. Without `--json`, redirected `policy`/`status` retain unenveloped forms;
use the explicit contract for integrations. `--plain` selects plain human
text. `--traffic` adds numeric API counters on stderr. Reads have bounded retries;
GitHub mutations are never automatically retried. Details: [authentication and
API traffic](transparency.md#authentication-and-process-environments).

## Build and verify from source

Requires the exact SDK in `global.json` (currently .NET 10.0.401, roll-forward
disabled), Clang and zlib development headers for NativeAOT:

```sh
dotnet restore Tokate.gsproj --locked-mode
dotnet publish Tokate.gsproj -c Release --no-restore -o artifacts/linux-x64
install -m 755 artifacts/linux-x64/tokate ~/.local/bin/tokate
bash scripts/verify.sh
```

The verification script runs the formatter, build and full suite. Check managed
isolation separately with `artifacts/linux-x64/tokate doctor` and compatible native
Codex on PATH; simulated checks do not prove that boundary.
