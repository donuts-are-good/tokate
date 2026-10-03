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

```text
Tokate 0.2.10 (toh-KAH-teh)
Donate AI usage to approved GitHub issues.

  tokate doctor                           Check tools and sandbox without inference
  tokate update                           Install the latest stable release
  tokate uninstall                        Remove Tokate, keep saved runs

Owner:
  tokate init [--path DIR]                 Create policy and PR template
  tokate policy --repo OWNER/REPO          Read upstream policy
  tokate approve --repo OWNER/REPO --issue N --donor LOGIN
  tokate assign  --repo OWNER/REPO --issue N --donor LOGIN
  tokate revoke  --repo OWNER/REPO --issue N

Donor:
  tokate work --repo OWNER/REPO --issue N --model MODEL --effort EFFORT
              [--seconds 3600] [--fork LOGIN/REPO] [--allow-network] [--runs DIR]
  tokate claim <same options>              Reserve without starting inference
  tokate work --run DIR                    Execute a saved claim once
  tokate recover --run DIR [--seconds 300]  Reverify a completed turn without inference
  tokate publish --run DIR                 Retry publication without inference
  tokate status --run DIR                  Show saved run

Review:
  tokate verify-pr --repo OWNER/REPO --pr N Validate approval and receipt
  tokate checks --repo OWNER/REPO --pr N [--watch] [--timeout 1200]
  tokate checks --run DIR [--watch] [--timeout 1200]

Requires Linux x86_64 (glibc 2.34+), git, gh, setsid, bubblewrap, and a current native Codex CLI with permission
profiles. Sign in with gh auth login and codex login. Create your fork with
 gh repo fork OWNER/REPO --clone=false

Checks exit 0 when all owner-required checks pass, 8 when pending, 1 on failure.
Add --traffic to any command for numeric Tokate gh-api counts on stderr.
Counts exclude unseen GitHub CLI/Git requests and workflow executions.
PRs are drafts. The owner reviews and merges. No quota transfer or correctness guarantee.
```

`assign` replaces approval for an already approved issue. `approve` also issues fresh approval after a failed or abandoned attempt. Editing the issue, policy, template, or assignment requires fresh approval. Old runs then fail revalidation. Revocation blocks publication but cannot stop computation on another person's machine.

`claim` reserves a branch without running inference. Use `work --run DIR` to execute it later. Runs are stored in `~/.local/state/tokate/runs/`, or the `--runs` directory. Each contains its claim, raw agent events and report, verification results, patch, generated PR body (`pr-body.md`), exact PR-create request (`publication.json`), and check results. Keep raw artifacts private. Tokate saves the publication previews before push or PR creation; `work` still publishes automatically. Inspect the previews and patch when reviewing saved work or recovering a publication failure. Previews are regenerated on retry, so editing them does not alter the request.

`publish --run DIR` retries publication after a successful run without running inference again. `recover --run DIR` reruns all checks after a completed agent turn failed independent verification. Failed or interrupted inference requires fresh owner approval. Claim branches remain for inspection and can be deleted after review.

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
These transport bounds do not implement atomic coordination (#11),
pause/resume/handoff or coordinator workflow traffic accounting (#19); those
issues remain open for their integrated flows. The same-repository conditional
read fix also leaves #54 open for its remaining criteria.

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

`verify-pr` checks PR author, claim branch, commit, current approval, issue text, policy, and the reported model/effort pair. It is read-only and does not check out or execute PR code. Receipt validation is not independent proof of inference usage. `checks` also validates the receipt and checks the head before and after reading CI. It exits 0 on pass, 8 on pending or watch timeout, and 1 on failure. It never marks the PR ready or merges it.

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

Process groups are killed on timeout, cancellation, and normal completion to clean up their background children. No automatic repair loop uses additional inference. Time caps are not exact token or subscription-percentage caps.

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
cleanup on normal exit and timeout. These tests must pass on required Ubuntu CI;
fixtures do not replace the real verifier boundary.
The real native Codex `doctor` probe is a separate required matrix check; passing
the deterministic suite does not establish the managed Codex boundary.

`tokate recover --run DIR [--seconds 300]` explicitly reruns all owner checks after a completed agent turn failed verification. It revalidates approval and the completed turn and report before archiving legacy managed scratch caches, preserves failure evidence, and publishes only after success. Incomplete turns leave those caches in place and run no verification. The separate verification budget cannot exceed the owner limit. No inference runs. The PR discloses recovery and unknown original runtime. Failed inference still requires fresh approval.
