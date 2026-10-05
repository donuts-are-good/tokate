# Managed pi local execution

This opt-in path requires version-2 coordination and the exact owner pair
`{"harness":"pi","provider":"local-chat-completions"}` in `allowed_tools`.
With `model_policy: "whitelist"`, list the exact endpoint model identifier in
`models` with `["absent"]`. Explicit `model_policy` is required for absent effort.
Version-1 defaults and saved Codex contributions keep their existing behavior.
Paid providers, reasoning controls, remote endpoints, other pi versions and other
harness/provider combinations are rejected. Provider selection is separate from
harness identity; `org/model:tag` is an exact model identifier, never a search.

After the ordinary version-2 reservation, prepare a managed contribution:

```sh
tokate prepare --repo OWNER/REPO --issue N --state STATE_SHA --source tokate \
  --harness pi --provider local-chat-completions --model 'org/model:tag' \
  --effort absent --endpoint http://127.0.0.1:8080/v1 \
  --pi-root /absolute/installed/node_modules --node /absolute/installed/node \
  --seconds 3600 --verification-reserve 1200
tokate work --run RUN_DIRECTORY
```

The donor must already have pi 1.0.0 (including pi-ai and pi-agent-core 1.0.0), Node 26.10.0, and a running no-auth HTTP
loopback Chat Completions endpoint. Tokate installs nothing, starts no model server,
and downloads no models. Without explicit runtime paths, it resolves a PATH pi
symlink to the scoped npm package's `dist/cli.js` and resolves Node on PATH.
The module tree and its dependencies must be self-contained; layouts needing
symlinks outside that tree fail closed. Paths and endpoint details stay in private
saved run state, outside task context and publication metadata. The generated
model configuration uses the public placeholder `tokate-no-auth` because pi's
Chat Completions interface requires an API-key value; no donor credential is read.
The endpoint must accept this nonsecret placeholder without authentication.

A trusted bridge imports the official SDK and checks nested ModelRuntime,
SettingsManager and SessionManager interfaces, the exact model, and the four
active tool definitions before prompting. Settings and sessions are in memory;
a custom ResourceLoader returns no extensions, skills, prompts, themes or context
files. Authentication uses an empty generated profile. Agent and provider retries,
compaction and cache warming are disabled. Host environment, user configuration,
repository settings, npm lifecycle scripts and repository extensions are not loaded.

The entire harness runs inside bubblewrap with private PID/user namespaces,
dropped capabilities, read-only system/runtime mounts, one writable checkout and
private temporary storage. Git metadata is masked; run control and host home
files are outside the mounted checkout. File tools accept checkout/tool-temp paths
only. Bash uses another boundary, hides harness control settings, clears its
environment, and disables network unless both owner and donor permit it. Commands
and alternate helpers receive the same restrictions. No local execution fallback
exists. Preflight isolation/SDK failures stop before inference.

The SDK process can reach the selected loopback endpoint even with command network
disabled. Endpoint connectivity does not prove offline operation: the server can
itself use the network. Deadlines and cancellation stop client descendants, including
processes creating new sessions; they do not prove a hard server resource or billing
cap. There is no CPU, RAM or disk quota beyond the existing runtime allowance.
Kernel/runtime trust and the donor's executable/module tree remain prerequisites.

Tokate records the observed SDK invocation separately from harness-reported model
and usage. A failed, malformed, truncated, empty or incomplete turn is not publishable.
Completed work goes through existing candidate capture, protected-path validation,
independent owner verification, saved evidence and explicit publication contracts.
Preparation supports handoff before inference. Interrupted inference requires fresh
owner approval; there is no automatic continuation, substitution or retry.

Release validation is still required. Only Linux x64 containment has been exercised
here; the real installed pi path has not been verified in this implementation
sandbox. Do not advertise broader support or release this path until this gate passes
using an existing installation (the server is deterministic and spends no inference):

```sh
artifacts/tests/tokate-tests --pi
python3 scripts/pi-proof.py --pi-root /absolute/installed/node_modules \
  --node /absolute/installed/node
```

The real gate checks SDK import, nested namespaces, exact selection, read/edit/write,
constrained bash/helpers, private sentinels, Git/control denial, hostile configuration,
network off/on, failed/malformed/incomplete/empty output, cancellation, and independent
owner verification. The focused G# checks cover policy/effort rejection, completion
mapping, real outer containment and deadline descendant cleanup. Full repository
verification remains the independent runner's responsibility.
