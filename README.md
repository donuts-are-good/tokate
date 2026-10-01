# Compute Donor

A working prototype for donating Codex runs to a project's task queue.
Maintainers choose the work. Donors choose a project, job count, runtime limit,
and whether their worker may edit its temporary checkout.

The coordinator stores tasks and results in SQLite. A worker claims a task over
HTTP, clones the pinned commit, runs the donor's local Codex CLI, and returns a
report, measured usage, and an optional Git patch. The donor's ChatGPT credentials
stay on their machine. No API key or Python dependencies are required.

## Run the goo-widgets example

Requires Linux, Python 3.11+, Git, and a recent Codex CLI with
`--ignore-user-config` and `--ephemeral`. Tested with Codex CLI 0.159.3.

In the project directory, start the coordinator:

```sh
python -m compute_donor init
python -m compute_donor serve
```

In another terminal, register the repository's committed HEAD and queue a task:

```sh
python -m compute_donor project goo-widgets --repo ../goo-widgets
python -m compute_donor submit goo-widgets --prompt-file examples/goo-widgets.txt
python -m compute_donor grant goo-widgets --donor xaz --jobs 1 --task-seconds 180 --out .state/donor.json
```

On the donor machine, use an existing ChatGPT login or run `codex login`, then:

```sh
python -m compute_donor work --grant .state/donor.json --repo ../goo-widgets --jobs 1 --seconds 180
```

The worker requires `codex login status` to report a ChatGPT login. It does not
pass API-key environment variables or load the donor's user config, MCP servers,
or configured user hooks into the run. An optional `--model` selects a model.
Without it, Codex uses its default model.

The queue and worker are separate processes. For this first experiment they can
run on the same machine. The grant contains only a credential for this queue,
its origin, and the pinned project identity. It is not an OpenAI credential.

Inspect the job ID printed by `submit`:

```sh
python -m compute_donor status
python -m compute_donor show JOB_ID
```

Artifacts remain in `.runs/JOB_ID/`: `report.md`, `receipt.json`, `events.jsonl`,
`stderr.log`, and the independent `checkout/`. The receipt includes elapsed
seconds and the usage fields Codex actually returned. Missing usage is `null`,
not zero. Cached tokens are part of input usage, not an additional total.

The initial live example already registered `goo-widgets` at
`74379dbd3e9b6d301232e8ba0e9056466df7f8f8`. If that state is present, skip `init`
and `project`, submit another task, and issue a fresh grant with a new file path.
The first grant has been spent. The live job was `f649589f8a4d255a`.

## Tasks that produce patches

Both the maintainer and donor must select `workspace-write`:

```sh
python -m compute_donor submit goo-widgets --prompt-file my-task.txt --mode workspace-write
python -m compute_donor work --grant .state/donor.json --repo ../goo-widgets --sandbox workspace-write
```

The worker stages changes only in its separate clone and returns a binary-safe
Git patch, including new unignored files, as `changes.patch` and in the receipt.
It does not apply changes to the source checkout or push them upstream. Check
the patch against its recorded base commit before applying it.

Projects are pinned at registration. Use another project name to test a new
commit. Workers supply their own local repository containing that commit, so
the coordinator cannot select an arbitrary donor filesystem path.

## Donation limits and failures

- `grant --jobs` is a persistent claim allowance. A claimed attempt spends one
  job even if it fails or the worker disappears.
- `grant --task-seconds` limits each claimed job. The donor's `work --seconds`
  further limits the session's execution time, including checkout setup.
  Process cleanup, artifact collection, and HTTP requests can add overhead.
- `work --jobs` limits attempts during that invocation. It cannot increase the
  grant's remaining allowance. The worker exits when no compatible work exists.
- Read-only workers never claim write tasks. Each grant is scoped to one
  project and can have only one active job.
- Codex failures and usage-limit errors stop the worker. There is no automatic
  retry or switch to API billing.
- A runtime timeout terminates the Codex process group. Interrupted workers'
  jobs expire after their allotted runtime plus 30 seconds. Expired jobs are
  never automatically requeued, avoiding duplicate subscription spending.
- If a result upload fails, the local receipt survives. Retry with
  `python -m compute_donor publish JOB_ID --grant .state/donor.json` before the
  lease ends. Repeated identical uploads are idempotent. After expiry, inspect
  the local artifact directly.
- `python -m compute_donor revoke GRANT_ID` disables new claims and uploads.
  It does not remotely kill an already running donor process. Stop that worker
  locally to end it immediately.

These are execution limits, not a hard token cap or a percentage of the user's
remaining subscription. Codex reports usage at turn completion, so this
prototype cannot promise “use only my leftover 20%.” It consumes the donor's
existing allowance as work runs. No balance is transferred to the project.

## Scope

This is a local experiment for trusted maintainers and repositories. Codex's
read-only or workspace-write sandbox is used with approvals set to never.
An independent checkout protects the source working tree, but is not a VM or a
complete confidentiality boundary around the donor's home directory. There is
no sandbox-bypass option. Public task execution needs stronger host isolation.

The server binds to `127.0.0.1:8768`. Keep it local or use an SSH tunnel for this
prototype. A remote origin must use HTTPS, with TLS termination managed outside
this server. Admin commands read `.state/admin.token`; workers receive only
their project grant. Credentials are created with mode 0600, grants are hashed
in SQLite, and runtime directories are ignored by Git. Results and usage are
worker-reported, not independently verified for billing.

The documented [Codex non-interactive interface](https://learn.chatgpt.com/docs/non-interactive-mode)
provides JSONL events and final-message artifacts. OpenAI also documents
[ChatGPT plan usage for local open-source apps](https://developers.openai.com/siwc/token-sharing-open-source),
which could replace the CLI dependency in a later client. This prototype does
not implement that OAuth flow or establish provider approval for a public
donation service.

## Verification

```sh
python -m unittest discover -s tests -v
```

The end-to-end tests use real HTTP requests, SQLite, Git repositories, and CLI
subprocesses. A deterministic fake Codex executable covers patch application,
dirty source checkout preservation, competing claims, project scope, grant
exhaustion, revocation, failures, process-group timeouts, and expired leases.
Tests do not spend subscription usage. The separate live goo-widgets run used
the real signed-in CLI and returned a verification-stage report in 35.276s.
