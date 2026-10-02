# Harness and data transparency

[Setup guide](../README.md) · [Command and isolation reference](reference.md)

This document describes the current Tokate 0.2.3 implementation and the agreed
requirements for future harness integrations. Planned behavior is not a claim
about protection already provided by the released binary.

## Current harness discovery and settings

Tokate supports the native Codex CLI with a ChatGPT login. Other harnesses and
automatic import of model or effort defaults are not implemented.

- Startup looks for `git`, `gh`, `codex`, and `setsid` in absolute directories
  listed in `PATH`. It checks file existence and executable permissions. It does
  not recursively search the home directory or open harness configuration files.
- `tokate doctor` invokes `--version` on discovered tools and runs a local
  sandbox probe. It does not run inference or check authentication.
- Starting work invokes `codex login status` and checks the output for a ChatGPT
  login. Codex handles access to its own authentication storage. Tokate does not
  open that storage or request the credential value.
- Model and effort are explicit donor arguments, checked against repository
  policy. The agent invocation ignores user configuration and rules and supplies
  Tokate's own execution settings. This does not establish that every Codex
  subcommand ignores all configuration or authentication storage.

Source: [Startup.gs](../src/Startup.gs), [Worker.gs](../src/Worker.gs).

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

There are distinct process boundaries:

| Process | Current environment behavior |
| --- | --- |
| Codex login check, execution, and sandbox invocations | Starts with `PATH`, `HOME`, `USER`, `LANG`, `CODEX_HOME`, and `DOTNET_ROOT` when present, plus Tokate's Git/GitHub process controls |
| Agent shell commands | Configured with no inherited environment and a fixed system `PATH`, scratch `HOME`, and scratch `TMPDIR` |
| Owner verification commands | Uses `env -i` with the same system path and scratch directories |
| Other host commands, including Git/GitHub and version checks | Inherit the parent environment, with `GIT_*` variables removed and Tokate's process controls added |

The last row is a real limitation: host subprocesses can receive sensitive
environment variables already present in the caller's environment. The process
helper also accesses the inherited environment to construct child environments.
The current implementation must not be described as never handling any sensitive
environment data. It does not intentionally dump the environment to a log.

The sandbox restricts repository commands, not the trusted harness host process
that authenticates inference. Installed executables remain trusted code.

Source: [Process.gs](../src/Process.gs), [Worker.gs](../src/Worker.gs),
[Publish.gs](../src/Publish.gs).

## Files, logs, and network destinations

Tokate reads repository task policy, approval, templates, issue content, and its
own saved run artifacts. It does not directly open `.env` files or credential
stores to discover settings. However, the checkout is readable by the agent and
verification commands. There is no blanket `.env` filename exclusion within that
checkout. Do not interpret the discovery behavior as a guarantee that repository
content cannot contain or expose a secret.

Runs are stored under `~/.local/state/tokate/runs/`, or the selected `--runs`
directory. Artifacts include run metadata, the checkout, agent events, stderr,
the final report, verification output, the patch, PR body, and check results.
These files persist for inspection and recovery. There is no automatic expiry or
general secret scrubber. Raw tool output can contain sensitive content if a tool
prints it. Command errors can also appear in terminal output.

- GitHub receives coordination records, branch commits, and the draft PR.
  The PR template includes the agent report, verification command names, and
  receipt/usage metadata. Changes to tracked content become part of the PR.
- Codex receives the approved issue and accesses the checkout to perform the
  task. Inference sends task context through the donor's Codex service. A local
  CLI does not mean local inference or that repository content stays offline.
- Raw local event and verification logs are not separately uploaded by Tokate's
  publishing path. Reports and patches can nevertheless reproduce their content.
- Agent command network access requires both owner policy and donor opt-in.
  Harness inference connectivity is separate. With command network access enabled,
  repository commands can contact additional destinations.

Tokate does not add a separate telemetry upload in these source paths. The
installed harness, GitHub CLI, and services have their own behavior and policies.
This document is not a claim about their retention practices.

Source: [Core.gs](../src/Core.gs), [Workflow.gs](../src/Workflow.gs),
[Worker.gs](../src/Worker.gs), [Publish.gs](../src/Publish.gs).

## Required boundary for future adapters

These requirements are agreed design, not implemented multi-harness support:

1. Discover supported executables without scanning private directories.
2. Obtain model and effort defaults only through reviewed, narrowly scoped
   interfaces that return nonsecret fields. Do not open mixed configuration,
   `.env` files, credential stores, or full environment/configuration dumps and
   then redact them. If no safe interface exists, ask the donor to select the
   settings and save only those choices.
3. Leave authentication with the harness. Never request, collect, copy, store,
   or transmit API keys or other credential values through Tokate.
4. Document each adapter's exact discovery commands, settings interface, fields
   read, environment handling, authentication delegation, saved artifacts,
   published data, and limitations before release.
5. Identify supported versions and verify the boundary with synthetic credentials
   and fixtures. Do not inspect real credentials to test an adapter.
6. Reconcile the current environment and raw-output limitations before claiming
   that an integration meets the full secret-free discovery contract.

Users should be able to compare this document with the source for the version
they run. Update it whenever discovery, authentication, data handling, or
publication behavior changes.
