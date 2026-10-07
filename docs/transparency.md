# Harness and data transparency

[Setup guide](../README.md) · [Command and isolation reference](reference.md)

This document describes Tokate's tool discovery, authentication and data access,
with links to the source.

## Current harness discovery and settings

Managed execution supports native Codex with a ChatGPT login and version-2
[Pi local execution](pi.md) with a compatible installed SDK/runtime and an existing no-auth
loopback endpoint. Donors select exact tools and models and may save nonsecret
Tokate-owned defaults or named profiles. Pi requires `absent` effort. Its guide
covers runtime discovery, isolation and evidence limits.

- Help and shell completion use local command definitions without scanning tools,
  inspecting remotes, accessing GitHub, or starting inference. Invalid CLI inputs
  fail before prerequisite checks and workflow actions. When needed, repository
  discovery reads local `git remote -v` output and requires one unambiguous
  GitHub repository; it never fetches or calls a credential helper.
- Startup selects tools from the accepted command path, locates them in absolute
  `PATH` directories (or at the independent verifier's pinned system location),
  and executes version checks before actions. Help, completion, version, local
  status, defaults and init do not probe unrelated tools or authentication.
  Tokate does not recursively search homes or collect harness configuration files.
- `tokate doctor --owner|--managed|--external` checks only the selected role's
  tools; managed diagnostics cover Codex, not Pi readiness. No flags retains
  the local Codex probe without login. Managed and
  external scopes probe their respective real sandboxes and applicable pinned
  `global.json` SDK/MSBuild startup; this does not validate dependency restore
  or builds. Tool startup, PATH, login and catalogs do not prove model access
  or remaining subscription allowance. See the
  [Linux support limits](reference.md#install-and-check-support).
- Only explicit doctor `--auth` requests `gh auth status --hostname github.com`
  and (for managed Codex donors) `codex login status`. Diagnostics report sanitized
  statuses and repair actions, never raw tool authentication output. Tokate
  never opens authentication storage, installs tools or runs diagnostic inference.
- Starting Codex work invokes `codex login status` and checks the output for a ChatGPT
  login. Codex handles access to its own authentication storage. Tokate does not
  open that storage or request the credential value.
- `defaults set|read|list|remove` stores donor-entered harness, provider, exact model
  and effort in `~/.local/state/tokate/donor-defaults.json` or named files under
  `donor-profiles/`. Pi adds its private endpoint and only explicit runtime path
  overrides. Storage uses bounded strict JSON, private modes, atomic replacement
  and symlink refusal. Public output omits endpoint and runtime paths. Profiles
  contain no credentials, configured limits, budgets or network consent and read
  no harness settings. Pi rechecks model limits through its SDK on each use.
- Codex `select`, new claims and managed v2 preparation check exact owner restrictions
  and native Codex controls. `codex exec --help` and `codex debug models --bundled`
  run offline in an empty temporary `HOME`/`CODEX_HOME`, without inherited
  authentication. Only catalog model names and supported efforts are used; raw
  catalog output is not saved or displayed. Catalog presence is capability
  evidence, not account availability. Availability remains unknown or explicitly
  donor-reported. Selection never starts inference or changes saved preferences.
- Model and effort are checked against repository
  policy. New runs record selection evidence and revalidate capabilities before
  execution; saved runs never consult new defaults. Interactive choices require
  confirmation. Eligible explicit pairs and saved defaults need no repeated
  confirmation. Model failure never retries or falls back.
  The Codex agent invocation ignores user configuration and rules and supplies
  Tokate's own execution settings. This does not establish that every Codex
  subcommand ignores all configuration or authentication storage.

Source: [Cli.gs](../src/Cli/Cli.gs), [Completion.gs](../src/Cli/Completion.gs),
[Startup.gs](../src/Cli/Startup.gs), [Worker.gs](../src/Execution/Worker.gs).
Defaults and selection: [DonorDefaults.gs](../src/Cli/DonorDefaults.gs),
[DonorSelection.gs](../src/Cli/DonorSelection.gs).

## Installer access

The installer contacts public GitHub release URLs using curl with user curl
configuration disabled. It downloads a release archive and checksum, extracts
only the binary, verifies its version, and installs under `~/.local/bin`.
It does not open credential stores or `.env` files. The shell bootstrap runs in
the caller's process environment, so it is not an environment isolation boundary.
The `update` and `uninstall` CLI commands launch the embedded installer with only
`HOME`, `PATH`, `SHELL`, `LANG`, `ZDOTDIR`, `XDG_CONFIG_HOME`, and `TMPDIR` inherited.

Shell setup appends a guarded PATH hook without reading existing shell startup
contents. Installer-owned files under `~/.local/share/tokate` record setup state.
Fish gets a dedicated configuration snippet. No shell configuration contents are
uploaded. Uninstall preserves saved work and credentials. See
[installation details](reference.md#install-and-check-support) for retained setup markers.

Source: [install.sh](../site/install.sh), [Installation.gs](../src/Cli/Installation.gs).

## Authentication and process environments

GitHub operations use the donor's or owner's installed GitHub CLI. Git publishing
delegates authentication to `gh auth git-credential`. Codex authenticates its own
inference requests. Pi supplies configured model limits through its SDK without
loading authentication; see its [SDK boundary](pi.md). Tokate does not copy credentials
into task prompts, receipts or a shared account.

Automated version-1 approval/reassignment and all version-2 coordination-state
commits explicitly set both author and committer to `Tokate` with
`tokate@users.noreply.github.com`; GitHub supplies the timestamps. This generated
metadata does not prove an authenticated actor, a GitHub account, or a verified
signature and grants no authority. Write permission, canonical comment actor
and numeric identity, reservation ownership, scope approval, and receipt checks
remain authoritative. Donor attribution and receipt/provenance meanings are
unchanged; existing commits and records remain valid under their current rules.

The API boundary invokes sanitized `gh api --include` commands. It reads response
status and allowlisted nonsecret ETag, Retry-After, rate-limit remaining/reset,
Date and poll-interval metadata. Conditional reads keep bodies and ETags only
in command memory and require live revalidation. A conditional 304 accepts valid
weak or strong tags with the same opaque value, or a missing ETag, only with its
matching in-memory body. Malformed and unrelated validators fail closed.
Response headers, bodies and gh stderr are not persisted as diagnostics or
copied into errors. `--traffic`
reports only numeric attempted reads, mutations, live 304s and retries on stderr;
it excludes unseen GitHub CLI/Git requests and workflow executions. See
[API output and retry limits](reference.md#automate-commands) and
[ApiTransport.gs](../src/GitHub/ApiTransport.gs).

Version-1 `repair` uses a separate evidence directory when the original private
run is unavailable. It stores the exact original public receipt, numeric donor and
repository identities, live owner grant, candidate snapshot, new verification logs
and publication intent. It starts no inference and never reconstructs or attests
original private logs, usage or checks. The public repair provenance discloses this
gap; original public execution observations describe original work only. An exact
head lease plus ancestry validation protects branch publication, and saved intent
allows explicit publication resume without repeating passed verification. CI and
owner review remain required. See [Repair.gs](../src/Publication/Repair.gs).

Version-2 `request --file FILE` writes a local posting intent and lock beside the
request file. The intent contains the canonical repository/issue, numeric actor,
exact validated payload and binding hash, with no credentials or API response logs.
It prevents an interrupted comment POST from being repeated without unique remote
evidence. These records are not published or used to cache authority. Explicit
checks watches use conditional commit check/status APIs; unchanged snapshots do
not rewrite local results. Workflow event/job counts in tests are fixture-derived
bounds and do not establish actual hosted runner executions.

Tokate clears each host command's child environment and copies only explicit
requirements using individual environment-variable lookups. It does not inspect
authentication files, mixed settings, `.env` files, or environment dumps to
infer harness defaults. Donors choose model and effort explicitly, including
explicitly saved Tokate defaults.

| Process | Inherited requirements |
| --- | --- |
| Ordinary host commands, including local Git and tool version checks | `PATH`, `HOME`, `LANG` |
| Native Codex login, version, execution, and sandbox invocations | The ordinary requirements plus `CODEX_HOME` when set |
| Offline Codex selection probes | No inherited values; fixed system `PATH` and empty temporary `HOME`/`CODEX_HOME` |
| GitHub CLI commands and Git push with `gh auth git-credential` | The ordinary requirements plus `GH_TOKEN`, `GITHUB_TOKEN`, `GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR` when set |
| Agent shell commands | No inherited environment; fixed system `PATH`, scratch `HOME`, scratch `TMPDIR` |
| Independent verification wrapper and owner commands | No inherited values; fixed system `PATH`, command scratch `HOME`/`TMPDIR`, `LANG=C.UTF-8`, `GIT_NO_REPLACE_OBJECTS=1`, and `GIT_GRAFT_FILE=/dev/null` |

The table covers shared host commands and the Codex route; Pi's isolated SDK
environment is described in its guide.

`PATH` selects installed trusted tools, `HOME` locates tool-owned authentication,
and `LANG` supplies locale. `CODEX_HOME` preserves an explicitly selected native
harness home. GitHub token variables and configuration paths preserve GitHub
CLI authentication; the D-Bus address and runtime directory preserve its Linux
keyring interface. These GitHub requirements reach Git push so its existing
GitHub credential helper can authenticate. They do not reach local Git or Codex.
Codex API-key variables are not passed; the managed Codex route requires a ChatGPT login.

All host commands also receive fixed Git/GitHub controls: `GH_HOST=github.com`,
`GH_PROMPT_DISABLED=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`,
`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_NO_REPLACE_OBJECTS=1`, and
`GIT_GRAFT_FILE=/dev/null`. Other caller values, including inherited `GIT_*`
configuration, proxy settings, debug flags, and loader variables, are omitted.
Custom proxy, certificate, or home-directory toolchain setups may consequently
need a supported system installation; Tokate does not discover additional
requirements from private configuration or provide arbitrary passthrough.

Git orchestration and independent verification use canonical objects with
replacement lookup disabled. Candidate gates reject legacy `.git/info/grafts`
metadata and assume-unchanged or skip-worktree index flags before staging,
verification, or publication. Blocked files, flags, and saved records remain for
inspection. Version-1 publication also compares the canonical committed diff
with the saved verified patch; pushes name the saved commit SHA explicitly.

Host GitHub and Codex processes can still access their own host files and
configuration. Narrow environments do not isolate the complete harness or
make installed executables safe. Token values necessarily reach the GitHub
CLI and its host-side Git publishing helper, and Tokate handles those narrowly
selected environment values while launching them. They are not intentionally
logged or copied into prompts or public metadata.

For Codex, the sandbox restricts repository commands, not the trusted harness
host process that authenticates inference. Pi uses a separate outer SDK boundary
described in its guide. Installed executables remain trusted code.

Managed Codex execution and sandbox probes run inside a bubblewrap mount
namespace with a fresh private `/tmp`. Run directories,
harness homes and tools located under host `/tmp` are rejected before inference.
They cannot be restored without exposing shared temporary data or compromising
the filesystem boundary.
The wrapper preserves the narrowly selected harness authentication environment.
The harness still owns access to authentication storage.
Tokate-launched runs fail closed when their managed sandbox preflight or
configuration is unsupported. Work executed outside this path is not sandboxed
by Tokate and must not be represented as such.
Private `/tmp` contents disappear with the namespace and do not carry over from
agent execution to verification. Scratch files inside the checkout remain local
run artifacts. The namespace is not whole-harness data isolation: the trusted
harness retains its host file access outside the private temporary directory.

Independent owner verification directly invokes Linux bubblewrap and does not
discover or launch Codex. Tokate copies the candidate checkout, including
ignored and untracked files, into a private disposable host directory. Ordered
checks share that copy; the saved checkout is not writable by verification.
The copy is removed after success, failure or handled interruption. Each command
starts with an empty mount namespace: the copy is writable and its `.git`
directory is read-only. `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, and the system
tool links in `/etc/alternatives` are read-only when present.
Only explicit nonsecret loader, certificate-bundle and DNS files from `/etc`
are copied into private invocation storage (at most 4 MiB each) and mounted
read-only. Copies stay linked until process cleanup finishes and are then removed,
even on failure; source replacement cannot invalidate nested mounts.
Host `/`, `/etc`, `/home`, `/run`, and `/var` are never mounted
wholesale. Checkout/Git path symlinks, Git symlinks, alternate object stores,
worktree Git files are refused before repository
code runs. The verifier does not inspect credentials or configuration to infer
additional mounts.

Each verifier has private `/tmp`, `/var/tmp`, `/dev`, and PID/IPC/UTS/user
namespaces, a fresh `/proc`, dropped capabilities and a clean environment.
Host credentials, sibling checkouts, run control files, logs and sockets are
outside its mounts. Network is isolated unless both owner policy and donor
opt-in permit it. Commands share the remaining total runtime budget and process
cleanup. Missing or unsupported bubblewrap fails closed without host execution.
Nested sandbox probes remain permitted. This verifies a checkout; it makes no
claim that coding work performed outside the managed path was sandboxed.

Source: [Process.gs](../src/Execution/Process.gs),
[Worker.gs](../src/Execution/Worker.gs),
[Verification.gs](../src/Execution/Verification.gs),
[VerificationWorkspace.gs](../src/Execution/VerificationWorkspace.gs),
[Publish.gs](../src/Publication/Publish.gs), and
[Amendment.gs](../src/Publication/Amendment.gs).

## Files, logs, and network destinations

Tokate reads repository task policy, approval, templates, issue content, and its
own saved run artifacts. It does not directly open `.env` files or credential
stores to discover settings. However, the checkout is readable by the agent and
verification commands. There is no blanket `.env` filename exclusion within that
checkout. Do not interpret the discovery behavior as a guarantee that repository
content cannot contain or expose a secret. Neutral filenames can contain the
same sensitive values as `.env` files. Filename refusals protect Tokate control
files and unsupported repository Codex configuration; they do not prove secrecy.
Do not place private donor files in a checkout intended for inference or review.

Runs are stored under `~/.local/state/tokate/runs/`, or the selected `--runs`
directory. Artifacts include run metadata, the checkout, agent events, stderr,
the final report, verification output, the patch, PR body, publication request,
and check results.
These files persist for inspection and recovery. There is no automatic expiry or
general secret scrubber. Raw tool output can contain sensitive content if a tool
prints it. Command errors can also appear in terminal output.

Managed turns retain stdout in `events.jsonl` and stderr in `stderr.log` as
bounded decoded-text chunks arrive. Independent checks retain separate private
`verification-UUID/stdout.log` and `stderr.log` files within the run or correction
or amendment attempt. Each stream retains at most 32 Mi decoded characters;
excess output is drained and terminal records report truncation per stream.
Capture files are newly created with mode 0600; existing evidence and links are
refused. GitHub, credential and other host commands do not opt into this capture.

An interrupted check retains its active phase, partial output and prior completed
checks without inventing an exit code. A graceful timeout or cancellation retains
the failure reason after cleanup. Abrupt termination can leave only the prefix
already flushed, a trailing partial record and an unknown terminal state. This
is not a guarantee of every byte, power-loss durability or cleanup after SIGKILL.
Partial donor JSONL proves neither a completed turn nor usage and grants no retry
or publication authority. Raw captures stay local and are not printed by default
or copied into receipts, PRs, issue comments or remote coordination state.

Explicit pre-publication correction additionally retains `original-evidence/`,
including missing-file and link metadata, and separate `correction.json` and
`correction-UUID/` records. Capture-time checkout evidence has unproven original
model provenance. These archives, raw turn/report and check outputs stay private.
New receipts and v2 publication metadata may contain bounded correction UUID,
exact head/tree, patch digest, separate verification budget, declared correction
tools (or manual/unknown editing), and local exact-commit verification provenance.
Original execution/model/usage declarations describe only original work; unknown
runtime remains unknown. The coordinator treats local verification as donor
reported and still requires exact-commit CI and owner review.

- GitHub receives coordination records, branch commits, and the draft PR.
  The PR title comes from the approved public issue title, and its body comes
  from the approved public repository template with generated substitutions.
  `report` contains the validated candidate-bound public summary when supplied,
  or an explicit missing-summary review notice, plus bounded verification facts.
  It is never generated from private agent reports, logs or prompts. See the
  [public summary contract](reference.md#public-pr-summaries).
  Other substitutions contain the issue number, donor login, selected model and
  effort, elapsed seconds, base commit, policy digest, and only nonnegative
  integer `input_tokens`, `cached_input_tokens`, and `output_tokens` when supplied.
  Usage and model selection remain donor-reported, not independently attested.
  The v1 receipt contains version, repository, issue, donor, approval revision,
  head commit, model, effort, time budget, network choice, and policy digest for
  current approval/head validation; [v2 receipts](coordination-v2.md#external-or-tokate-launched-work)
  also bind contribution and authoritative state. Amendment receipts add an original head
  (v1) and separate amendment UUID, previous head, verification budget and
  donor-declared editing tools. Original model/time/usage cover original work only.
  Report and receipt markers identify Tokate-owned body regions; owner edits
  outside them are retained. Amendment candidates, detailed check output,
  archived originals and saved publication intent stay local. V2 amendment
  requests and coordination history expose bounded tool declarations and exact
  previous/new heads, with verification explicitly donor-reported to the coordinator.
  `amend` runs no inference and reads current approval, PR and fork before
  independent verification and publication; interrupted writes are resumed only
  from saved previous/candidate states. A separate run-ID marker supports publication
  recovery. No local filesystem paths are generated into the PR text.
  Branch names, Git commit contents, the approved issue title as commit message,
  and donor noreply commit identity are also public. Changes to tracked content
  and newly staged files become part of the PR and still require owner review.
- The selected managed harness receives the approved issue and optional root
  `DECREE.md` through [shared task context](reference.md#owner-codebase-instructions)
  and accesses the checkout. Codex sends inference context through the donor's
  service; Pi sends it to the selected loopback endpoint. A local CLI or endpoint
  does not guarantee offline processing; see [Pi network limits](pi.md).
- Raw agent reports, event logs, stderr, verification output, arbitrary usage
  fields, and publication errors stay in local artifacts or terminal output.
  Publication does not read the raw report or copy these outputs into the PR.
  `pr-body.md` and `publication.json` save the generated body and exact PR-create
  request before Git push or PR creation. Inspect them together with
  `changes.patch` and the checkout; they also remain available after a publication
  failure. Version-1 `work` publishes automatically without another approval
  prompt. Version-2 `work` saves a verified commit for `submit`. V1 `publish --run DIR`
  regenerates content and retries publication without inference. Explicit
  corrections instead retain an exact publication
  intent and inspect physical remote state before resuming; their previews must
  match that intent. Editing previews cannot change the request. Repository changes or an approved public template can nevertheless
  contain or reproduce sensitive content. There is no general secret scrubber.
- Agent command network access requires both owner policy and donor opt-in.
  Harness inference connectivity is separate. With command network access enabled,
  repository commands can contact additional destinations.

Tokate does not add a separate telemetry upload in these source paths. The
installed harness, GitHub CLI, and services have their own behavior and policies.
This document is not a claim about their retention practices.

Source: [Policy.gs](../src/Policy/Policy.gs), [GitHub.gs](../src/GitHub/GitHub.gs), [OwnerApproval.gs](../src/Policy/OwnerApproval.gs),
[Worker.gs](../src/Execution/Worker.gs), [Contribution.gs](../src/Execution/Contribution.gs),
[Publish.gs](../src/Publication/Publish.gs), [Amendment.gs](../src/Publication/Amendment.gs).
