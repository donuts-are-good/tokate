# Managed pi local execution

Linux x64 only. Requires pi 1.0.0, pi-ai 1.0.0, pi-agent-core 1.0.0,
Node 26.10.0, bubblewrap, and an already-running no-auth HTTP loopback
Chat Completions endpoint. Tokate installs nothing and starts no model server.

Version-2 owner policy must allow the exact pair
`{"harness":"pi","provider":"local-chat-completions"}`. With
`model_policy: "whitelist"`, list the exact model identifier with `["absent"]`.
Explicit `model_policy` is required for absent effort. Other pi versions, paid
providers, remote endpoints and reasoning controls are unsupported.

After a version-2 reservation:

```sh
tokate prepare --repo OWNER/REPO --issue N --state STATE_SHA --source tokate \
  --harness pi --provider local-chat-completions --model 'org/model:tag' \
  --effort absent --endpoint http://127.0.0.1:8080/v1 \
  --pi-root /absolute/installed/node_modules --node /absolute/installed/node \
  --seconds 3600 --verification-reserve 1200
tokate work --run RUN_DIRECTORY
tokate submit --run RUN_DIRECTORY
```

Runtime paths are optional when PATH resolves pi's scoped package
`dist/bundle/cli.js` and the pinned Node executable. The module tree must be
self-contained. Endpoint and runtime paths stay in private run state.
The SDK receives only generated model settings and an empty authentication
profile. Its required API-key placeholder is the public value `tokate-no-auth`.
Donor credentials, user settings and repository customization are never loaded.

The SDK runs in bubblewrap with private PID/user namespaces, read-only system
files and the selected module tree, a writable checkout and private temporary
storage. Git metadata is masked. Only read, edit, write and constrained bash
are enabled. File tools accept checkout/tool-temp paths only and reject symlinks.
Bash hides SDK
control files and has network access only when owner and donor permit it.
Extensions, skills, prompts, context discovery, retries, compaction, cache warming
and persistent sessions are disabled. Failed capability probes stop before inference.

The SDK can reach the selected endpoint regardless of command network policy.
The endpoint may itself use the network. Cancellation collects client descendants,
including detached processes, but does not prove a server resource or billing cap.
There is no CPU, RAM or disk quota. The kernel, runtime and selected module tree
remain trusted. No automatic continuation, model substitution or fallback occurs.

Tokate records the selected invocation separately from harness-reported usage.
Failed, malformed, truncated, empty or incomplete turns cannot publish. Completed
work passes candidate capture, protected-path checks and independent verification
before the coordinator opens a draft PR.

The native proof uses the pinned SDK and a deterministic local server without
model inference. Run it separately with an existing installation:

```sh
python3 scripts/pi-proof.py --pi-root /absolute/installed/node_modules \
  --node /absolute/installed/node
```

The gate covers read/edit/write, constrained bash, private sentinels, Git/control
denial, hostile configuration, network off/on, exact selection, rejected effort,
failed responses, cancellation, descendant cleanup, verification and publication.
