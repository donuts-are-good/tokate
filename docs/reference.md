# Tokate reference

[Back to the setup guide](../README.md)

## Installation

```sh
curl -qfsSL https://tokate.dev/install.sh | sh
```

The installer supports Linux x64 with glibc 2.34 or newer. It needs `curl`, `tar`,
and standard system tools including `sha256sum`. It does not need GitHub CLI,
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
Tokate 0.2.3 (toh-KAH-teh)
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
  tokate publish --run DIR                 Retry publication without inference
  tokate status --run DIR                  Show saved run

Review:
  tokate verify-pr --repo OWNER/REPO --pr N Validate approval and receipt
  tokate checks --repo OWNER/REPO --pr N [--watch] [--timeout 1200]
  tokate checks --run DIR [--watch] [--timeout 1200]

Requires Linux, git, gh, setsid, bubblewrap, and a current native Codex CLI with permission
profiles. Sign in with gh auth login and codex login. Create your fork with
 gh repo fork OWNER/REPO --clone=false

Checks exit 0 when all owner-required checks pass, 8 when pending, 1 on failure.
PRs are drafts. The owner reviews and merges. No quota transfer or correctness guarantee.
```

`assign` replaces approval for an already approved issue. `approve` also issues fresh approval after a failed or abandoned attempt. Editing the issue, policy, template, or assignment requires fresh approval. Old runs then fail revalidation. Revocation blocks publication but cannot stop computation on another person's machine.

`claim` reserves a branch without running inference. Use `work --run DIR` to execute it later. Runs are stored in `~/.local/state/tokate/runs/`, or the `--runs` directory. Each contains its claim, raw agent events and report, verification results, patch, generated PR body (`pr-body.md`), exact PR-create request (`publication.json`), and check results. Keep raw artifacts private. Tokate saves the publication previews before push or PR creation; `work` still publishes automatically. Inspect the previews and patch when reviewing saved work or recovering a publication failure. Previews are regenerated on retry, so editing them does not alter the request.

`publish --run DIR` retries publication after a successful run without running inference again. Failed or interrupted runs requires fresh owner approval. Claim branches remain for inspection and can be deleted after review.

`--seconds` caps agent execution plus independent verification. The default for new claims is the smaller of 3600 seconds and the owner's limit. Explicit budgets must be from 1 to 86400 seconds and cannot exceed the owner's limit. Saved runs keep their original budget. It is not a token cap. `--fork LOGIN/NAME` selects a renamed fork owned by the donor. Network access requires both owner policy and donor `--allow-network`.

Startup checks warn about missing tools. Owner commands work without Codex. `doctor` checks all tools and probes the sandbox, but does not test authentication, model access, or repository build dependencies. `NO_COLOR` disables styling. Redirected output is plain, and `policy` and `status` output JSON when piped.

Managed run directories, harness homes and tool installations must be outside
`/tmp`, which is replaced with private temporary storage. The default run
location meets this requirement. `doctor` uses a private directory under
`/var/tmp` and removes it after the probe.

The operating system must permit bubblewrap to create user namespaces. On
Ubuntu 24.04, an administrator may need to enable an AppArmor profile for
bubblewrap as described in the [Ubuntu release notes](https://discourse.ubuntu.com/t/ubuntu-24-04-lts-noble-numbat-release-notes/39890).
Run `doctor` after setup. Tokate does not change system security settings.

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

Every host command starts with only explicit environment requirements. Codex receives `PATH`, `HOME`, `LANG`, and optional `CODEX_HOME`, without GitHub/API-key credentials. GitHub CLI commands and Git push receive narrowly selected GitHub authentication and Linux keyring variables; local Git and other tools receive only the base requirements. See the exact lists in [transparency.md](transparency.md#authentication-and-process-environments). User configuration, exec rules, hooks, plugins, host skill discovery, multi-agent features, and web search are disabled. Repository `.codex` configuration is rejected. Sandboxed commands have filesystem reads denied by default, with only minimal system runtime paths, the native Codex executable, the checkout, and private temporary storage allowed. `.git` is denied. The shell has a scratch home and temp directory inside the checkout. Bubblewrap gives each managed invocation a fresh private `/tmp`, including runtime IPC paths that ignore `TMPDIR`. Shared host temporary files are not mounted into that storage. A preflight probes read denial and temporary writes before starting inference. Repositories with `global.json` also receive a system .NET/MSBuild startup check. This does not verify dependency restore or model availability. Unsupported Tokate-launched sandbox configurations fail closed. External execution is not sandboxed by Tokate.

Verification runs under the same filesystem boundary and a clean environment, with read-only access to Git metadata and a separate fresh private `/tmp`. Agent network access defaults off. Allowing it permits outbound command network access and should be limited to repositories the donor trusts. The Codex host still needs network access for inference. Installed Codex, bubblewrap and system administrators are trusted. This is OS sandboxing, not a separate VM or protection against kernel vulnerabilities. Run unfamiliar projects on a dedicated donor machine or VM.

Process groups are killed on timeout, cancellation, and normal completion to clean up their background children. No automatic repair loop uses additional inference. Time caps are not exact token or subscription-percentage caps.

## Build from source

Requires .NET 10 and a NativeAOT toolchain (Clang and zlib development headers).

```sh
dotnet restore Tokate.gsproj --locked-mode
dotnet publish Tokate.gsproj -c Release --no-restore -o artifacts/linux-x64
install -m 755 artifacts/linux-x64/tokate ~/.local/bin/tokate
```

## Development

```sh
scripts/verify.sh
```

The pinned public G# SDK is 0.4.591. Verification uses the pinned SDK formatter,
builds and publishes NativeAOT with warnings as errors, and runs a G# end-to-end
harness against the actual binary. It uses two simulated GitHub identities, real
local Git repositories, and deterministic Codex and release-download fixtures.
Tests use synthetic values for process environments, tool-owned authentication,
repository/output boundaries, cleanup, revocation, publication failures and
recovery, and install/update/removal without running
inference, downloading a release, or modifying GitHub. No external test framework
or Python runtime is required.
