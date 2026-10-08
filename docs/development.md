# Build and verify

Source builds require the exact .NET SDK in `global.json`, Clang and zlib development
headers for NativeAOT. The project pins the G# SDK through `Tokate.gsproj` and its
lock file. Supported release binaries target Linux x86_64, glibc 2.34+.

```sh
bash scripts/build.sh
artifacts/linux-x64/tokate --version
```

## Test the changed system

Reuse the published binaries for focused behavior checks:

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
