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

The binary requires **Linux x86_64 with glibc 2.34+** and public GitHub repositories. The initial observed systems are Ubuntu 24.04 x86_64 CI and a CachyOS rolling x86_64 host; the glibc minimum does not establish support for every distribution. ARM64, musl, Windows, and macOS are not supported. Tokate-launched execution uses native Codex with a ChatGPT login. Owners can explicitly opt into [version-2 coordination and external coding tools](docs/coordination-v2.md); default version-1 setup is unchanged. See the [validation matrix and limits](docs/reference.md#linux-compatibility).

## For Owners:

1. Sign in with `gh auth login` and run `tokate init` in your repository.
2. Set the project's checks and allowed model/effort pairs, then commit the generated files. Your AI can follow the [owner setup guide](AGENTS.md#guide-a-repository-owner).
3. Write an issue with clear acceptance criteria and approve a donor:

```sh
tokate approve --repo OWNER/REPO --issue 42 --donor DONOR
```

Review the resulting PR and [required checks](docs/reference.md#quality-and-review), then merge when satisfied.

## For Donors:

1. Follow the [donor setup guide](AGENTS.md#guide-a-donor) to sign in and check your tools with `tokate doctor`.
2. Get assigned to an approved issue and create or reuse your fork.
3. Choose an allowed model/effort pair and start:

```sh
tokate work --repo OWNER/REPO --issue 42 --model MODEL --effort EFFORT
```

Tokate prepares the checkout, runs the task and checks, then opens a draft PR. Your accounts and AI usage stay under your control.

For assistants, every command accepts explicit `--json`; `tokate help --json` lists
arguments and effects. See the [versioned output contract](docs/reference.md#explicit-structured-output).

Use `tokate work --help`, `tokate help work` or `-h` for focused command help.
You can pass an issue URL directly, or omit `--repo` when local remotes identify
one GitHub repository. [Shell completion and input rules](docs/reference.md#issue-urls-and-local-repository-context) cover Bash, Zsh and Fish.

[Website](https://tokate.dev/) · [Releases](https://github.com/obselate/tokate/releases) · [Commands and recovery](docs/reference.md) · [Data transparency](docs/transparency.md) · [Build from source](docs/reference.md#build-from-source) · [Issues](https://github.com/obselate/tokate/issues) · [MIT license](LICENSE)
