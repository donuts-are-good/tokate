# Native Claude capability checks

Managed Claude inference is disabled. The callable gate performs no inference;
contribution records, publication and the workflow adapter remain separate work.

```sh
tokate claude-capabilities --claude /installed/native/claude \
  --claude-profile /private/sole-use-login --sole-use \
  --model claude-opus-4-6 --effort high --json
```

Use Linux x64, installed unmodified native Claude Code, bubblewrap and socat.
The gate never installs tools or requires exact-version equality. `--sole-use`
attests a fresh personal native-login profile without mixed reuse. Only login
metadata files, backups and debug directories are accepted. Native login and
credential storage belong to the CLI; Tokate never inspects their contents.

Before profile exposure, presence or inspection errors at `/etc/claude-code`
fail closed using metadata only. Standalone `--restricted --safe-mode auth status
--json` runs without repository exposure or external connectivity. Only
`loggedIn:true`, `authMethod:"claude.ai"`, `apiProvider:"firstParty"` and
`subscriptionType:"pro"` or `"max"` are retained. Optional organization fields
are discarded and do not identify managed accounts. Synthetic status proves
local schema behavior, not remote entitlement.

`--path` returns declared boundary arguments after authentication checks. These
reuse the Pi boundary policy: selected checkout, hidden Git metadata, read-only
system/runtime mounts, private temporary storage, cleared environment and PID
isolation. Restricted file tools, safe mode, empty settings sources, hooks off,
strict empty MCP and an explicit tool list configure suppression of repository
settings, skills, plugins, LSP and automatic helpers. Native shell sandboxing
is required without unsandboxed fallback; profile/control paths are deny-listed.
Declared controls are distinct from behavior proved by fixtures.

Provider connectivity stays separate from `--allow-network`, which changes
only the command sandbox's domain allowlist. Subprocess scrub uses explicit
`default` permission mode, allowed tools and `--permission-prompts none`.
Exact Opus 4.6/high is requested; aliases, other efforts and `xhigh` are refused.
Documented controls turn off fast mode, ultracode, remapping, fallback chains,
refusal fallback, background tasks, title requests, compaction and retries.
`--file` checks a bounded native JSONL report: conflicting model, effort or
permission fields fail; missing fields remain absent and usage is native-reported.

The download helper resolves the official latest channel once and checks its
native artifact against HTTPS manifest SHA256 and size. Native CI wiring is
pending owner installation. Run
`python3 scripts/claude-proof.py --claude /installed/native/claude` for ordinary
synthetic checks with no external service route or Claude inference. Native
2.1.293 passed Pro/Max status, managed-policy metadata refusal, repository
Read/Write/Bash and helper operations, local proxy command-network permission,
exact protocol requests, failure without retry, cancellation and child cleanup.
Requests used synthetic fixture API authentication; personal native status was
checked separately. Native reports omit effort; the local request reported high.
Whole-process credential isolation, remote subscription availability and the
workflow budget adapter remain unproven, so managed inference stays disabled.

The [integration conditions](https://code.claude.com/docs/en/legal-and-compliance),
checked on 2026-10-07, require unmodified native execution, native sign-in and
direct user billing, and forbid collecting or intermediating subscription
credentials. Controls follow the [CLI reference](https://code.claude.com/docs/en/cli-reference),
[sandboxing guide](https://code.claude.com/docs/en/sandboxing),
[model configuration](https://code.claude.com/docs/en/model-config),
[managed settings](https://code.claude.com/docs/en/managed-settings) and
[environment variables](https://code.claude.com/docs/en/env-vars).
