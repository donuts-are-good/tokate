#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/build.sh
runtime="${TOKATE_RUNTIME_IDENTIFIER:-linux-x64}"
tests=artifacts/tests/tokate-tests
if [[ "$runtime" == linux-musl-x64 ]]; then
    tests=artifacts/tests-musl/tokate-tests
fi
export TOKATE_BINARY="${TOKATE_BINARY:-$PWD/artifacts/$runtime/tokate}"
if [[ "${1:-}" == --full ]]; then
    test "$#" -eq 1
    env -u TOKATE_CI_SHARD "$tests"
    python3 scripts/native-proof.py
elif [[ "$#" -gt 0 ]]; then
    report=$(mktemp)
    trap 'rm -f "$report"' EXIT
    env -u TOKATE_CI_SHARD "$tests" "$@" | tee "$report"
    if ! grep -q '^PASS ' "$report"; then
        echo 'No test matched the selected arguments.' >&2
        exit 1
    fi
else
    echo 'Core smoke checks. Run the changed system selectors before review and --full before release.'
    env -u TOKATE_CI_SHARD "$tests" --flow CrossAccountFlow
    env -u TOKATE_CI_SHARD "$tests" --coordination CanonicalSubmit
fi
"$TOKATE_BINARY" --version
git diff --check
