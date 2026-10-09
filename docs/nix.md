# Nix and NixOS

Tokate's flake builds the x86_64 Linux CLI as NativeAOT.

```sh
nix profile add github:obselate/tokate
tokate doctor --external
nix profile add nixpkgs#codex
tokate doctor --managed --harness codex
```

For Pi, use its official package:

```sh
nix profile add github:earendil-works/pi/stable
tokate doctor --managed --harness pi
```

NixOS configurations can add `inputs.tokate.packages.x86_64-linux.default` to
`environment.systemPackages`. Enable flakes through the system's Nix configuration.
Tokate does not change system configuration or install over a Nix-owned executable.
Use Nix profile upgrades, rollbacks and removal for that installation.

Custom profile `bin` directories must be on `PATH`. An explicit `--harness-path`
also works. Keep runtimes outside the project checkout. Pi uses the Node runtime
from its declared package closure unless `--node` selects another runtime.

Verification commands can select a Nix executable by name or absolute path. Only
that executable's declared closure and the baseline command tools are mounted.
Package compound checks with their runtime dependencies, for example with
`writeShellApplication.runtimeInputs`. Unrelated store paths and home files remain
unavailable. A removed store path fails verification without deleting saved work.
