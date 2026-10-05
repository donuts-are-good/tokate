# Native Claude capability gate

`tokate claude-check --model claude-opus-4-6 --effort high [--binary PATH] --json`
checks an explicitly installed, unmodified native Claude Code 2.1.258 on Linux
x64. It never installs tools or runs inference. Missing tools, altered binaries,
other pairs (including `xhigh`), managed-policy presence and metadata inspection
errors fail before profile exposure. Managed Claude execution remains disabled;
even successful interface checks exit with `unsupported_capability` and list
the remaining evidence gaps. The contribution/workflow adapter belongs to #20.

The [official release manifest](https://downloads.claude.ai/claude-code-releases/2.1.258/manifest.json)
pins the `linux-x64` size to 215473560 bytes and SHA-256 to
`704f1334ac65d3e89e1c6c1d7663293ad786a6166afdb71b5075337df630f976`.
The diagnostic reuses independent verification's whole-process boundary with a
read-only executable, an empty synthetic repository, hidden Git metadata,
private temporary storage, scrubbed environment and no network. It checks
version/help and standalone `--restricted --safe-mode auth status --json` in a
fresh unauthenticated synthetic profile. No donor profile or credentials are
opened, copied or retained. These checks cannot establish login readiness or
remote subscription entitlement.

Reusable native controls declare the exact model/effort, restricted safe mode,
empty settings sources/MCP, only Read/Write/Edit/Bash, acceptEdits, mandatory
Bash sandbox with no unsandboxed fallback, no session persistence, no fallback
chain, disabled optional remapping/refusal/stream fallback, and zero retries.
Command-network allowlists are separate from provider connectivity. These are
configured controls, not proved effective native behavior; the diagnostic never
launches its reported inference invocation. `--bare` and the post-pin
`--permission-prompts none` are excluded. Environment scrub can affect permission
mode; any reported mode/model/effort conflict is refused. Missing reports remain
absent; requested choices, configured invocation and native usage are distinct.

Only native `loggedIn:true`, `authMethod:"claude.ai"`, `apiProvider:"firstParty"`
and `subscriptionType:"pro"` or `"max"` pass the reusable status parser. It
retains exactly those four fields. Optional organization identifiers/names do
not imply managed authentication and are discarded. Mixed profiles, environment
tokens, API/cloud authentication and managed accounts remain unsupported. A
sole-use native-login profile boundary, authenticated file/command/helper
behavior, independent native networking, effective controls and native cleanup
are unproven: help and scripted fixtures cannot establish them.

Official [authentication/integration conditions](https://code.claude.com/docs/en/legal-and-compliance)
were checked on 2026-10-05: donors sign into the unmodified CLI themselves;
Tokate must not collect or intermediate their subscription credentials. See
also [CLI reference](https://code.claude.com/docs/en/cli-reference),
[sandboxing](https://code.claude.com/docs/en/sandboxing),
[model controls](https://code.claude.com/docs/en/model-config) and
[managed settings](https://code.claude.com/docs/en/managed-settings). Current
documentation includes controls newer than the pin. There is no real-native
support claim until installed-version runtime evidence closes these gaps.
