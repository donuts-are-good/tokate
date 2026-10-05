#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/build.sh
env -u TOKATE_CI_SHARD artifacts/tests/tokate-tests
artifacts/linux-x64/tokate --version
python3 scripts/native-proof.py
git diff --check
