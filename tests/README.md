# Source verification

The standalone fixture driver launches the published Tokate CLI with synthetic
Git, GitHub and Codex identities. It observes exit reasons, output, saved evidence,
Git refs, API attempts and process cleanup without linking production classes.

Run all checks with `bash scripts/verify.sh`. After publishing the test executable,
run affected groups with `artifacts/tests/tokate-tests --process`,
`--verification`, `--protected-paths`, `--flow NAME` or `--traffic-commands NAME`.
`TOKATE_BINARY` selects the CLI artifact. `TOKATE_TEST_ROOT` selects writable
fixture storage outside `/tmp` for managed runs.
