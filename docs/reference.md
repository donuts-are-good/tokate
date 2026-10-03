# Tokate reference

[Back to the setup guide](../README.md)

## Installation

```sh
curl -qfsSL https://tokate.dev/install.sh | sh
```

The binary requires Linux x86_64 with glibc 2.34 or newer. Installation and update refuse
other operating systems, architectures, missing/non-glibc libc, and older glibc
before downloading or changing an installation. ARM64, musl, Windows, and macOS
are not supported. The minimum is a binary requirement, not evidence that every
Linux distribution works; see [Linux compatibility](#linux-compatibility).
The installer needs `curl`, `tar`, and standard system tools including
`sha256sum`. It does not need GitHub CLI,
Codex, Python, or a .NET runtime. It never uses sudo.

It resolves the latest stable GitHub release, downloads the archive and SHA-256
checksum over HTTPS, verifies the archive, and checks the binary's version before
replacing `~/.local/bin/tokate` atomically. Download or validation failures leave
the existing binary in place. The checksum detects corruption, not compromise of
the release account. [Read the installer](../site/install.sh) before running it
if you prefer to inspect downloaded scripts.

The installer sets up PATH for Bash, Zsh, and Fish. Bash/Zsh startup files receive
an appended, guarded reference to `~/.local/share/tokate/env`. Existing startup
contents are not read or rewritten. Fish uses its own `conf.d/tokate.fish` file.
Other shells receive a `.profile` hook and may need shell-specific PATH setup.
Open a new terminal when prompted. The installer also prints the absolute command
path for use in the current terminal.

```sh
tokate update
tokate uninstall
```

These commands work for installer-managed copies and do not require GitHub CLI
or Codex. Update uses the same verified download flow. Uninstall works offline
and removes the binary and active PATH configuration. It preserves saved runs,
forks, credentials, and repository files. Guarded Bash/Zsh/profile hook lines and
small setup markers remain so reinstalling does not duplicate them. The hooks do
nothing while the managed environment file is absent. Run `hash -r` if Bash still
remembers the removed executable in the current terminal.

For manual installation, download and verify an archive from
[Releases](https://github.com/obselate/tokate/releases), extract it, and put its
`tokate` binary in a directory on PATH. Installer management commands do not
manage arbitrary manual locations. Rerun the installer to adopt the standard
user-local location.

## Commands and recovery

Use `tokate --help` or `tokate -h` to list commands. Focused help includes required
arguments, defaults, examples and effects:

```sh
tokate work --help
tokate help work
tokate work -h
```

Help and completion run locally without prerequisite warnings, GitHub access or
inference. Unknown commands (including `unknown --help`), unknown or duplicate
options, missing values, invalid numbers and conflicting inputs fail with relevant
usage before prerequisite checks or workflow actions. Value options accept both
`--name value` and `--name=value`; flags such as `--watch` do not take a value.
Do not combine `work --run DIR` with new-claim options, or `checks --run DIR` with
`--repo` / `--pr`. `--watch` and `--timeout` remain available for saved-run checks.

```sh
tokate doctor
tokate init [--path DIR]
tokate policy --repo OWNER/REPO
tokate approve --repo OWNER/REPO --issue 42 --donor LOGIN
tokate approve --repo OWNER/REPO --issue 42 --donor LOGIN --base-branch release/next
tokate assign --repo OWNER/REPO --issue 42 --donor LOGIN
tokate revoke --repo OWNER/REPO --issue 42
tokate work --repo OWNER/REPO --issue 42 --model MODEL --effort EFFORT
tokate claim --repo OWNER/REPO --issue 42 --model MODEL --effort EFFORT
tokate work --run DIR
tokate recover --run DIR [--seconds 300]
tokate recover --run DIR --prepare
tokate recover --run DIR --commit SHA --seconds N [--tools FILE]
tokate publish --run DIR
tokate amend --run DIR --commit SHA --seconds N [--tools FILE]
tokate status --run DIR
tokate verify-pr --repo OWNER/REPO --pr 10
tokate checks --repo OWNER/REPO --pr 10 [--watch] [--timeout 1200]
tokate checks --run DIR [--watch] [--timeout 1200]
```

`work` starts inference and verifies the result. Version 1 then pushes and
publishes a draft PR. Version 2 saves a verified commit for `submit`.
See [version-2 commands and coordination](coordination-v2.md). `recover`, `publish` and `amend` can push and publish without inference.
`claim` writes a reservation branch and local run but starts no inference.
Owner approval commands write to GitHub. `policy`, `verify-pr` and `checks` read
GitHub; saved-run checks also write local results. `status`, help and completion
are local. `update` downloads and replaces Tokate; `uninstall` removes it offline.
`doctor` probes tools and the sandbox without inference.

### Explicit donor defaults and selection

```sh
tokate defaults set --harness codex --provider openai --model gpt-6.1-sol --effort high
tokate defaults read
tokate defaults remove
tokate select --repo OWNER/REPO --non-interactive
tokate select --repo OWNER/REPO --model gpt-6.1-sol --effort xhigh --non-interactive
tokate work --repo OWNER/REPO --issue 42 --non-interactive
```

Defaults contain only the four donor-entered choices in
`~/.local/state/tokate/donor-defaults.json`. These local operations require no
harness or GitHub tools. Tokate refuses symlinks and mixed settings; it never
imports harness defaults or credentials. Only `set` and `remove` change this file.

New `claim` and `work` commands use a compatible, eligible saved default; explicit
model or effort arguments override the corresponding saved choice. `select`
reads current upstream policy and explains a choice without reserving work or
starting inference. Managed selection currently supports only `codex/openai`.
Both policy versions enforce the selected model-policy mode; version 2 also requires
the exact harness/provider pair. No owner policy is changed.

Selection verifies explicit CLI controls with `codex exec --help` and exact
model/effort controls with `codex debug models --bundled`, using an empty temporary
home without credentials or user configuration. A missing catalog entry means
compatibility is unknown, so it cannot be selected for new managed work. This
offline catalog is capability evidence, never proof of account availability.
Older CLIs lacking these narrow interfaces require an update for new selection;
legacy saved runs keep their existing behavior.

Availability is `unknown` by default. Optional `--availability available|unavailable`
is explicitly donor-reported for the candidate model. An unavailable model is
excluded for this invocation; choosing another pair resets availability to unknown.
PATH, login and catalog presence never prove availability. Tokate does not rank
models or claim inference speed, quality or subscription cost.

Missing, rejected, incompatible or unavailable defaults require an explicit
eligible pair or a numbered choice in a terminal. Blank input cancels. Redirected
input/output and `--non-interactive` never prompt or pick an alternative, including
when only one pair is eligible. An eligible explicit pair or saved default needs
no repeated confirmation. A terminal choice requires affirmative confirmation
before inference. `--yes` confirms that choice; it cannot select a replacement.

Runs record the selected harness/provider/model/effort and evidence. New selections
are revalidated against owner approval and current installed capabilities before
execution. `work --run DIR` uses its original pair without reading preferences;
selection flags conflict with `--run`. Model failure stops without retries or
fallback. Existing runs from before this feature retain their pair and confirmation
behavior. Version-2 `prepare --source tokate` can use the same defaults/arguments
when `--tools` is omitted; an explicit tool declaration must match selection.
Unrestricted policy lists known managed pairs from the same offline catalog; it
never selects an alternative automatically. External and mixed-tool declarations
still validate every tool against owner policy.

### Explicit structured output

Every public command accepts `--json`, including `doctor`, `update`, `uninstall`,
help, completion, `--version`, and version-2 commands. It selects JSON independently
of redirection, TTY styling, or `NO_COLOR`. Parse stdout as exactly one object;
progress, prerequisite diagnostics, installer output and `--traffic` stay on stderr.
Invalid commands and options also return this envelope before prerequisite actions:

```json
{"schema_version":1,"command":"checks","status":"pending","exit_code":8,"data":{},"error":null,"next_actions":[],"truncated":false}
```

`schema_version` versions this public contract, independently of policy, saved-run,
approval and receipt versions. `command` is the invoked command name (global help
uses `help`, installed version uses `--version`). `status` is `ok`, `pending`, or
`error`; `exit_code` matches the process. `error` is null for success and pending,
otherwise `{code, message}`. `data` contains a command-specific public projection,
not an internal saved record. A successful `status` can describe a failed run in
`data.state` and `data.error` without making the status command itself fail.

Stable error codes are `invalid_arguments`, `missing_tools`,
`authentication_required`, `stale_approval`, `invalid_state`, `verification_failed`,
`inference_failed`, and fallback `command_failed`. `output_too_large` means the
complete safe result cannot fit the output budget. Do not match displayed messages
for control flow. Exit meanings remain 0 for success, 1 for failure, and 8 for
pending checks, including a watch timeout. Pending is not success.

`next_actions` is an array of complete executable argument arrays, for example
`["tokate","recover","--run","/absolute/run","--json"]`. Suggestions require an
explicit separate invocation and appropriate authorization; they never execute,
retry, prompt, change owner checks, or spend inference. Actions may be omitted when
state is unknown. Recovery suggestions still require completed-turn/report,
current-approval, protected-file and exact-candidate validation when invoked.
Authentication actions such as `gh auth login` are explicit interactive setup
commands; the original Tokate invocation does not run them.

```sh
tokate help --json
tokate help work --json
tokate status --run DIR --json
tokate checks --run DIR --json
tokate completion bash --json
tokate --version --json
```

Help metadata reuses the command/option definitions: `arguments` lists names,
values, descriptions and choices; `required_inputs` lists alternative required
input sets. `repository_inputs` explains explicit input, issue-URL and local-remote
alternatives, and `exclusive_run_inputs` identifies conflicting saved-run inputs.
`positional_arguments`, local/GitHub read/write `effects`, `inference`, and
`noninteractive` describe command behavior. Effects are potential effects (for
example checks writes locally only with `--run`); only `work` starts inference.
Defaults metadata includes `operations` with each mode's required tuple and effects.
JSON selection and confirmation never prompt, including in a terminal.
Completion returns the full script in `data.script`, suitable for decoding and
saving. Installed version is `data.version`. Diagnostics returns tool name,
status, path and setup hint without raw tool logs.

Structured stdout is at most 64 KiB including the newline. Display prose is at
most 2048 characters; summary lists have at most 64 entries with total counts such
as `verification_count` and `check_count`. `truncated` reports omitted summary
entries or shortened prose. Hashes, paths, identities, executable arguments and
scripts remain complete. A result that cannot fit safely fails explicitly with
`output_too_large` and exit 1; it never silently shortens a script or action. This
output failure can occur after command effects have completed, so inspect state
before invoking a command again. Output mode never makes command effects atomic.

Run summaries exclude raw harness events, reports, and verification stdout/stderr,
including arbitrary saved error text. Verification rows contain only complete
command arguments and exit codes. Errors use safe typed summaries. `data.artifacts`
provides absolute private artifact paths for explicit detail access with local file
tools. No additional detail retrieval or logging service is introduced. Keep these
artifacts private; raw files can contain credentials or repository secrets.
Correction and amendment summaries retain their exact candidates, budgets, state,
safe errors and verification arguments/exit codes. Original evidence and attempt
artifacts stay private. Legacy recovery is not suggested after correction preparation.

Compatibility: without `--json`, redirected `policy` still emits the original raw
policy object. Redirected `status` remains a top-level run summary without the
public envelope, but intentionally removes raw verification logs and arbitrary
saved error strings; it includes safe error summaries, bounded verification rows,
counts and truncation. Consumers relying on raw logs must read private artifacts
explicitly. New integrations should use `--json` and `schema_version`. Terminal
output remains readable, and ordinary help keeps its spacious layout.

New version-1 verification failures save `failure_reason: verification_failed`.
Recovery uses that reason independently of displayed wording. Old version-1 failed
runs without a reason retain an explicit compatibility path for the former exact
verification-failure sentence. Both paths preserve all recovery checks and perform
no additional inference. No approval/run/receipt version or original execution
provenance is migrated or reinterpreted.

### Issue URLs and local repository context

For commands accepting `--issue`, a GitHub issue URL can supply both repository
and issue. Pass it positionally or as an option:

```sh
tokate work https://github.com/OWNER/REPO/issues/42 --model MODEL --effort EFFORT
tokate approve --issue=https://github.com/OWNER/REPO/issues/42 --donor LOGIN
# From a repository with one unambiguous GitHub remote:
tokate work --issue=42 --model MODEL --effort EFFORT
tokate policy
```

Explicit `--repo OWNER/REPO` and `--issue N` remain available. `--repo` also accepts
an HTTPS GitHub repository URL with optional `.git` suffix. Explicit inputs must
agree with any supplied issue URL; matching values are accepted. Browser issue
URL fragments and queries are ignored. Pull request URLs and non-GitHub hosts
are rejected.

When `--repo` is absent and no issue URL supplies it, Tokate reads only local
`git remote -v` output. All fetch and push URLs must identify the same GitHub
repository, ignoring case and `.git`. HTTPS, `git@github.com:OWNER/REPO.git` and
`ssh://git@github.com/OWNER/REPO.git` remotes are supported. No remotes, unsupported
hosts or formats, and differing origin/upstream or push URLs require explicit
`--repo`; Tokate never guesses which repository should receive work. Explicit
repositories and issue URLs override local context. Help and completion never
inspect local remotes.

### Shell completion

Generate completion from the same command and option definitions as help.
Completion offers commands, command-specific options, reasoning efforts and local
directories; it never calls GitHub, fetches model lists or starts inference.
Load it for the current shell:

```sh
# Bash
source <(tokate completion bash)
# Zsh (initialize the completion system first)
autoload -Uz compinit && compinit
source <(tokate completion zsh)
# Fish
tokate completion fish | source
```

To persist it, save `tokate completion bash` output and source that file from
`.bashrc`; save Zsh output as `_tokate` in a directory on `fpath` before `compinit`;
save Fish output as `~/.config/fish/completions/tokate.fish`. Regenerate after an
update to pick up new commands and options.

`assign` replaces approval for an already approved issue. `approve` also issues fresh approval after a failed or abandoned attempt. Editing the issue, policy, template, or assignment requires fresh approval. Old runs then fail revalidation. Revocation blocks publication but cannot stop computation on another person's machine.

Policies of either version accept an optional top-level `model_policy` with exactly
`"whitelist"` or `"unrestricted"`. A missing field preserves the existing whitelist:
`models` must be a nonempty map of exact model identifiers to nonempty effort arrays,
and every chosen pair must be listed. Explicit `"whitelist"` has the same pair rules.
Explicit `"unrestricted"` requires `models` to be omitted or `{}`; a nonempty or
malformed map is contradictory. Null, other types/values and duplicate mode fields
are rejected. Unrestricted choice still validates model identifiers and effort
tokens; it does not establish model availability or choose a model automatically.

Owners opt in by editing and committing their policy, then issuing fresh approval.
Adding or changing the mode changes the policy byte digest and makes existing
approval authority stale. Saved approvals, runs, receipts and donor preferences
are retained without conversion. When upgrading to version 2, keep the existing
`models` restrictions unless the owner explicitly changes them. `init` keeps its
existing version-1 whitelist template. Managed choices use explicit arguments or
a compatible donor default. Both modes keep supported harness/provider controls, donor consent,
runtime limits, both network gates, independent verification and owner review.

Under an explicit mode, version-2 external declarations can use the effort token
`"absent"` for a known lack of an effort control. A whitelist must list that exact
model/`absent` pair; unrestricted choice permits it. `"unknown"` retains its legacy
meaning of unknown effort and is never converted to `"absent"`. Omitted/null effort
is invalid. Tokate-managed execution rejects absent or unknown controls before
inference and never sends these tokens as harness settings. Every declaration in
mixed external work is validated at preparation, publication and receipt review.
Version-2 amendment and correction editing declarations use the same external
rules, including explicit `absent`; original managed execution remains separate.

Policy versions 1 and 2 accept optional `protected_paths`, for example
`["scripts/verify.sh", "scripts/checks/"]`. Omitted or empty adds no paths;
`.github/workflows/` and the `.github/tokate` prefix remain protected. The limit
is 64 nonempty strings of at most 512 characters each. Use literal repository-relative
slash paths: no absolute paths, backslashes, controls, empty segments, `.` or `..`.
One final `/` protects the directory node and descendants at that slash boundary;
other entries match exactly. Globs, case folding and Unicode normalization are not applied.
Additions, deletions, content/mode/type changes and both rename endpoints are checked
against the exact approved base and head throughout verification and publication.
Protecting an entrypoint does not protect tools, manifests or test inputs it invokes;
owners choose additional paths explicitly. Adoption changes the policy hash and requires
fresh approval; existing approvals and receipts are never rewritten.

Fresh `approve` and `assign` accept `--base-branch BRANCH`. On a terminal, omitting
it prompts for a target with the upstream default branch as the default; redirected
commands use that default directly. Passing the option selects the same target
without a prompt. JSON commands use the default without prompting.
The approval pins `base_branch` and its exact `base` commit,
and records the repository default branch as `authority_branch`. Policy and PR
template always come from that authority branch, even when the target contains
different Tokate configuration.

Revalidation requires the selected target to exist, the default/authority branch
to remain unchanged, and current authority policy/template hashes to match.
Target movement preserves approval when applicable `DECREE.md` snapshot freshness
checks pass. Tokate displays the current target and approved revisions when they
differ and prepares the exact approved base.
Publication and receipt/check validation use the selected target. There is no
automatic rebase, reconciliation or readiness change. Records without
`authority_branch` retain their existing default-branch/base-branch and freshness
rules and are never migrated automatically.

### Owner codebase instructions

Owners may commit an optional root `DECREE.md`; no configuration or nested discovery
is needed. For example:

```markdown
Use the existing formatter and descriptive function names.
Keep GitHub transport in ApiTransport; share task context across adapters.
Run scripts/verify.sh and report the actual results and limitations.
```

Use a supporting release (Tokate 0.2.18+) for the owner, donor and version-2
coordinator. Older binaries do not gain delivery from a new approval record alone.
New v1/v2 approvals capture the complete text from the exact selected target
commit before approval writes, recording `decree.present`, lowercase `sha256`, and
`text`. Absence is valid; an empty file is present. Only regular Git blobs
(`100644`/`100755`), strict UTF-8 without NUL, at most 64 KiB of source bytes are
accepted. BOM, whitespace and line endings are preserved. Symlinks (including
in-repository targets), directories, submodules, LFS pointers, unreadable content,
malformed encoding, oversized files and truncated discovery fail explicitly.

Every Tokate-managed v1/v2 session receives the approved text in an identified
owner-instruction section through the shared task context, independently of
`AGENTS.md` discovery. Future adapters and resumed/handed-off execution that starts
a new managed session must use that builder; this feature adds no lifecycle
operations or harness support. Tokate currently launches Codex/OpenAI; external
coding sessions receive no automatic delivery. Authentication stays with the
harness. Instructions cannot expand Tokate permissions or donor budgets, and
delivery does not prove compliance.

For snapshot-bearing approvals, target addition, deletion or changed content,
including unsupported replacements, requires fresh approval. Unrelated target
advancement preserves the approved base. Donors cannot add, change, delete or
rename root `DECREE.md`; both rename endpoints are protected in managed changes,
external verification and coordinator publication. Working-tree/fork replacements
cannot supply session instructions. Full text is stored once in approval data,
not copied into saved runs, public PR reports or receipts.

Legacy approvals without `decree` derive instructions only when a new managed
session starts, from their immutable approved `base`, labelled **legacy
approved-base**. Old approvals, runs, receipts, freshness and donor-diff permissions
remain unchanged; routine reapproval is unnecessary. This does not establish
delivery to previous sessions or track live legacy `DECREE.md` changes.

`claim` reserves a branch without running inference. Use `work --run DIR` to execute it later. Runs are stored in `~/.local/state/tokate/runs/`, or the `--runs` directory. Each contains its claim, raw agent events and report, verification results, patch, generated PR body (`pr-body.md`), exact PR-create request (`publication.json`), and check results. Keep raw artifacts private. Tokate saves the publication previews before push or PR creation; `work` still publishes automatically. Inspect the previews and patch when reviewing saved work or recovering a publication failure. Legacy publication regenerates previews; explicit corrections preserve exact saved intent. Editing previews does not change the request.

`publish --run DIR` retries publication after a successful run without running inference again. `recover --run DIR` reruns all checks after a completed agent turn failed independent verification. Failed or interrupted inference requires fresh owner approval. Claim branches remain for inspection and can be deleted after review.

For review corrections, commit edits in `DIR/checkout`, leave it clean at that
exact descendant of the published head and approved base, then use `amend`.
Its separate positive verification budget cannot exceed owner `max_seconds`.
Omit `--tools` (or declare `[]`) for manual edits; otherwise declare every AI
editing tool using the [tool schema](coordination-v2.md#external-or-tokate-launched-work).
V1 permits Codex/OpenAI with its model/effort policy; v2 checks all allowed pairs.
Original execution/model/time/usage observations retain their original meanings.
Amendment editing time and usage are unknown or donor-reported, never attested.
All original owner commands run in the independent sandbox without inference.
Protected owner files, changed candidates/authority/remote heads and failed checks
block publication while preserving local progress and original evidence.

Amendment records and exact publication intent live in `DIR/amendments/SHA/`;
original artifacts remain unchanged and are archived in `DIR/original-evidence/`.
The same open PR receives a non-force push and an updated report/receipt;
owner text outside those regions is preserved. Re-run the identical `amend`
command after an interrupted publication to read remote state and skip applied
writes and passed checks. Failed/interrupted verification needs a corrected
commit. V2 posts a stable UUID request against current published state; await
the installed coordinator, then re-run that command to record completion locally.
An expired reservation needs owner action. Push, body and coordination updates
are not atomic: `verify-pr` rejects partial physical states until they agree.
No approval migration, inference retry or policy weakening occurs.


`--traffic` prints numeric `reads`, `mutations`, `conditional_responses` (live HTTP
304s), and `retry_attempts` on stderr, including failed commands. Reads and
mutations count attempted Tokate `gh api` invocations; retries are included in
reads. The counters exclude unseen GitHub CLI/Git transport requests and workflow
executions. Diagnostics contain no response bodies, headers, credentials, paths,
or raw logs and are not saved in run or receipt files. Opt-in does not change JSON
on stdout.

GitHub CLI retains authentication responsibility. API calls are serial, and
mutation starts are spaced at least one second apart in each Tokate process.
GET bodies and ETags are held only in memory for that command. Every repeated
read revalidates with `If-None-Match`; only a live 304 can reuse a cached body.
Returned ETags use weak comparison: a valid `W/"opaque"` and `"opaque"` match
the same case-sensitive opaque value, as required for GET `If-None-Match` by
[RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2).
Validators retain a 1024-character limit and reject embedded quotes, whitespace,
control characters, invalid prefixes and malformed quoted tags. A 304 without
an ETag can still reuse its matching in-memory entry; an unrelated or malformed
returned ETag, or a 304 without that entry, fails closed.
GET transport failures, 5xx responses and rate limits allow at most three
attempts within a total 60-second deadline, including subprocess time and waits.
Server Retry-After and exhausted rate-limit reset times take precedence over
the short retry backoff. A secondary limit without a delay requires at least
60 seconds, so the command stops with a retry time. Other 4xx responses are not
retried; only an HTTP 404 can count as a missing resource.

POST, PATCH, PUT and DELETE are never automatically retried. After a failure,
remote state may have changed even if the response was lost. Inspect that state
before retrying; for publication use the saved run's `publish` command, which
looks for an existing PR and reuses it without inference or another PR write.
Version 1 retains its original branch-claim semantics. Explicitly opted-in
[version-2 coordination](coordination-v2.md) adds authoritative single-parent
state updates, expiring reservations, replay recovery, external work and measured
workflow/command traffic budgets. Pause/resume/handoff and the remaining lifecycle
and traffic flows remain #14/#19.

`--seconds` caps agent execution plus independent verification. The default for new claims is the smaller of 3600 seconds and the owner's limit. Explicit budgets must be from 1 to 86400 seconds and cannot exceed the owner's limit. Saved runs keep their original budget. It is not a token cap. `--fork LOGIN/NAME` selects a renamed fork owned by the donor. Network access requires both owner policy and donor `--allow-network`.

Startup checks warn about missing tools. Owner commands work without Codex.
`doctor` checks all tools and probes the real managed sandbox without login or
inference. Run it from the repository root: when that directory contains
`global.json`, the same probe also starts .NET/MSBuild using that file's SDK
selection rules. Linked `global.json` files are refused. Install the required SDK in a standard system path; a
home-directory SDK is unavailable inside the sandbox. This checks SDK startup,
not dependency restore, the build, authentication, or model access. `NO_COLOR`
disables styling. Redirected output is plain, and `policy` and `status` output
JSON when piped.

Managed run directories, harness homes and tool installations must be outside
`/tmp`, which is replaced with private temporary storage. The default run
location meets this requirement. `doctor` uses a private directory under
`/var/tmp` and removes it after the probe.

The operating system must permit bubblewrap to create user namespaces. On
Ubuntu 24.04, an administrator may need to enable an AppArmor profile for
bubblewrap as described in the [Ubuntu release notes](https://discourse.ubuntu.com/t/ubuntu-24-04-lts-noble-numbat-release-notes/39890).
Run `doctor` after setup. Tokate does not change system security settings.

## Linux compatibility

The current NativeAOT binary requires symbols through `GLIBC_2.34`. The initial
observed matrix is deliberately small:

| System | Installation, update, removal | Real managed isolation probe |
| --- | --- | --- |
| Ubuntu 24.04 x86_64 CI | Passed with the actual binary and controlled release-download fixtures | Native Codex 0.160.0 passed in [run 37044046383](https://github.com/obselate/tokate/actions/runs/37044046383), with the CI bubblewrap user-namespace profile |
| CachyOS rolling x86_64 host, glibc 2.44, system .NET 10.0.401 | Same repository suite passed with the actual binary and controlled release-download fixtures | Native Codex 0.160.0 real probe passed, including the repository's pinned SDK/MSBuild startup |

For each matrix system, run `bash scripts/verify.sh` for the actual binary's
install/update/offline-removal lifecycle and refusal/preservation checks, then
`artifacts/linux-x64/tokate doctor` from the repository root with checksum-pinned
native Codex 0.160.0 available on PATH. These are separate checks: download and
Codex fixtures do not establish OS isolation. The real probe checks control-file
and Git metadata read denial, checkout and private `/tmp` writes, and now the
repository's `global.json` SDK/MSBuild startup. Earlier observations do not prove
this added SDK check on every matrix system; the real doctor result must pass
for the revision being validated.

No other distribution is claimed as tested. These observations do not establish
end-to-end inference on Ubuntu, all-distribution compatibility, or support for
every kernel/security policy. ARM64, musl, Windows, and macOS remain separate
decisions. Codex's own `linux-musl` download name does not imply musl support for
Tokate's glibc-linked binary.

Blocked user namespaces, denied namespace/mount operations, incompatible native
Codex permission profiles, and missing/inaccessible system SDKs are unsupported
execution configurations. Preserve the failing `doctor` output and record the
system, kernel/security configuration, Codex version, and SDK version for review.
Do not disable confinement, expose home tools/caches, or relax filesystem policy
to make a probe pass. An administrator must assess prerequisites; rerun `doctor`
after an approved environment fix before donating usage.

## Quality and review

The model whitelist controls eligible runs. It does not prove task correctness or cryptographically attest which model an arbitrary donor actually used.

Tokate applies these gates:

1. Pin owner-approved task text, base revision, policy, and template.
2. Enforce the selected model/effort pair and a runtime budget, including independent verification.
3. Require a completed agent turn, a report, and a nonempty patch.
4. Run every owner verification command separately. A failure prevents PR creation even if the agent claims success.
5. Reject changes to `.github/workflows/` and Tokate policy, approval, and template files.
6. Open a draft PR from approved public task/template data, a generated check-count summary, bounded donor-reported usage, and a minimal approval/head receipt. Raw agent reports and execution/verification output remain local. Owner review assesses acceptance criteria and limitations.
7. Require all named GitHub checks to pass for the exact PR commit. Missing, pending, cancelled, and skipped required checks never count as success.
8. Leave acceptance and merging to the owner.

Owners can inspect a PR without the donor's local run directory:

```sh
tokate verify-pr --repo owner/project --pr 43
tokate checks --repo owner/project --pr 43 --watch
```

`verify-pr` checks PR author, claim branch, commit, current approval, issue text, policy, and the reported model/effort pair. It is read-only and does not check out or execute PR code. Receipt validation is not independent proof of inference usage. `checks` also validates the receipt and checks the head before and after reading CI. `--timeout` bounds the entire operation, including
initial authority reads, check subprocesses, retries and waits. Watches use narrow
conditional reads for the exact commit and respect server polling/rate-limit delays.
Unchanged pending polls repeat neither output nor local state writes. It exits 0
on pass, 8 on pending or watch timeout, and 1 on failure. It never marks the PR ready or merges it.

Both receipt versions and coordinator publication recheck protected paths using
one authenticated GitHub comparison for the exact approved base and head. Missing,
mismatched or truncated evidence fails closed. Remote checks require fewer than
300 comparison files. The complete file list covers the comparison even when its
commit history exceeds the unpaged 250-commit response limit.
Local path evidence is NUL-delimited, bounded to 100000 names and 32 MiB;
undecodable UTF-8 names fail closed.

Keep required checks and human review enforced in GitHub branch protection. Use ordinary `pull_request` CI without repository secrets for fork code. Do not execute untrusted PR code in a privileged `pull_request_target` job. Client-side rules do not stop a malicious person from bypassing Tokate and submitting an ordinary PR. Tests also cannot prove every aspect of correctness. Clear acceptance criteria and owner review remain necessary.

## Isolation

See [Harness and data transparency](transparency.md) for discovery commands,
credential boundaries, environment inheritance, local logs, published data, and
the limits of the current implementation.

Tokate invokes tools with argument arrays, never interpolated shell command strings. Git hooks, filesystem monitors, external transports, and user/system Git configuration are disabled for orchestration. The repository is cloned without templates or submodules. GitHub credentials stay with the host-side GitHub/publishing commands.

Every host command starts with only explicit environment requirements. Codex receives `PATH`, `HOME`, `LANG`, and optional `CODEX_HOME`, without GitHub/API-key credentials. GitHub CLI commands and Git push receive narrowly selected GitHub authentication and Linux keyring variables; local Git and other tools receive only the base requirements. See the exact lists in [transparency.md](transparency.md#authentication-and-process-environments). User configuration, exec rules, hooks, plugins, host skill discovery, multi-agent features, and web search are disabled. Repository `.codex` configuration is rejected. Sandboxed commands have filesystem reads denied by default, with only minimal system runtime paths, the native Codex executable, the checkout, and private temporary storage allowed. `.git` is denied. The shell has a scratch home and temp directory at `/tmp/tokate-home`, outside the checkout. Each independent verification command gets a fresh scratch home. Bubblewrap gives each managed invocation a fresh private `/tmp`, including runtime IPC paths that ignore `TMPDIR`. Shared host temporary files are not mounted into that storage. A preflight probes read denial and temporary writes before starting inference. Repositories with `global.json` also receive a system .NET/MSBuild startup check. This does not verify dependency restore or model availability. Unsupported Tokate-launched sandbox configurations fail closed. External execution is not sandboxed by Tokate.

Independent owner verification uses Linux bubblewrap directly, without discovering or launching Codex. Each command starts from an empty mount namespace with a writable canonical checkout, its actual `.git` directory read-only, read-only standard system tool/runtime directories and `/etc/alternatives` links, and explicit nonsecret loader, certificate and DNS files. Host `/`, `/etc`, `/home`, `/run` and `/var` are never mounted wholesale. Checkout/Git symlinks and external Git layouts are refused before repository code runs. It uses private `/tmp`, `/var/tmp` and `/dev`, PID/IPC/UTS/user namespaces, dropped capabilities, and a clean environment with fixed system PATH and private HOME/TMPDIR outside the checkout. Host credentials, sibling contributions, control files, logs and sockets are outside its mounts. Nested sandbox probes are supported. Missing sandbox support fails closed; commands use the remaining total budget and existing process cleanup. This does not sandbox external coding work or change receipts.

Each selected runtime file is copied once into private invocation storage, with a
4 MiB limit per file, and mounted read-only. Storage inside the checkout or through
symlinks is refused. Copies remain linked through process
cleanup and are then removed, including on failure. Replacing or unlinking the
original source does not break nested verification mounts.

Agent and verifier network access default off and require both owner policy and donor opt-in. Allowing access permits outbound command traffic and should be limited to repositories the donor trusts. The Codex host still needs network access for inference. Installed Codex, bubblewrap and system administrators are trusted. This is OS sandboxing, not a separate VM or protection against kernel vulnerabilities. Run unfamiliar projects on a dedicated donor machine or VM.

Each subprocess uses one monotonic deadline for stdin delivery, execution and
output collection. Completion at or beyond that deadline fails, including a
blocked stdin writer. Process groups are killed on timeout, cancellation, and
normal completion; the process and all pipe workers are collected before returning.
No automatic repair loop uses additional inference. Time caps are not exact token
or subscription-percentage caps.

## Build from source

Requires the .NET SDK selected by `global.json` (currently 10.0.401, with roll
forward disabled) and a NativeAOT toolchain (Clang and zlib development headers).

```sh
dotnet restore Tokate.gsproj --locked-mode
dotnet publish Tokate.gsproj -c Release --no-restore -o artifacts/linux-x64
install -m 755 artifacts/linux-x64/tokate ~/.local/bin/tokate
```

## Development

```sh
scripts/verify.sh
```

Completion checks use Bash by default. Optional checks require only the shell
being tested: `artifacts/tests/tokate-tests --cli-shell zsh` or
`artifacts/tests/tokate-tests --cli-shell fish`. Tokate does not require these shells.

The pinned public G# SDK is 0.4.1150. Verification uses the pinned SDK formatter,
builds and publishes NativeAOT with warnings as errors, and runs a G# end-to-end
harness against the actual binary. It uses two simulated GitHub identities, real
local Git repositories, and deterministic Codex and release-download fixtures.
Tests use synthetic values for process environments, tool-owned authentication,
repository/output boundaries, cleanup, revocation, publication failures and
recovery, and install/update/removal without running
inference, downloading a release, or modifying GitHub. No external test framework
or Python runtime is required.
Owner verification tests use real bubblewrap, disable the fixture harness after
its completed turn, and check filesystem/environment isolation, read-only Git,
both network gates, nested probes, runtime-file replacement, unsafe-layout refusal and detached-descendant
cleanup on normal exit and timeout. Real-pipe subprocess checks cover successful
1 MiB input, delayed consumption exceeding the deadline, blocked-input cancellation,
descendant cleanup, failure meanings and output limits. These tests must pass on required Ubuntu CI;
fixtures do not replace the real verifier boundary.
The native runner uses two G# workers for the Native, Coordination, Correction,
Amendment, Decree and Targets suites, each through `Verification.Run` with a
1200-second bound.
Published binaries and `global.json` are prepared once in synthetic Git storage
so the verifier's existing read-only Git mount protects the shared suite inputs.
Each suite gets fresh process, temporary-directory and environment namespaces.
Outer suite calls set `allow_network` to literal `true` for synthetic loopback.
Inner managed and verifier fixtures enforce their own network grants.
Process, security, CLI, selection, verifier-boundary and installer groups stay
serial, as do ReadTraffic and the native TemporaryIsolation,
TemporaryHomeRejected and VerificationBoundary groups that write outside their
fixture root. A failure stops admission and drains the current peer under its
own bound; Ctrl+C cancels both active verifiers. The runner reports actual passed
group count and elapsed test time, including partial coverage on failure, and
rejects unknown suite and group selectors.
The real native Codex `doctor` probe is a separate required matrix check; passing
the deterministic suite does not establish the managed Codex boundary.

`tokate recover --run DIR [--seconds 300]` explicitly reruns all owner checks after a completed agent turn failed verification. It revalidates approval and the completed turn and report before archiving legacy managed scratch caches, preserves failure evidence, and publishes only after success. Incomplete turns leave those caches in place and run no verification. The separate verification budget cannot exceed the owner limit. No inference runs. The PR discloses recovery and unknown original runtime. Failed inference still requires fresh approval.

For an explicit correction before first publication, run `recover --run DIR --prepare`
**before editing**. Preparation runs no inference, verification or publication. It
atomically preserves original records, raw turn/report, approval, failed checks,
available staged binary patch, unstaged changes and untracked files in
`original-evidence/`. Links are recorded without following them. Missing original
artifacts remain explicit; capture-time checkout evidence is not reconstructed
model output. Repeated preparation preserves the same archive.

Correct and commit the checkout, leaving it clean at an exact 40-character SHA,
then run `recover --run DIR --commit SHA --seconds N [--tools FILE]`. The separate
positive verification budget is required and bounded by the original policy.
Omitting tools, or declaring `[]`, means manual/unknown editing. Other declarations
use the existing tool schema and must satisfy owner policy (v1 permits only
codex/openai with an approved model/effort). Every original owner command runs in
the existing independent sandbox. Head, tree, complete patch and cleanliness must
remain unchanged. Policy, template and workflow edits, including either rename
endpoint, are rejected. Original model, runtime and usage describe original work
only; correction editing and exact-commit verification are disclosed separately.

This supports completed native v1 and managed v2 turns, including staged whitespace
failure before candidate creation and first verification failure. External v2,
incomplete/failed inference, published work, another donor, stale approval and
expired/replaced reservations are refused. No authority is renewed or migrated.
Each correction has a separate UUID, candidate, budget, tools and results in
`correction.json` and `correction-UUID/`. Failed/interrupted checks retain progress
and require a new corrected commit for another explicit attempt.

V1 publishes a draft on the original claim branch after all checks pass. V2 saves
the corrected commit for `submit --run DIR`; the coordinator remains publisher.
Repeating a successful correction with the same candidate, budget and tools resumes
publication only, without rerunning checks. Publication intent is saved before
writes. Recovery inspects the branch, all matching PRs, and (v2) the exact request
and coordination outcome. An uncertain write with missing or ambiguous physical
state is refused instead of being blindly repeated. Keep the private evidence for
inspection; neither a failed check nor pending coordinator publication is success.
