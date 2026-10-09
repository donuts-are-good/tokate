#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export NIX_CONFIG="${NIX_CONFIG:-}
experimental-features = nix-command flakes"
proof=$(mktemp -d)
trap 'rm -rf "$proof"' EXIT
nix build .#default --out-link "$proof/package"
export TOKATE_NIX_SOURCE=$PWD
probe=$(nix build --impure --no-link --print-out-paths --expr '
  let
    source = builtins.getEnv "TOKATE_NIX_SOURCE";
    flake = builtins.getFlake source;
    pkgs = import flake.inputs.nixpkgs { system = "x86_64-linux"; };
  in pkgs.callPackage (source + "/nix/verification-probe.nix") {}
' --option allow-import-from-derivation false)
nixpkgs=$(nix flake metadata --json . | python3 -c 'import json,sys; print(json.load(sys.stdin)["locks"]["nodes"]["nixpkgs"]["locked"]["rev"])')
nix profile add --profile "$proof/tools" "github:NixOS/nixpkgs/$nixpkgs#codex" "github:NixOS/nixpkgs/$nixpkgs#hello" \
  "github:NixOS/nixpkgs/$nixpkgs#bash" "github:NixOS/nixpkgs/$nixpkgs#bubblewrap" github:earendil-works/pi/stable
unrelated=$(readlink -f "$proof/tools/bin/hello")
TOKATE_BINARY="$PWD/artifacts/linux-x64/tokate" artifacts/tests/tokate-tests --nix-runtime \
  "$probe/bin/tokate-nix-probe" "$unrelated" "$(command -v nix-store)"
nix profile add --profile "$proof/profile" .#default
before=$(readlink -f "$proof/profile")
if nix profile add --profile "$proof/profile" /nix/store/00000000000000000000000000000000-missing; then
  exit 1
fi
test "$(readlink -f "$proof/profile")" = "$before"
binary="$proof/profile/bin/tokate"
"$binary" --version
(cd "$proof"; "$binary" doctor --external --json) > "$proof/external.json"
(cd "$proof"; "$binary" doctor --managed --harness-path "$proof/tools/bin/codex" --json) > "$proof/managed.json"
(cd "$proof"; PATH="$proof/tools/bin:$PATH" "$proof/tools/bin/bwrap" --ro-bind / / --proc /proc --dev /dev \
  --tmpfs /tmp --bind "$proof" "$proof" \
  --ro-bind /dev/null /bin/bash --ro-bind /dev/null /usr/bin/bwrap -- \
  "$binary" doctor --managed --harness pi --harness-path "$proof/tools/bin/pi" --json) > "$proof/pi.json"
if "$binary" update --json > "$proof/update.json"; then
  exit 1
fi
python3 - "$proof" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
for scope in ("external", "managed", "pi"):
    result = json.loads((root / f"{scope}.json").read_text())
    assert result["status"] == "ok", result
    assert result["data"]["inference"] is False, result
assert json.loads((root / "update.json").read_text())["error"]["code"] == "invalid_state"
PY
"$proof/tools/bin/codex" --version
"$proof/tools/bin/pi" --version
printf 'PASS Nix package, custom profile, failed profile change, update ownership and real sandbox probes without inference\n'
