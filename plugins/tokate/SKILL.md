---
name: tokate
description: Guide a Tokate donation, inspect saved contribution progress, or submit verified work from the user's coding harness. Use when the user wants to contribute to a Tokate-approved GitHub issue.
---

Use the installed Tokate CLI as the authority for policy, coordination, verification and publication. Run `tokate help --json` for current commands and `tokate help COMMAND --json` for their inputs. Use `--json` for operations and read `status`, `error`, `data` and `next_actions`. Pending is not accepted or complete. Do not automatically repeat a mutating command.

Confirm the GitHub account with `gh api user --jq .login`. Read the issue, repository instructions and `tokate policy --repo OWNER/REPO --json`. Request only missing choices. Keep harness authentication in the harness. Never read credential files, mixed settings or environment dumps to discover a model. Use supported nonsecret metadata or ask for the exact harness, provider, model and effort. Never infer managed-adapter support from this skill being loaded.

Before coding, obtain authorization for the task, tool selection, time allocation and command network access. A saved profile does not authorize a budget. Keep the user's current harness unless they choose another.

- For a supported managed selection, use `select`, then `claim` with the approved budget. Save the returned run directory. After coordinator acceptance, `work --run DIR` runs the selected adapter and independent checks. Do not also implement the task in this session.
- To work in the current harness outside a supported managed adapter, use `claim --source external --tools FILE --seconds N`. The JSON file contains the user's nonsecret tool declarations, with `harness`, `provider`, `model` and `effort`. N is the independent verification allowance, not a measured coding limit. Agree on coding time separately and stop when it is exhausted. Include `usage` or `coding_seconds` only when observed, never estimated.

A pending claim has no work authority. Inspect `status --run DIR`, then resume the same request with `prepare --run DIR` after acceptance. Do not claim again. For external work, use the saved run's `coding` directory, follow its approved scope, retain original attribution and push the exact candidate to the saved donor branch. Write a short public summary bound to the candidate head. Run `external --run DIR --commit SHA --summary FILE` to verify that exact commit independently. Never describe external work as managed or its usage as independently attested.

After successful verification, use `submit --run DIR` only when publication is authorized. Pending publication is not a PR. Inspect the saved state and follow its explicit continuation action without redoing coding or verification. The owner reviews and merges. On cancellation, failure or stale authority, preserve the run and work, report the actual state and ask only for the decision needed to continue. Never silently extend a budget, switch models or retry inference.
