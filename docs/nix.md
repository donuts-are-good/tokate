# Nix and NixOS

Tokate builds as a NativeAOT CLI for x86_64 Linux. Install [Nix](https://nix.dev/install-nix) first.

Enable the command and flake features in `~/.config/nix/nix.conf`:

```ini
experimental-features = nix-command flakes
```

On NixOS, set this in your system configuration instead:

```nix
nix.settings.experimental-features = [ "nix-command" "flakes" ];
```

## Install

```sh
nix profile add github:obselate/tokate
tokate doctor --external
```

In an existing NixOS flake, add `inputs.tokate.url = "github:obselate/tokate"`
and include `inputs.tokate.packages.x86_64-linux.default` in `environment.systemPackages`.
Use Nix to upgrade, roll back or remove this installation. Tokate does not change system configuration.

## Choose a harness

For Codex:

```sh
nix profile add nixpkgs#codex
tokate doctor --managed --harness codex
```

For Pi:

```sh
nix profile add github:earendil-works/pi/stable
tokate doctor --managed --harness pi
```

Keep custom profile `bin` directories on `PATH`, or use `--harness-path`.
Keep runtimes outside the checkout. Pi uses Node from its package closure unless `--node` overrides it.

## Build from source

From the repository root:

```sh
nix build
./result/bin/tokate --version
```

After changing NuGet dependencies, regenerate their hashes and rebuild:

```sh
nix build .#default.fetch-deps
./result nix/deps.json
nix build
```

Verification mounts only the selected executable's declared closure and baseline tools.
For compound checks, declare dependencies with `writeShellApplication.runtimeInputs`.
Unrelated store paths and home files stay unavailable. Missing store paths fail without deleting saved work.
