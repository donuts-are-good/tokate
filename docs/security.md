# Data and isolation

Tokate coordinates public GitHub issues and PRs. Donors keep their own accounts
and tools. Credentials and subscription quotas are not transferred to owners.
Tokate adds no separate telemetry upload in these paths. GitHub, harnesses and
model services have their own data policies.

## What leaves your machine

| Recipient | Data |
| --- | --- |
| GitHub | Issue requests, coordination state, donor/tool declarations, commits, draft PRs, public summaries and receipts. |
| Selected harness and model service | Approved task, owner instructions and repository context used during coding. |
| Selected Pi endpoint | Local-model inference requests. A loopback endpoint may itself contact other services. |
| Command destinations | Repository commands can use the network only when owner policy and donor consent both permit it. |

PR summaries come from a dedicated validated public artifact, not private reports,
prompts or raw logs. Tool identity, usage and local check declarations are not remote
attestations. Review staged files and public descriptions before publication.
A repository or tool can contain or print secrets. Tokate is not a general secret
scanner, and there is no blanket `.env` exclusion inside an approved checkout.

## Authentication and discovery

GitHub operations use `gh` and its credential helper. Codex owns its ChatGPT login.
Tokate forwards only specific authentication requirements to those host tools.
It does not read credential files, mixed configuration or whole environments to
infer model defaults. Pi receives generated model settings and an empty auth profile.
The public `tokate-no-auth` value used for its loopback endpoint is not a credential.

Host tools are trusted programs with their own file access. Narrow child environments
are not whole-program isolation. Custom proxies, certificates and home-only build
caches may need system setup. Tokate does not expose arbitrary environment passthrough.

## Execution boundaries

Managed repository commands and independent verification use Linux isolation.
Unsupported sandbox controls fail before work instead of falling back to host execution.
Codex remains a trusted host harness. Pi's SDK runs inside a separate bubblewrap
boundary with its selected runtime mounted read-only, private temporary storage,
constrained file/shell tools, and no repository extensions, skills or automatic retries.

Verification runs in a disposable candidate copy. Ordered checks share that copy.
They cannot write the saved checkout or Git metadata. Host credentials, sibling runs
and control files are outside the verification mounts. Command network access needs
both owner permission and donor opt-in. Inference connectivity is separate.

Tokate does not sandbox coding done through external tools. The kernel, installed
tools and selected runtimes remain trusted. There are no CPU, RAM or disk quotas.
Timeout and cancellation collect client descendants but do not prove server resource
or billing limits. Abrupt termination can leave incomplete evidence.

## Local state

Runs live under `~/.local/state/tokate/runs` or an explicit `--runs` directory.
They contain checkouts, metadata, private logs, patches and publication evidence.
Logs are bounded and can be truncated. They can contain sensitive tool output.
There is no automatic expiry or general redaction. Keep them private and preserve
them for recovery. Public status summaries omit raw logs.

The installer verifies archive checksums and binary versions before replacement.
This detects corruption, not a compromised release account. It manages the user
installation without sudo. Uninstall preserves runs and credentials.

The owner coordinator uses privileged GitHub operations without checking out or
executing donor code. Keep ordinary fork CI read-only and free of secrets. Passing
checks do not replace review of correctness, scope or security.
