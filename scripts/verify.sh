#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/build.sh
if [[ "${1:-}" == --full ]]; then
    test "$#" -eq 1
    env -u TOKATE_CI_SHARD artifacts/tests/tokate-tests
    python3 scripts/native-proof.py
elif [[ "$#" -gt 0 ]]; then
    report=$(mktemp)
    trap 'rm -f "$report"' EXIT
    env -u TOKATE_CI_SHARD artifacts/tests/tokate-tests "$@" | tee "$report"
    if ! grep -q '^PASS ' "$report"; then
        echo 'No test matched the selected arguments.' >&2
        exit 1
    fi
else
    echo 'Core smoke checks. Run the changed system selectors before review and --full before release.'
    env -u TOKATE_CI_SHARD artifacts/tests/tokate-tests --flow CrossAccountFlow
    env -u TOKATE_CI_SHARD artifacts/tests/tokate-tests --coordination CanonicalSubmit
fi
artifacts/linux-x64/tokate --version
git diff --check
