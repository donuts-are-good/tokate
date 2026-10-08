# Recover or update work

Start with `tokate status --run DIR`. Keep the original checkout and evidence.
Do not edit `run.json`, delete branches, or start a second run to bypass a failure.
Commands below do not start inference unless they explicitly use `work`.

| State | Next action |
| --- | --- |
| Claim pending | Wait for the coordinator. `prepare --run DIR` checks acceptance without inference. |
| Interrupted preparation | Inspect saved state, then `prepare --run DIR`. |
| Failed inference | Preserve evidence. A new attempt needs current authority and a fresh donor budget. |
| Expired claim or stale approval | Return to the owner. |
| Verified work awaiting publication | `submit --run DIR` for coordinated contributions. |
| Existing PR needs changes | Use an amendment below. |
| Upstream moved | `reconcile --run DIR`, inspect conflicts, then obtain owner authorization for amendment. |

Always use `tokate help COMMAND` for the installed command's inputs and restrictions.
An uncertain remote write must be reconciled before another write. Repeating the
same saved intent may resume publication; it does not authorize new work.

## Correct completed work before publication

```sh
tokate recover --run DIR --prepare
```

This archives completed evidence. Edit and commit `DIR/checkout`, leaving a clean
candidate. Declare the actual correction tools separately from the original tools:

```sh
tokate recover --run DIR --commit SHA --seconds 300 --tools TOOLS_FILE --summary SUMMARY_FILE
tokate submit --run DIR
```

The correction uses a separate verification budget. Failed or incomplete original
inference cannot use this path. For older direct-publication runs, follow the
reported `publish` action instead of `submit`.

## Amend a published PR

Edit and commit the saved checkout, then verify and publish that exact commit:

```sh
tokate amend --run DIR --commit SHA --seconds 300 --tools TOOLS_FILE --summary SUMMARY_FILE
```

A summary describes the entire final diff. Owner edits outside Tokate's PR-body
regions are preserved. Original execution and later editing remain separately
attributed. Fresh CI and owner review are still required.

If upstream moved, `reconcile --run DIR` merges the current target without inference.
Resolve conflicts and use `--resume`. The owner then issues `authorize-sync` for the
exact candidate and upstream commits. Pass that grant to `amend --sync GRANT`.
If the original local run is unavailable, `repair` uses separate evidence storage
and an explicit owner grant. It cannot reconstruct private execution evidence.

## Continue stopped work

Same-donor, unpublished managed work can seed a fresh attempt under unchanged
approval. A coordinator lease transition must first establish the fresh active
attempt. Then explicitly select the original tool and a new budget:

```sh
tokate prepare --repo OWNER/REPO --issue 42 --state CURRENT_STATE_SHA --source tokate \
  --continue-from PRIOR_RUN_DIR --profile PROFILE --seconds 3600 --verification-reserve 1200 --yes
tokate work --run NEW_RUN_DIR --yes
tokate submit --run NEW_RUN_DIR
```

Pi must retain its original model, runtime and endpoint. Network permission needs
fresh opt-in. Preparation preserves the predecessor's files and failed outcome.
Active, completed, external, published and cross-donor sources are excluded.
Update the owner's pinned coordinator before submission. Older assignment-bound
runs require the owner's `approve --continue-approval` path. Do not silently change
policy versions. Advanced lease requests use `request --file`; the accepted schema
is defined by [RequestData](https://github.com/obselate/tokate/blob/main/src/Contributions/RequestData.gs).

After acceptance and evidence backup, you may explicitly delete a completed run.
This prevents later amendment from that run. Uninstalling Tokate preserves saved work.
