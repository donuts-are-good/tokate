# Harness and data transparency

[Setup guide](../README.md) · [Command and isolation reference](reference.md)

This document describes how Tokate 0.2.14 discovers tools, handles data, and
delegates authentication. Source links support the behavior described below.

## Current harness discovery and settings

Tokate uses the native Codex CLI with a ChatGPT login. Donors supply model and
effort explicitly.

- Help and shell completion use local command definitions without scanning tools,
  inspecting remotes, accessing GitHub, or starting inference. Invalid CLI inputs
  fail before prerequisite checks and workflow actions. When needed, repository
  discovery reads local `git remote -v` output and requires one unambiguous
  GitHub repository; it never fetches or calls a credential helper.
- Startup looks for `git`, `gh`, `codex`, `setsid`, and `bwrap` in absolute directories
  listed in `PATH`. It checks file existence and executable permissions. It does
  not recursively search the home directory or open harness configuration files.
- `tokate doctor` invokes `--version` on discovered tools and runs a local
  real sandbox probe. From a repository root containing `global.json`, it copies
  that file into the probe checkout and starts the selected system .NET
  SDK/MSBuild under the same filesystem policy. It does not run inference, check
  authentication, or validate dependency restore/build success. See the
  [observed Linux matrix and limits](reference.md#linux-compatibility).
- Starting work invokes `codex login status` and checks the output for a ChatGPT
  login. Codex handles access to its own authentication storage. Tokate does not
  open that storage or request the credential value.
- Model and effort are explicit donor arguments, checked against repository
  policy. The agent invocation ignores user configuration and rules and supplies
  Tokate's own execution settings. This does not establish that every Codex
  subcommand ignores all configuration or authentication storage.

Source: [Cli.gs](../src/Cli.gs), [Completion.gs](../src/Completion.gs),
[Startup.gs](../src/Startup.gs), [Worker.gs](../src/Worker.gs).

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
[installation details](reference.md#installation) for retained setup markers.

Source: [install.sh](../site/install.sh), [Installation.gs](../src/Installation.gs).

## Authentication and process environments

GitHub operations use the donor's or owner's installed GitHub CLI. Git publishing
delegates authentication to `gh auth git-credential`. Codex authenticates its own
inference requests. Tokate does not copy credentials into task prompts, receipts,
or a shared account.

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
[API bounds and recovery](reference.md#commands-and-recovery) and
[ApiTransport.gs](../src/ApiTransport.gs).

Tokate clears each host command's child environment and copies only explicit
requirements using individual environment-variable lookups. It does not inspect
authentication files, mixed settings, `.env` files, or environment dumps to
infer harness defaults. Donors choose model and effort explicitly.

| Process | Inherited requirements |
| --- | --- |
| Ordinary host commands, including local Git and tool version checks | `PATH`, `HOME`, `LANG` |
| Native Codex login, version, execution, and sandbox invocations | The ordinary requirements plus `CODEX_HOME` when set |
| GitHub CLI commands and Git push with `gh auth git-credential` | The ordinary requirements plus `GH_TOKEN`, `GITHUB_TOKEN`, `GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR` when set |
| Agent shell commands | No inherited environment; fixed system `PATH`, scratch `HOME`, scratch `TMPDIR` |
| Independent verification wrapper and owner commands | No inherited values; fixed system `PATH`, command scratch `HOME`/`TMPDIR`, `LANG=C.UTF-8`, `GIT_NO_REPLACE_OBJECTS=1`, and `GIT_GRAFT_FILE=/dev/null` |

`PATH` selects installed trusted tools, `HOME` locates tool-owned authentication,
and `LANG` supplies locale. `CODEX_HOME` preserves an explicitly selected native
harness home. GitHub token variables and configuration paths preserve GitHub
CLI authentication; the D-Bus address and runtime directory preserve its Linux
keyring interface. These GitHub requirements reach Git push so its existing
GitHub credential helper can authenticate. They do not reach local Git or Codex.
Codex API-key variables are not passed; Tokate requires its ChatGPT login.

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

The trusted tool processes can still access their own host files and
configuration. Narrow environments do not isolate the complete harness or
make installed executables safe. Token values necessarily reach the GitHub
CLI and its host-side Git publishing helper, and Tokate handles those narrowly
selected environment values while launching them. They are not intentionally
logged or copied into prompts or public metadata.

The sandbox restricts repository commands, not the trusted harness host process
that authenticates inference. Installed executables remain trusted code.

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
discover or launch Codex. Each command starts with an empty mount namespace:
the canonical checkout is writable, its actual `.git` directory is read-only,
and `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, and the system tool links in
`/etc/alternatives` are read-only when present.
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

Source: [Process.gs](../src/Process.gs), [Worker.gs](../src/Worker.gs),
[Verification.gs](../src/Verification.gs), [Publish.gs](../src/Publish.gs).

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

- GitHub receives coordination records, branch commits, and the draft PR.
  The PR title comes from the approved public issue title, and its body comes
  from the approved public repository template with generated substitutions.
  `report` contains a fixed patch/review statement and the number of independent
  owner checks passed, not agent text, command arguments, or check output.
  Other substitutions contain the issue number, donor login, selected model and
  effort, elapsed seconds, base commit, policy digest, and only nonnegative
  integer `input_tokens`, `cached_input_tokens`, and `output_tokens` when supplied.
  Usage and model selection remain donor-reported, not independently attested.
  The receipt contains only version, repository, issue, donor, approval revision,
  head commit, model, effort, time budget, network choice, and policy digest for
  current approval/head validation. A separate run-ID marker supports publication
  recovery. No local filesystem paths are generated into the PR text.
  Branch names, Git commit contents, the approved issue title as commit message,
  and donor noreply commit identity are also public. Changes to tracked content
  and newly staged files become part of the PR and still require owner review.
- Codex receives the approved issue and accesses the checkout to perform the
  task. Inference sends task context through the donor's Codex service. A local
  CLI does not mean local inference or that repository content stays offline.
- Raw agent reports, event logs, stderr, verification output, arbitrary usage
  fields, and publication errors stay in local artifacts or terminal output.
  Publication does not read the raw report or copy these outputs into the PR.
  `pr-body.md` and `publication.json` save the generated body and exact PR-create
  request before Git push or PR creation. Inspect them together with
  `changes.patch` and the checkout; they also remain available after a publication
  failure. Version-1 `work` publishes automatically without another approval
  prompt. Version-2 `work` saves a verified commit for `submit`. `publish --run DIR` regenerates content and retries publication
  without inference; editing these saved previews does not change the generated
  request. Repository changes or an approved public template can nevertheless
  contain or reproduce sensitive content. There is no general secret scrubber.
- Agent command network access requires both owner policy and donor opt-in.
  Harness inference connectivity is separate. With command network access enabled,
  repository commands can contact additional destinations.

Tokate does not add a separate telemetry upload in these source paths. The
installed harness, GitHub CLI, and services have their own behavior and policies.
This document is not a claim about their retention practices.

Source: [Core.gs](../src/Core.gs), [Workflow.gs](../src/Workflow.gs),
[Worker.gs](../src/Worker.gs), [Contribution.gs](../src/Contribution.gs),
[Publish.gs](../src/Publish.gs).

## Bounded public-content audit

Owner audit evidence at main `22c3c80e77a526802488c84d4dccc0e489ed86e6`
covered 95 tracked files, 57 history messages/contact records, 56 anonymously
accessible patches plus the remaining patch through owner access, current asset
metadata, 49 served website files, three stable release archives/checksums, and
33 public issue/PR entries at that snapshot. No attachments were present. Owner
review scanned 76 available workflow log archives (237 entries, 21,930 lines)
with bounded patterns. Pages artifact `11219216581` contained 49 regular files
matching the tracked site. This change reuses that evidence without repeating
the audit.

No recognized credential values were identified in that review. It does not
cover deleted or edited prior material, all historical binaries and deployments,
arbitrary encodings, donor home credential stores, or private configuration and
`.env` files; it does not establish an absolute absence of secrets. The
harness, repository-content, local raw output, and external-service limitations
described above remain; runtime data boundaries are tracked in
[#17](https://github.com/obselate/tokate/issues/17).
Historical contact details are not reproduced here; their follow-up is tracked
in [#36](https://github.com/obselate/tokate/issues/36). An exposed credential would
require private revocation/rotation and removal coordination; deleting it from
the latest commit is insufficient. No history rewrite is authorized without a
separate concrete review.

Managed shell home and caches live at `/tmp/tokate-home` in private temporary
storage, outside recursive repository scans. Verification gets fresh storage
for each command. Historical `.tokate-scratch/` remains ignored,
alongside local run artifacts and environment files. Release packaging uses
fresh temporary staging, explicit current product documentation/license paths,
numeric zero archive ownership, and staging cleanup. Existing releases remain
unchanged. Direct Pages upload tightening belongs to owner-side
[#35](https://github.com/obselate/tokate/issues/35); ignore rules do not constrain
every publication path or prevent inclusion of already tracked files.

Users should be able to compare this document with the source for the version
they run. Update it whenever discovery, authentication, data handling, or
publication behavior changes.
