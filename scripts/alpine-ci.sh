#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export TOKATE_RUNTIME_IDENTIFIER=linux-musl-x64
export TOKATE_BINARY="$PWD/artifacts/linux-musl-x64/tokate"
unshare --map-current-user --pid --fork --kill-child --mount-proc -- /bin/true
bash scripts/build.sh
artifacts/tests-musl/tokate-tests --shell /bin/sh
artifacts/tests-musl/tokate-tests --cli-setup
artifacts/tests-musl/tokate-tests --process
artifacts/tests-musl/tokate-tests --flow CrossAccountFlow
"$TOKATE_BINARY" doctor --external --json
npm install --global --prefix "$HOME/.local" @openai/codex@latest
"$TOKATE_BINARY" doctor --harness-path "$HOME/.local/bin/codex" --json
"$HOME/.local/bin/codex" --version
codex_native=$(find "$HOME/.local/lib/node_modules/@openai/codex" -type f -path '*/vendor/x86_64-unknown-linux-musl/bin/codex')
test -f "$codex_native"
python3 scripts/native-proof.py --codex "$codex_native"
"$TOKATE_BINARY" doctor --harness pi --fix --yes --json
"$HOME/.pi/agent/bin/pi" --version
node --version
bash scripts/package.sh
