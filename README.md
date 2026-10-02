# Tokate

**toh-KAH-teh**. Donate your local Codex compute to a GitHub project.

The owner approves an issue. A donor runs it with their own accounts. Tokate opens a draft PR after local checks pass. The owner reviews and merges it.

Early prototype for **Linux x64 (glibc 2.34+) and public GitHub repositories**. Start with one small issue.

## Install Tokate

Download the Linux x64 archive from [Releases](https://github.com/obselate/tokate/releases/latest), extract it, and open its folder. Then install:

```sh
mkdir -p ~/.local/bin
install -m 755 ./tokate ~/.local/bin/tokate
export PATH="$HOME/.local/bin:$PATH"
tokate --version
```

Keep `~/.local/bin` in your shell's PATH. No .NET or Python runtime is needed. To build the binary yourself, see [Build from source](docs/reference.md#build-from-source).

## I own the repository

### 1. Sign in to GitHub

Install Git, GitHub CLI (`gh`), and `setsid` from util-linux. Use an account with repository write access:

```sh
gh auth login
gh auth status
```

Owners do not need Codex installed.

### 2. Configure the repository once

From your repository checkout:

```sh
tokate init
```

Edit `.github/tokate.json`:

```json
{
  "version": 1,
  "models": { "gpt-6.1-sol": ["high"] },
  "max_seconds": 1800,
  "allow_network": false,
  "required_checks": ["verify"],
  "verification": [["bash", "scripts/verify.sh"]]
}
```

Choose a model and effort your donor can use. Replace `verification` with your actual test command and `required_checks` with your exact GitHub CI check names. `max_seconds` covers compute and local verification. Leave `allow_network` false unless the build needs downloads.

Commit `.github/tokate.json` and `.github/tokate-pr.md` to the default branch. Keep the PR template's `{{placeholders}}`. Skip `init` if these files already exist.

### 3. Approve an issue for a donor

Write a small issue with clear acceptance criteria. Have the donor comment on it so they can be assigned. Replace `OWNER/REPO`, `42`, and `DONOR` below:

```sh
tokate approve --repo OWNER/REPO --issue 42 --donor DONOR
```

Send the donor the repository, issue number, and required build tools. They follow the donor steps below.

### 4. Review the PR

Replace `43` with the PR number:

```sh
tokate verify-pr --repo OWNER/REPO --pr 43
tokate checks --repo OWNER/REPO --pr 43 --watch
```

If CI is waiting for permission, review and [approve the fork workflow in GitHub](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks). Ensure CI runs on draft PRs. Review the diff and acceptance criteria, mark the PR ready, then merge it yourself. Tokate never merges.

## I want to donate compute

### 1. Prepare your machine

Install Git, GitHub CLI, `setsid` from util-linux, a native Codex CLI, and the project's build tools. Tokate has been tested with Codex 0.159.3.

Use your own GitHub account and ChatGPT subscription:

```sh
gh auth login
gh auth status
codex login
tokate doctor
```

Fix any failed checks before continuing. `doctor` tests the tools and sandbox without inference. It does not check project build dependencies. The sandbox cannot use your home-directory package caches or tools, so install build tools in standard system locations. Ask the owner about setup before spending compute.

### 2. Get assigned and create your fork

Comment on the issue and wait for the owner to approve it for your GitHub username. Create a fork once:

```sh
gh repo fork OWNER/REPO --clone=false
tokate policy --repo OWNER/REPO
```

### 3. Run the task

Use a model and effort listed in the policy:

```sh
tokate work --repo OWNER/REPO --issue 42 --model gpt-6.1-sol --effort high
```

Tokate creates a separate checkout, runs Codex, runs the owner's verification commands, then opens a draft PR. Save the printed run path. Your subscription is used locally, and no credentials or quota are transferred to the owner.

To lower the time budget, add `--seconds 600`. For dependency downloads, both the owner must set `allow_network: true` and you must add `--allow-network`. This grants internet access to agent commands and verification scripts.

### 4. Check the result

Replace `DIR` with the printed run path:

```sh
tokate status --run DIR
tokate checks --run DIR --watch
```

If only publication failed, run `tokate publish --run DIR` without spending compute again. If compute or verification failed, inspect the run logs and ask the owner for fresh approval before another attempt.

See the [command and security reference](docs/reference.md) for reassignment, revocation, saved claims, and isolation limits. Passing tests and a model whitelist do not guarantee correctness. The owner still reviews every PR.

## Build and run

Install the exact .NET SDK from `global.json`, Clang, zlib development headers, Git, and Python 3. Dependencies restore from public NuGet only.

```sh
git clone https://github.com/obselate/tokate.git
cd tokate
bash scripts/verify.sh
dotnet run --project Tokate.gsproj -- --help
```

The verification script checks formatting, builds NativeAOT with warnings as errors, and runs the existing offline regression tests. It does not spend compute or modify GitHub.

## Links

- [Releases and checksums](https://github.com/obselate/tokate/releases)
- [Command and security reference](docs/reference.md)
- [Report an issue](https://github.com/obselate/tokate/issues)
- [MIT license](LICENSE)
