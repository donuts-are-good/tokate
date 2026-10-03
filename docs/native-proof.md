# Native API and local Responses proof

This is a synthetic execution proof for the prerequisites of #21 and #22, not
an API/local adapter or production authentication gate. Tokate's existing
ChatGPT execution path, owner policy, model whitelist and sandbox policy are
unchanged. Source documentation alone does not establish runtime support.

Run the focused regressions with an explicitly installed binary:

```sh
python3 scripts/native-proof.py --codex /absolute/path/to/codex
python3 scripts/native-proof.py --codex /absolute/path/to/codex --check
```

`--check` checks the pinned CLI interfaces, offline API catalogue and required
Linux namespace support. It does not read an account, contact inference, prove
model availability or approve production use. Missing binaries, interfaces or
namespace support fail clearly. Neither command installs tools, downloads
models or starts a model runtime. The full owner verification script also runs
the focused regressions.

## Measured binary and identities

The measured Linux x64 binary reports `codex-cli 0.160.0`, with SHA-256
`12eb3e81114588aca3b7998f4f19e8997b056aca08e57a7ca7c8a3ec8c652aad`.
The test pins that version and records each installed binary's actual digest.
It requires `exec --strict-config --ignore-user-config --ignore-rules`, explicit
model/config/profile controls, stdio app-server, named native permission
profiles with managed requirements, and `debug models --bundled`.

The API fixture requests `gpt-6.1-sol` / `high`. Its native bundled catalogue
reports API support and efforts `low`, `medium`, `high`, `xhigh`, `max`, `ultra`.
This is catalogue evidence, not live-account availability or remote model
attestation. The native request observed by the fixture carries exactly the
requested model and effort. Synthetic usage fields are fixture output, not
billing measurements.

Native 0.160.0 refuses overriding the reserved `openai` provider ID. The API
proof therefore selects `api-fixture`, a custom Responses provider requiring
native OpenAI authentication, pointing only to the generated loopback fixture.
It proves native file API authentication with a selected native home; it does
not prove a live request to OpenAI's built-in provider. The no-auth provider is
`fixture`, with exact model `synthetic-local-exact`. Its request has no
Authorization/API-key header or effort field. That model's capabilities are
not inferred from the OpenAI catalogue. The fixture is already listening when
Codex starts. No OSS startup flags, pull/start routes or model helpers are used.

## Isolation and bounded execution

Every fixture home and workspace is generated under a private mode-0700
temporary directory in this checkout. Authentication and helper files are
mode 0600. Only synthetic API keys and synthetic JWTs are written/read for
assertions. No selected donor home, credentials, user settings or environment
dump is inspected. The native process receives a generated `HOME` and
`CODEX_HOME`, fixed system PATH and locale, with no inherited tokens, API keys,
proxies or keyring context. Native file credential storage is selected.
Fixtures and private native output disappear at teardown; output retains only
synthetic evidence and nonsecret findings.

An outer network namespace contains only the loopback fixture, with empty
system configuration under `/etc`. External inference and refresh/login
endpoints are unreachable. Native background model-list and workspace-routing
GETs to the synthetic fixture receive explicit 404s; unexpected routes fail
the proof. These are metadata requests, not inference or model downloads.
The outer host-root bind is **not a restrictive
filesystem sandbox**. Repository commands use the accepted native permission
profile: deny root reads, allow minimal runtime files, this synthetic checkout,
the installed native executable and private temporary storage, deny `.git`,
and deny command networking. The fixture remains reachable by the harness
while native repository commands cannot create/connect network sockets.

The proof exercises native sandbox file/shell/helper operations and a native
`codex exec` shell/patch sequence against generated authentication and
protected-file sentinels. Assertions check the original protected files remain
unchanged, not merely an error string: native shadow filesystem writes may
succeed without changing the originals. This does not broaden protected-path
policy or the production filesystem boundary.

