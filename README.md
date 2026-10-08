[![Tokate: Give your inference a purpose. Painted hands cradle a sun above a Renaissance landscape.](site/assets/social-card.jpg)](https://tokate.dev/)

# Tokate

**toh-KAH-teh**. Put your spare AI usage to work for open source.

An owner approves an issue. A donor runs it with their own accounts and tools.
Tokate verifies the result and opens a draft PR for owner review.

## Install

```sh
curl -qfsSL https://tokate.dev/install.sh | sh
```

Open a new terminal if prompted. Use `tokate update` to update or `tokate uninstall`
to remove the installation while keeping saved work.

Requires **Linux x86_64, glibc 2.34+ and public GitHub repositories**. Windows,
macOS, ARM64 and musl are not supported by this release. Managed donations use
native Codex with a ChatGPT login or Pi with a configured local model endpoint.
Owners need neither harness nor an AI subscription.

## Start here

- **Owners:** [Set up the repository, approve tasks and review donations](docs/owners.md).
- **Donors:** [Choose a tool, claim an issue and donate work](docs/donors.md).
- **Existing work:** [Recover a run or update a PR](docs/recovery.md).
- **Before running:** [Understand data access and isolation](docs/security.md).
- **Source builders:** [Build, test and package Tokate](docs/development.md).

Run `tokate` in a terminal for repository status and saved contributions.
Use `tokate help COMMAND` for exact options. Issue URLs supply repository and issue
context. Scripts and assistants can use `--json` without prompts.

To get help from your coding assistant:

> Read https://raw.githubusercontent.com/obselate/tokate/main/AGENTS.md and help me use Tokate as an owner or donor.

[Website](https://tokate.dev/) · [Releases](https://github.com/obselate/tokate/releases) · [Issues](https://github.com/obselate/tokate/issues) · [MIT license](LICENSE)
