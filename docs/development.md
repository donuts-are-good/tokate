# Build and verify

Run from the repository root with Bash, curl, the exact .NET SDK in `global.json`,
Clang and zlib development headers. These are build requirements. The released
native CLI does not require .NET or G#. On Ubuntu 24.04:

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends bash curl ca-certificates clang zlib1g-dev libicu74 libgssapi-krb5-2
```

Other distributions need their [.NET system dependencies](https://learn.microsoft.com/dotnet/core/install/linux-scripted-manual#dependencies)
and [NativeAOT build packages](https://learn.microsoft.com/dotnet/core/deploying/native-aot/#prerequisites).
The build restores the pinned G# SDK and NuGet packages automatically; the first
restore needs network access. Supported binaries target Linux x86_64 with glibc 2.34+ or Alpine 3.24.
On Alpine, set `TOKATE_RUNTIME_IDENTIFIER=linux-musl-x64` for the build and package scripts.
Musl tests are written to `artifacts/tests-musl`; set `TOKATE_BINARY` to the musl CLI when running them.

```sh
sdk_setup=$(mktemp)
curl -fsSL https://dot.net/v1/dotnet-install.sh -o "$sdk_setup"
bash "$sdk_setup" --jsonfile global.json --install-dir "$HOME/.dotnet" --no-path
rm "$sdk_setup"
export PATH="$HOME/.dotnet:$PATH"
bash scripts/build.sh
artifacts/linux-x64/tokate --version
```

Skip SDK installation when the pinned SDK is already available on `PATH`.

## Test the changed system

After building, use the generated test executable for focused behavior checks:

```sh
artifacts/tests/tokate-tests --saved-runs
artifacts/tests/tokate-tests --pi-runtime
artifacts/tests/tokate-tests --preparation PendingClaim
```

`bash scripts/verify.sh` builds and runs the core contribution smoke checks.
Pass an existing test selector to verify a specific system. Selectors are in
[the test entry point](https://github.com/obselate/tokate/blob/main/tests/Dispatch/Main.gs). An unmatched selector must not
be treated as a successful check.

Use `bash scripts/verify.sh --full` for full release validation, including native
harness proof. CI offers the same focused selector and full-validation choices.
A fixture test does not prove a real installed harness supports its adapter.
Native proof uses deterministic local responses and reports actual harness versions
and unsupported capabilities. It does not establish real model quality or allowance.

## Package

```sh
bash scripts/package.sh
```

The archive contains the matching binary, public guides and license notices.
Inspect its contents and checksum before publishing. Keep private run artifacts,
credentials and local engineering instructions out of source commits and releases.

## Source boundaries

`src/Cli` parses and presents user actions. Contributions and policy code own
authority and lifecycle rules. Execution owns harness and verification boundaries.
Publication owns receipts and PR writes. GitHub code owns transport and remote
identity. Compose existing operations from the CLI instead of adding a parallel
workflow. Keep G# changes direct and readable.