Each invocation owns a PID namespace with its command as PID 1, private `/tmp`
and process group. Normal exit destroys its namespace; cancellation/deadline
kill only its owned group and namespace. Detached double-fork/setsid children
use a bounded readiness handshake before completion, deadline and cancellation,
while a server created before those invocations remains alive. No host process enumeration or existing
donor model-server termination is used. This supervisor is proof-only; it does
not claim the existing production process-group cleanup handles detached
children equivalently.

Native provider budgets are explicitly `request_max_retries=0`,
`stream_max_retries=0`, `stream_idle_timeout_ms=1000`. Synthetic 401, 404, 503 and
broken-stream responses each produce one request and a failed native turn,
without substitution or harness retries. The unsupported-model test preserves
the exact requested model even on refusal. Native invocations have ten-second
deadlines, metadata probes ten seconds and the complete proof 180 seconds.
Retained stdout and stderr are capped during concurrent reads. Child overflow
regressions verify early refusal before child completion. No currency, token
or GPU-memory cap is claimed.

## Established results and blockers

| Boundary | Installed-runtime evidence |
| --- | --- |
| API/missing/no-auth metadata | Bounded `initialize`, `initialized`, `account/read` with `refreshToken:false` identifies `apiKey`, missing authentication, and authentication not required. Only account type and `requiresOpenaiAuth` are retained. Unknown types, missing/invalid fields and unfamiliar result shapes fail closed. The pinned runtime's additional `workspaceRouting` value is discarded. |
| API-only refusal | Non-API metadata is refused before execution. `forced_login_method=api` is exercised only on a disposable synthetic ChatGPT home; native execution fails before inference and clears its mismatched credentials. No production restriction is set. |
| Explicit native home | File API authentication reaches the fixture from the generated selected `CODEX_HOME`. A named profile retains that authentication home. With `--ignore-user-config`, this runtime also ignores the named profile's effort setting; the observed default is `low`, not its requested `medium`. |
| Unknown settings | Unknown top-level and provider settings fail before inference under strict configuration. An invalid effort override reaches inference, so the proof uses a nonsecret bundled API catalogue gate and refuses any unverified local effort. Strict configuration alone is insufficient. |
| Model migration/fallback | Explicit model selection survives a generated migration-notice mapping. Model/auth/stream errors fail with one request and no fallback. |
| Startup | Generated hooks and MCP helper have an independently verified marker; metadata and coding startup leave it absent. Hook/plugin/app/skill discovery features are disabled. Repository configuration is refused before native startup. No installed plugin package is activated by this proof. |
| ChatGPT metadata blocker | Despite `refreshToken:false`, native account/read attempts workspace-routing discovery and refuses the offline synthetic ChatGPT fixture. Token-free identification of all four requested fixtures is not established. |
| App-server startup blocker | App-server lacks `--ignore-user-config`. Generated fixture startup suppression is measured; arbitrary production home startup suppression is not established. |
| Managed override blocker | Generated requirements restricting approval to `on-request` can replace requested `never` and still reach inference. No supported nonsecret effective endpoint/provider/model override gate has been established. Mixed/managed production configuration is unsupported; this proof never reads it and attempts redaction. |

The regressions print `UNSUPPORTED` for these measured contract gaps. Exit zero
means the deterministic assertions passed, **not** that the entire production
contract is supported. Unexpected behavior remains a failing check. The
ChatGPT metadata, profile-selection and managed/startup limitations must be
resolved or explicitly adopted as unsupported configurations before separately
approved API/local adapter work. There is no live-account success claim.

Official source contracts:
[authentication](https://learn.chatgpt.com/docs/auth),
[CLI interfaces](https://learn.chatgpt.com/docs/developer-commands?surface=cli),
[app-server metadata](https://learn.chatgpt.com/docs/app-server), and
[provider/permission configuration](https://learn.chatgpt.com/docs/config-file/config-reference).
