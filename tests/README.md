# CLI scenarios

The test executable is a standalone fixture driver. It launches the published
Tokate binary and synthetic Git/GitHub/Codex tools; it does not compile or call
production internals. Assertions observe exit reasons, JSON output, saved
artifacts, Git refs, API attempts, and process cleanup. Fixture identities and
secrets are synthetic.

The converted regressions have these public triggers:

| Trigger | External observation | Failure detected |
| --- | --- | --- |
| `work --run` with a large prompt | Interrupted run, flushed evidence, collected child | Blocked stdin escaping the inference deadline |
| `work --run` with oversized output | Contiguous private prefixes, independent stream flags, no PR | Gaps, split Unicode scalars, unbounded capture or false completion |
| `work --run` with an OS file-size limit or occupied evidence path | Failure reason, preserved evidence, no extra inference | Capture-write failures or unsafe evidence replacement |
| `work --run` during verification | Prior results, raw prefixes, stopped heartbeat, empty runtime storage | Lost evidence or descendants/runtime files surviving completion, failure, timeout or Ctrl+C |
| `recover --run` with unsafe metadata/storage | Specific refusal, preserved private sentinel, unchanged inference count | Checkout/Git symlinks, shared object stores or writable runtime aliases |
| `work --run` with replaced/unlinked runtime DNS or system alternatives | Independent check result, unchanged sentinels, runtime cleanup | Broken nested mounts, oversized runtime inputs or leaked configuration |
| `publish --run` with staged/committed raw protected filenames | Protected-path refusal, unchanged remote ref, no inference/PR | Whitespace, BOM, quoting or newline filenames bypassing protection |
| `request` with canonical comment URL/identity variants | Exact rejection reason or reuse, no extra POST/inference/PR | Loose issue URL matching or changed actor/payload evidence |

NativeFlow keeps one representative successful path for transport equivalence.
Approval/claim traffic budgets are checked in the existing cross-account flow;
publication retry/reuse budgets stay at the push/create/lost-response boundaries.
Modern and legacy recovery use the same failed candidate. Budget and model-policy
variants stop at the saved claim instead of repeating publication. Mutation,
revocation, canonical Git, cancellation, recovery and network boundaries remain
separate scenarios.

Snapshots reuse approved claims, generated candidates and published contributions
where only the injected failure changes. Their copy/reset mechanics are fixture
setup, not product scenarios. Fixture digest serialization only constructs legacy
or deliberately corrupt authority records; fixed instruction digests have literal
expected values, and result assertions do not use production validators.

Run focused groups with the published `artifacts/tests/tokate-tests` executable
(for example `--process`, `--verification`, `--protected-paths`, `--flow NAME`, or
`--traffic-commands NAME`). `TOKATE_BINARY` selects the CLI artifact, and
`TOKATE_TEST_ROOT` selects writable fixture storage outside `/tmp` for managed
runs. The owner runs the complete `scripts/verify.sh` independently.
