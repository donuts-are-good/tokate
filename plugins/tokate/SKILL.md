---
name: tokate
description: Guide donor work on a Tokate-approved GitHub issue, inspect or resume a saved run, and verify or submit a draft PR. Use for Tokate contributions from the user's coding harness.
---

# Tokate donor workflow

Help a donor take an owner-approved issue to a verified draft PR using their selected harness. Work within the approved scope. The owner controls policy, acceptance and merging.

## Inspect the current state

Use `tokate help --json` and `tokate help COMMAND --json` as the installed command authority. Use `--json` for operations. Read `status`, `error`, `data` and `next_actions`. A successful read can describe failed work. Pending is not accepted or complete. `next_actions` are options, not authorization. Inspect saved state before repeating any mutating command, including after an output error.

For saved work, start with `tokate status --run DIR --json`. For a status-only request, report and stop. Do not create another claim. Before new work, confirm the account with `gh api user --jq .login`, read the issue and repository instructions, and inspect `tokate policy --repo OWNER/REPO --json`. Use `doctor` for the selected execution mode to check prerequisites. Resolve missing access with the owner before coding.

## Choose how coding runs

Obtain consent for the task, harness/model/effort, time allocation and command network access. Ask only for missing choices or consent. Keep the current harness unless the user chooses another. Profiles do not authorize budgets or network access. Never silently extend time, switch models or retry inference.

Keep authentication in the harness. Use supported nonsecret metadata for settings or ask for the exact selection. Never read credential files, mixed settings or environment dumps. An installed skill does not establish managed-adapter support or permission to launch another coding process.

- **Tokate launches coding:** use `select` for a supported managed selection, then `claim` with the approved budget. Its `--seconds` includes coding and verification. Save the returned run directory. Once prepared, `work --run DIR` launches the selected adapter and independent checks. Do not also code in this session.
- **This session codes:** use `claim ISSUE_URL --source external --tools FILE --seconds N`. External coding is outside Tokate's managed sandbox. N funds independent verification, not coding. Agree on coding time separately and stop when it expires.

An external tools file is a JSON array. Replace these placeholders with the actual selection and declare every tool used:

```json
[{"harness":"HARNESS","provider":"PROVIDER","model":"MODEL","effort":"EFFORT"}]
```

Include `usage` or `coding_seconds` only when observed, never estimated. Do not describe external work or reported usage as independently attested.

A pending claim grants no work authority. Inspect `status --run DIR`, then use `prepare --run DIR` to finish the same request after acceptance. Do not claim again.

## Verify and submit

For external work, code in `DIR/coding`, preserve original attribution and push the exact candidate to the saved donor branch. Run `external --run DIR --commit SHA --summary FILE` to verify that commit independently.

Supply a public summary for the exact candidate. Describe the complete final diff and actual verification, using plain ASCII without markup, paths, URLs, credentials or private logs:

```json
{
  "head": "0123456789abcdef0123456789abcdef01234567",
  "changes": ["Fix empty results to display a useful message."],
  "verification": ["Empty result behavior check passed."],
  "limitations": []
}
```

Use 1 to 8 changes, up to 8 verification results and 4 limitations, each 3 to 200 characters, at most 4096 bytes total. Managed coding writes `tokate-public-summary.json` in its checkout without `head`. Tokate binds it to the candidate.

After verification succeeds, use `submit --run DIR` when publication is authorized. Pending publication is not a PR. Inspect state and follow its continuation action without redoing coding or verification. Report the result and who must act next. Fresh CI and owner review remain required.

## Recover or continue

Preserve the run, checkout and evidence after cancellation, failure or stale authority. Do not edit `run.json` or bypass failure with a new run. Ask only for the decision needed to continue.

- Use `request --run DIR --operation ACTION` for an explicitly chosen `pause`, `resume`, `renew` or `release`. Resuming a reservation does not restart coding.
- For unpublished corrections, inspect `help recover`. For a published PR, edit `DIR/checkout`, then use `amend --run DIR --commit SHA --seconds N --tools FILE --summary FILE`. Declare later editing tools separately from original execution. Omitted amendment tools mean manual editing. Add `--resume` only when using a resumed reservation.
- Useful stopped managed work can become an authorized incomplete draft with `submit --run DIR --incomplete`. Continue another donor's published work with `claim --from-pr N` and preserve their commits.
