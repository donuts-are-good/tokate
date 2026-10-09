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

Requires **Linux x86_64 with glibc 2.34+ or Alpine 3.24, and public GitHub repositories**.
Windows, macOS and ARM64 are not supported. See [Nix](docs/nix.md) and
[Alpine](docs/alpine.md) for distribution setup. Managed donations use
native Codex with a ChatGPT login or Pi with a configured local model endpoint.
Owners need neither harness nor an AI subscription.

## Start here

- **Owners:** [Set up the repository, approve tasks and review donations](docs/owners.md).
- **Donors:** [Choose a tool, claim an issue and donate work](docs/donors.md).
- **Existing work:** [Recover a run or update a PR](docs/recovery.md).
- **Before running:** [Understand data access and isolation](docs/security.md).
- **Source builders:** [Build, test and package Tokate](docs/development.md).

Run `tokate` for guided donation, owner setup, repository status and saved work.
`tokate work OWNER/REPO` offers available issues. Issue and PR links supply context.
Use `tokate help COMMAND` for exact options. Scripts can use `--json` without prompts.

To get help from your coding assistant:

> Read https://raw.githubusercontent.com/obselate/tokate/main/AGENTS.md and help me use Tokate as an owner or donor.

[Website](https://tokate.dev/) · [Releases](https://github.com/obselate/tokate/releases) · [Issues](https://github.com/obselate/tokate/issues) · [MIT license](LICENSE)
