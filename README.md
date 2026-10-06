[![Tokate: Give your inference a purpose. Painted hands cradle a sun above a Renaissance landscape.](site/assets/social-card.jpg)](https://tokate.dev/)

# Tokate

**toh-KAH-teh**. Put your spare AI usage to work for open source.

An owner approves an issue. A donor runs it with their own accounts. Tokate checks the result and opens a draft PR for owner review.

## Get started with your AI

Give your coding assistant this prompt:

> Read https://raw.githubusercontent.com/obselate/tokate/main/AGENTS.md and help me set up Tokate. Establish whether I am an owner or donor, then guide me through the next step.

## Install

```sh
curl -qfsSL https://tokate.dev/install.sh | sh
```

Installs for your user and sets up PATH. Open a new terminal if prompted.
Update with `tokate update`. Remove with `tokate uninstall`, which keeps saved work.

Requires **Linux x86_64 with glibc 2.34+** and public GitHub repositories. Tested observations cover Ubuntu 24.04 CI and a CachyOS rolling host; other distributions are not established. ARM64, musl, Windows and macOS are unsupported. Managed execution supports native Codex with a ChatGPT login, or [Pi local execution](docs/pi.md) with a pinned SDK/runtime and an existing no-auth loopback endpoint. See [prerequisites and support limits](docs/reference.md#install-and-check-support).

## For Owners:

1. Follow the [owner guide](AGENTS.md#guide-a-repository-owner): check tools with `tokate doctor --owner --auth`, then run `tokate init --repo OWNER/REPO` in your repository.
2. Review and commit the policy and pinned workflow with your project's existing checks. Setup requires a matching stable release with its hosted shared workflow; see [owner setup and Actions prerequisites](docs/reference.md#set-owner-policy-and-approve).
3. Initialize access, approve task scope and trust donors or grant access to one issue. New setup defaults to version 2 and Trusted eligibility; newcomers request access before claiming work.
4. Review the draft PR, receipt and [required checks](docs/reference.md#review-and-accept), then merge when satisfied.

## For Donors:

1. Follow the [donor guide](AGENTS.md#guide-a-donor) for GitHub access and [Codex setup](docs/reference.md#prepare-donor-tools-and-defaults) or [Pi setup](docs/pi.md).
2. Request access if needed, then [claim approved available work](docs/coordination-v2.md#requests-and-authoritative-state) through the coordinator.
3. [Prepare, work and submit](docs/reference.md#run-and-inspect-work) with an allowed tool/model/effort selection and an agreed budget. Tokate discovers or creates your fork and verifies the result before coordinated draft publication.

Existing assignment-bound repositories remain supported; see [legacy operations](AGENTS.md#legacy-operations-and-recovery). Your accounts and AI usage stay under your control.

For assistants, every command accepts explicit `--json`; `tokate help --json` lists
arguments and effects. See the [versioned output contract](docs/reference.md#automate-commands).

Use `tokate work --help`, `tokate help work` or `-h` for focused command help.
You can pass an issue URL directly, or omit `--repo` when local remotes identify
one GitHub repository. [Shell completion and input rules](docs/reference.md#find-a-command) cover Bash, Zsh and Fish.

[Website](https://tokate.dev/) · [Releases](https://github.com/obselate/tokate/releases) · [Commands and recovery](docs/reference.md) · [Data transparency](docs/transparency.md) · [Build from source](docs/reference.md#build-and-verify-from-source) · [Issues](https://github.com/obselate/tokate/issues) · [MIT license](LICENSE)
