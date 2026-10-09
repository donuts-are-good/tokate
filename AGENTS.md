# Help a user with Tokate

Tokate coordinates owner-approved GitHub issues, donor work, verification and draft
PRs. Donors use their own accounts and tools. Owners review and merge.

## Start with the user's task

1. Infer whether the user is an owner or donor. Confirm the repository, issue and
   active account with `gh api user --jq .login`. Ask only for missing choices.
2. Read the issue, repository instructions and `tokate policy --repo OWNER/REPO`.
3. Explain the next action briefly, perform authorized work, and report actual
   results and the responsible person's next action.

Use [installation](README.md), the [owner guide](docs/owners.md) or the
[donor guide](docs/donors.md). The release supports Linux x86_64 with glibc 2.34+ or Alpine 3.24
and public GitHub repositories. `tokate help COMMAND` supplies installed syntax.
Do not infer support for another platform, forge or harness.

## Guide an owner

Run `tokate doctor --owner --auth`, then `tokate init --repo OWNER/REPO` inside the
repository. Preserve existing checks and customization. Review the generated policy
and pinned workflow, verify configuration, and commit it before approving tasks.
Initialize access once, approve the issue, then trust the donor or grant that issue.
Never grant access merely because someone requested it.

Before acceptance, inspect the diff and run `tokate verify-pr` and `tokate checks`.
Require green CI on the exact reviewed head. Inspect fork changes before authorizing
workflow execution. The owner decides acceptance and merge.

## Guide a donor

Use the donor's account and selected harness. Check project tools and access first.
Read [local Pi setup](docs/donors.md#local-inference-with-pi) when applicable.
Use `defaults` and `select` to reuse a permitted model choice without inference.
Never inspect credential files or mixed harness settings to discover defaults.

Use `tokate claim ISSUE_URL` with the selected profile or model/effort and explicit
budget. It creates the request without inference. Preserve the printed run directory.
After coordinator acceptance, use `tokate work --run DIR`, then `tokate submit --run DIR`.
The commands construct request data and select the applicable workflow. Normal donors
must not be asked to write claim JSON or manage coordination revisions.

Before inference, obtain consent for the task, harness/model, time allocation and
command network permission. Profiles do not authorize budgets or network access.
Do not retry, switch models or start another run because output is quiet. Inspect
`status --run DIR` and use [recovery](docs/recovery.md) for failures or changes.
If executing an approved donor task, stay within its permissions. Do not change
owner policy, start another run, publish or merge from inside that task.

## Use structured output

Every command accepts `--json`. `tokate help --json` lists commands, inputs and effects.
JSON never prompts. Read one stdout object with `schema_version`, `command`, `status`,
`exit_code`, `data`, `error`, `next_actions` and `truncated`. Diagnostics use stderr.
Exit 0 means the read or operation succeeded, 8 means pending, and 1 means failure.
A successful status read may describe failed work. Pending CI is not success.

`next_actions` contains argument arrays for separate authorized invocations. Never
execute them as automatic retries. Truncation means some summaries were omitted.
An output error can occur after effects, so inspect state before repeating a command.
Logs and raw reports stay private. Usage and model declarations are not identity
or billing attestations. See [data boundaries](docs/security.md).

## Write public PR summaries

Managed work writes `tokate-public-summary.json` in the checkout. For external
work, corrections or amendments, pass `--summary FILE` with the exact candidate head:

```json
{
  "head": "0123456789abcdef0123456789abcdef01234567",
  "changes": ["Fix empty results to display a useful message."],
  "verification": ["Empty result behavior check passed."],
  "limitations": ["Live model inference was not tested."]
}
```

Managed artifacts omit `head`; Tokate binds it to the candidate. Use short plain ASCII
sentences: 1–8 changes, up to 8 verification results and 4 limitations. Changes begin
with an action such as Add, Update, Remove or Fix. Each item is 3–200 characters and
the whole artifact is at most 4096 bytes. Omit markup, paths, URLs, credentials and
private logs. Describe the complete final diff, not the conversation or work history.
Declare later editing tools separately from original execution. Never claim manual
changes were completed by a donated inference run.
