# Native OMP SDK proof

Build the test executable, then supply the normal installed SDK tree and Bun:

```sh
dotnet build tests/Tokate.Tests.gsproj -c Release -warnaserror
python3 scripts/omp-proof.py --omp-root /absolute/node_modules --bun /absolute/bun
```

The runner resolves the official latest release once, with a 15-second timeout,
one response, no redirects and a 1 MiB response bound. `--release-record FILE`
reuses a previously resolved release response. It records actual SDK and Bun
versions and the Bun digest; capabilities determine compatibility. `--tests`
selects a built test executable; `--case` selects partial source validation.
The runner installs nothing, starts no model runtime and reads no donor profile.
Each case uses synthetic settings, harness-created authentication storage,
explicit finite model metadata and a scripted endpoint inside a network
namespace without an external route. Cases have 30-second process deadlines,
2-second provider watchdogs, bounded retained output and a 600-second total limit.

Measured with official OMP 18.8.3 and Bun 1.4.2:

- ModelRegistry metadata retains exact configured limits; missing, invalid,
  ambiguous and unconfigured models and unknown settings are refused.
- Native direct file tools, a streamed read larger than 4 MiB, JSON helpers and
  native commands preserve outside-home, symlink and Git sentinels. Native
  read/write/edit/bash protocol turns retain the exact model, effort and limit.
  Native async and service requests are refused.
- The existing native stream function receives a supported fetch override;
  URL, method, header, redirect and per-dispatch attempt gates admit only the
  scripted request. Provider transport and effort retries, empty-result recovery
  and truncated-tool continuation cannot send a second unapproved request.
- Malformed, incomplete, length, HTTP error and cancelled replies cannot produce
  completion. A raw SSE hook rejects missing, negative and excessive usage even
  when OMP normalizes it. Completion requires settled native work, disposal,
  drained process output and owned PID namespace teardown. Detached children
  acknowledge readiness; heartbeats stop before completion is reported and
  after cancellation and command deadlines.

The 29-case run recorded 26 passed cases and three blocked cases, exiting **1**:
direct and model-driven native
bash can reach the inference loopback namespace with task networking disabled,
restricted sessions ignore the public inline extension interception hook, and
unsupported PTY requests silently fall back to embedded execution.
These cases are reported as blocked, never passed. The outer namespace blocks
external traffic but does not separate command networking from inference.

MCP, LSP, IRC, delegation, eval, browser, images, discovery, cache warming,
compaction, services and async jobs are excluded. Other file formats, internal
URL handlers, PTY isolation, real authentication, live providers and all auxiliary SDK
entry points remain unproven. This is source-validation tooling only; managed
OMP stays disabled. The owner wires accepted coverage into CI separately.
Leave #29 and #147 open for the adapter, common contract and remaining controls.
