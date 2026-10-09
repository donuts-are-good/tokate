package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Text.Json.Nodes

internal class DonorSelectionChecks {
    shared {
        private func Set(
            flow NativeFixture,
            model string = "gpt-6.1-sol",
            effort string = "high",
            harness string = "codex",
            provider string = "openai",
            profile string = ""
        ) {
            let args = List[string]{
                "defaults",
                "set",
                "--harness",
                harness,
                "--provider",
                provider,
                "--model",
                model,
                "--effort",
                effort
            }
            if profile != "" {
                args.AddRange([]string{"--profile", profile})
            }
            flow.Call(args.ToArray())
        }

        private func Select(flow NativeFixture, extra[]string, code int32 = 0) JsonNode {
            let args = List[string]{"select", "--repo", "owner/project", "--non-interactive"}
            args.AddRange(extra)
            let result = flow.Call(args.ToArray(), code)
            flow.NoInference()
            if code != 0 {
                Check.Contains(result.Error, "No inference started")
                return Check.Map("error", result.Error)
            }
            return Check.Json(result.Output)
        }

        private func Settings(flow NativeFixture) string -> Path.Combine(
            flow.Temp.Env["HOME"],
            ".local/state/tokate/donor-defaults.json"
        )

        private func ExpandPolicy(flow NativeFixture, alternative bool = false) {
            let path = Path.Combine(flow.Upstream, ".github/tokate.json")
            let policy = Check.Json(File.ReadAllText(path))
            policy["models"] = Check.Json(
                alternative ?
                "{\"gpt-6.1-sol\":[\"high\",\"xhigh\",\"minimal\"],\"gpt-6-sol\":[\"high\"]}":
                "{\"gpt-6.1-sol\":[\"high\",\"xhigh\",\"minimal\"]}"
            )
            File.WriteAllText(path, policy.ToJsonString())
            flow.Commit("Selection fixture policy")
            flow.Git("-C", Path.Combine(flow.Bin, "fork"), "fetch", flow.Upstream, "main")
        }

        private func LocalSettings(binary string) {
            using let flow = NativeFixture(binary)
            flow.Temp.Env["PATH"] = "/empty"
            let read = flow.Call([]string{"defaults", "read"})
            Check.That(Check.Json(read.Output)["default"] == nil, "Missing defaults were fabricated")
            Set(flow)
            let path = Settings(flow)
            let value = Check.Json(File.ReadAllText(path)).AsObject()
            Check.That(value.Count == 4, "Settings contain imported data")
            Check.That(
                File.GetUnixFileMode(path) == (UnixFileMode.UserRead | UnixFileMode.UserWrite),
                "Settings permissions are not private"
            )
            Check.That(read.Error == "", "Defaults require harness prerequisites")
            Check.Contains(flow.Call([]string{"defaults", "read"}).Output, "gpt-6.1-sol")
            flow.Call([]string{"defaults", "remove"})
            Check.That(!File.Exists(path), "Defaults were not removed")
            let named = Path.Combine(flow.Temp.Env["HOME"], ".local/state/tokate/donor-profiles/local.json")
            let privateRoot = Path.Combine(flow.Temp.Root, "private-runtime", "node_modules")
            let privateNode = Path.Combine(flow.Temp.Root, "private-runtime", "node")
            let pi = flow.Call(
                []string{
                    "defaults",
                    "set",
                    "--profile",
                    "local",
                    "--harness",
                    "pi",
                    "--provider",
                    "local-chat-completions",
                    "--model",
                    "synthetic/model:exact",
                    "--effort",
                    "absent",
                    "--endpoint",
                    "http://127.0.0.1:12345/v1",
                    "--pi-root",
                    privateRoot,
                    "--node",
                    privateNode
                }
            )
            let stored = Check.Json(File.ReadAllText(named)).AsObject()
            Check.That(
                stored.Count == 7 && Check.Text(stored["pi-root"]) == privateRoot && Check.Text(
                    stored["node"]
                ) == privateNode,
                "Pi profile dropped explicit private overrides"
            )
            Check.That(
                File.GetUnixFileMode(named) == (UnixFileMode.UserRead | UnixFileMode.UserWrite) && File.GetUnixFileMode(
                    Path.GetDirectoryName(named) ?? ""
                ) ==
                (UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute),
                "Named profile permissions are not private"
            )
            for output in[]string{
                pi.Output,
                flow.Call([]string{"defaults", "read", "--profile", "local"}).Output,
                flow.Call([]string{"defaults", "list"}).Output
            } {
                Check.Contains(output, "synthetic/model:exact")
                Check.That(
                    !output.Contains("127.0.0.1") && !output.Contains(privateRoot) && !output.Contains(privateNode),
                    "Public profile output exposed private settings"
                )
            }
            for invalid in[]string{"../escape", ".", "x/y", "bad name"} {
                flow.Call([]string{"defaults", "read", "--profile", invalid}, 1)
            }
            flow.Call([]string{"defaults", "read", "--profile", "missing"}, 1)
            let original = File.ReadAllText(named)
            for invalid in[]string{
                "{\"harness\":\"pi\",\"credentials\":\"synthetic-private-account-data\"}",
                "{\"harness\":\"pi\",\"harness\":\"codex\"}",
                String('x', 16385)
            } {
                File.WriteAllText(named, invalid)
                flow.Call([]string{"defaults", "read", "--profile", "local"}, 1)
            }
            File.WriteAllText(named, original)
            flow.Call([]string{"defaults", "remove", "--profile", "local"})
            Check.That(!File.Exists(named), "Named profile was not removed")
            flow.Call([]string{"defaults", "set", "--profile", "codex-only", "--harness", "codex"})
            flow.Call(
                []string{
                    "defaults",
                    "set",
                    "--profile",
                    "pi-only",
                    "--harness",
                    "pi",
                    "--endpoint",
                    "http://127.0.0.1:12345/v1"
                }
            )
            flow.Call(
                []string{"defaults", "set", "--profile", "pi-only", "--model", "local/model", "--effort", "absent"}
            )
            Check.That(
                Check.Text(
                    Check.Json(flow.Call([]string{"defaults", "read", "--profile", "pi-only"}).Output)["default"]?[
                        "harness"
                    ]
                ) == "pi",
                "Adding model settings changed the profile harness"
            )
            flow.Call([]string{"defaults", "use", "--profile", "codex-only"})
            Check.That(
                Check.Text(
                    Check.Json(flow.Call([]string{"defaults", "read"}).Output)["default"]?["harness"]
                ) == "codex",
                "Named Codex profile was not selected"
            )
            flow.Call([]string{"defaults", "use", "--profile", "pi-only"})
            Check.That(
                Check.Text(Check.Json(flow.Call([]string{"defaults", "read"}).Output)["default"]?["harness"]) == "pi",
                "Named Pi profile was not selected"
            )
            Check.That(
                Check.Text(
                    Check.Json(flow.Call([]string{"defaults", "read", "--profile", "codex-only"}).Output)["default"]?[
                        "harness"
                    ]
                ) == "codex",
                "Changing defaults overwrote another profile"
            )
            flow.Call([]string{"defaults", "use", "--profile", "missing"}, 1)
            flow.Call([]string{"defaults", "set", "--harness", "omp"})
            Check.That(
                Check.Text(Check.Json(flow.Call([]string{"defaults", "read"}).Output)["default"]?["provider"]) == "",
                "External harness default invented managed support"
            )
            flow.Call([]string{"defaults", "set", "--harness", "unknown"}, 1)
            flow.Call([]string{"defaults", "set", "--harness", "pi", "--provider", "openai"}, 1)
            flow.Call([]string{"defaults", "remove"})
            let privateFile = Path.Combine(flow.Temp.Root, "private-config")
            File.WriteAllText(privateFile, "synthetic-private-account-data")
            File.CreateSymbolicLink(path, privateFile)
            let refused = flow.Call([]string{"defaults", "read"}, 1)
            Check.Contains(refused.Error, "symbolic links")
            Check.That(!refused.Error.Contains("synthetic-private-account-data"), "Settings exposed a linked file")
            flow.Reload()
            Check.That(
                flow.State["discovery_count"] == nil && flow.State["api_calls"] == nil,
                "Local settings invoked discovery"
            )
        }

        private func Choices(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            ExpandPolicy(flow, true)
            Select(flow, []string{}, 1)
            Set(flow)
            let original = File.ReadAllText(Settings(flow))
            let chosen = Select(flow, []string{})
            Check.That(Check.Text(chosen["source"]) == "saved donor default", "Eligible default did not win")
            Check.That(Check.Text(chosen["availability"]) == "unknown", "Catalog presence proved availability")
            flow.Call([]string{"defaults", "set", "--harness", "codex"})
            Check.That(
                File.ReadAllText(Settings(flow)) == original,
                "Selecting the same harness erased its model settings"
            )
            let overridden = Select(
                flow,
                []string{"--model", "gpt-6.1-sol", "--effort", "xhigh", "--availability", "available"}
            )
            Check.That(Check.Text(overridden["effort"]) == "xhigh", "Explicit choice did not override saved choice")
            Check.That(
                Check.Text(overridden["availability"]) == "donor-reported available",
                "Availability provenance was lost"
            )
            Check.That(File.ReadAllText(Settings(flow)) == original, "Selection changed preferences")
            let partial = Select(flow, []string{"--effort", "xhigh"})
            Check.That(Check.Text(partial["effort"]) == "xhigh", "Explicit effort override was ignored")
            Select(flow, []string{"--availability", "unavailable"}, 1)
            Set(flow, model: "rejected")
            Select(flow, []string{}, 1)
            Set(flow, effort: "minimal")
            Select(flow, []string{}, 1)
            Select(flow, []string{"--model", "gpt-6.1-sol", "--effort", "minimal"}, 1)
            Set(flow, harness: "claude", provider: "anthropic")
            Select(flow, []string{}, 1)
            let explicitChoice = Select(flow, []string{"--model", "gpt-6.1-sol", "--effort", "high"})
            Check.That(Check.Text(explicitChoice["harness"]) == "codex", "Unsupported default changed harness")
            flow.Call(
                []string{
                    "select",
                    "--repo",
                    "owner/project",
                    "--harness",
                    "claude",
                    "--model",
                    "gpt-6.1-sol",
                    "--effort",
                    "high"
                },
                1
            )
            File.WriteAllText(Settings(flow), "{\"credentials\":\"synthetic-private-secret\"}")
            let invalid = Select(flow, []string{}, 1)
            Check.That(!invalid.ToJsonString().Contains("synthetic-private-secret"), "Invalid settings leaked contents")
            Select(flow, []string{"--model", "gpt-6.1-sol", "--effort", "high"})
            flow.Reload()
            Check.That(flow.State["login_count"] == nil, "Selection inspected private login state")
            flow.Mode("missing_controls")
            Check.Contains(
                flow.Call(
                    []string{"select", "--repo", "owner/project", "--model", "gpt-6.1-sol", "--effort", "high"},
                    1
                )
                    .Error,
                "required explicit controls"
            )
            flow.NoInference()
            flow.Mode("")
            let policyPath = Path.Combine(flow.Upstream, ".github/tokate.json")
            let policy = Check.Json(File.ReadAllText(policyPath))
            policy["models"] = Check.Json("{\"gpt-6.1-sol\":[\"minimal\"]}")
            File.WriteAllText(policyPath, policy.ToJsonString())
            flow.Commit("No compatible effort")
            Select(flow, []string{}, 1)
            flow.NoPr()
        }

        private func AuthorizedChoices(binary string) {
            for source in[]string{"explicit invocation", "saved donor default"} {
                using let flow = NativeFixture(binary)
                flow.Initialize()
                flow.Approve()
                let args = List[string]{
                    "claim",
                    "--repo",
                    "owner/project",
                    "--issue",
                    "1",
                    "--seconds",
                    "30",
                    "--runs",
                    Path.Combine(flow.Temp.Root, "runs"),
                    "--non-interactive"
                }
                if source == "saved donor default" {
                    Set(flow)
                } else {
                    args.AddRange([]string{"--model", "gpt-6.1-sol", "--effort", "high"})
                }
                let claimed = flow.Acquire(args.ToArray())
                let run = claimed.Output.Substring(claimed.Output.LastIndexOf("Run: ") + 5).Trim()
                flow.Mode("model_failure")
                let result = flow.Call([]string{"work", "--run", run}, 1)
                Check.That(result.Code == 1, "Synthetic model failure succeeded")
                Check.Contains(result.Error, "Codex failed")
                flow.Reload()
                Check.That(Check.Text(flow.State["exec_count"]) == "1", "Authorized choice required extra consent")
                Check.That(!result.Error.Contains("confirmation required"), "Authorized choice added a barrier")
                flow.NoPr()
            }
        }

        private func ConfirmationAndRuns(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.Approve()
            let custom = Path.Combine(flow.Temp.Root, "custom-codex")
            File.Move(Path.Combine(flow.Bin, "codex"), custom)
            flow.Call(
                []string{"defaults", "set", "--model", "gpt-6.1-sol", "--effort", "high", "--harness-path", custom}
            )
            let defaults = File.ReadAllText(Settings(flow))
            Check.Contains(defaults, custom)
            Check.That(
                !flow.Call([]string{"defaults", "read"}).Output.Contains(custom),
                "Public defaults exposed harness path"
            )
            let invalid = flow.Call(
                []string{"select", "--repo", "owner/project", "--harness-path", custom + "-missing", "--json"},
                1
            )
            Check.Envelope(invalid, "select", "error", "missing_tools")
            Check.That(File.ReadAllText(Settings(flow)) == defaults, "Invalid override changed saved defaults")
            let claimed = flow.Acquire(
                []string{
                    "claim",
                    "--repo",
                    "owner/project",
                    "--issue",
                    "1",
                    "--seconds",
                    "30",
                    "--runs",
                    Path.Combine(flow.Temp.Root, "runs")
                }
            )
            let run = claimed.Output.Substring(claimed.Output.LastIndexOf("Run: ") + 5).Trim()
            let path = Path.Combine(run, "run.json")
            let original = File.ReadAllText(path)
            Check.That(Check.Text(Check.Json(original)["harness_path"]) == custom, "Claim lost its custom harness path")
            Set(flow, effort: "xhigh")
            flow.Mode("capability_changed")
            Check.Contains(flow.Call([]string{"work", "--run", run}, 1).Error, "no longer compatible")
            flow.NoInference()
            Check.That(File.ReadAllText(path) == original, "Capability rejection changed saved work")
            flow.Mode("model_failure")
            flow.Call([]string{"work", "--run", run}, 1)
            flow.Reload()
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "Model failure retried or fell back")
            Check.That(
                Check.Text(Check.Json(File.ReadAllText(path))["state"]) == "failed",
                "Model failure did not stop"
            )
            let requested = flow.State["exec_args"]?.ToJsonString() ?? ""
            Check.Contains(requested, "high")
            Check.That(!requested.Contains("xhigh"), "Preferences substituted the saved effort")
            flow.Call([]string{"work", "--run", run}, 1)
            flow.Reload()
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "Failed run spent inference again")
            flow.NoPr()
        }

        private func MissingSelection(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.Approve()
            let run = flow.Claim()
            let path = Path.Combine(run, "run.json")
            let saved = Check.Json(File.ReadAllText(path))
            saved.AsObject().Remove("selection")
            saved.AsObject().Remove("harness")
            saved.AsObject().Remove("provider")
            File.WriteAllText(path, saved.ToJsonString())
            let original = File.ReadAllText(path)
            Check.Contains(flow.Call([]string{"work", "--run", run}, 1).Error, "require saved selection metadata")
            Check.That(File.ReadAllText(path) == original, "Invalid selection changed saved work")
            flow.NoInference()
        }

        private func InteractiveChoices(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            ExpandPolicy(flow)
            let command = "'" + binary + "' select --repo owner/project --plain"
            let result = TestProcess.Run(
                "/usr/bin/script",
                []string{"-q", "-e", "-c", command, "/dev/null"},
                flow.Temp.Env,
                "2\n"
            )
            Check.Success(result)
            Check.Contains(result.Output, "Model: gpt-6.1-sol\r\n")
            Check.Contains(result.Output, "Effort: xhigh\r\n")
            Check.Contains(result.Output, "Source: interactive donor choice\r\n")
            Check.That(!File.Exists(Settings(flow)), "Interactive choice saved preferences implicitly")
            let refused = TestProcess.Run(
                "/usr/bin/script",
                []string{"-q", "-e", "-c", command, "/dev/null"},
                flow.Temp.Env,
                "\n"
            )
            Check.That(refused.Code == 1, "Blank input accepted the first eligible pair")
            Check.Contains(refused.Output, "No inference started")
            let noninteractive = TestProcess.Run(
                "/usr/bin/script",
                []string{"-q", "-e", "-c", command + " --non-interactive", "/dev/null"},
                flow.Temp.Env,
                "1\n"
            )
            Check.That(noninteractive.Code == 1, "Noninteractive selection accepted terminal input")
            Check.Contains(noninteractive.Output, "Explicit donor choice required")
            flow.NoInference()
            flow.NoPr()
            flow.Approve()
            let work = "'" + binary + "' work --repo owner/project --issue 1 --runs '" + Path.Combine(
                flow.Temp.Root,
                "runs"
            ) +
                "' --harness codex --seconds 30 --plain"
            let declined = TestProcess.Run(
                "/usr/bin/script",
                []string{"-q", "-e", "-c", work, "/dev/null"},
                flow.Temp.Env,
                "1\nn\n"
            )
            Check.That(declined.Code == 1, "Declined confirmation launched work")
            Check.Contains(declined.Output, "Inference was not confirmed")
            flow.NoInference()
            flow.NoPr()
            flow.Mode("model_failure")
            let confirmed = TestProcess.Run(
                "/usr/bin/script",
                []string{"-q", "-e", "-c", work, "/dev/null"},
                flow.Temp.Env,
                "1\ny\n"
            )
            Check.That(confirmed.Code == 8, "Confirmed claim did not wait for owner coordination")
            Check.Contains(confirmed.Output, "Claim pending")
            flow.NoInference()
            flow.CoordinatePosted()
            let run = Directory.GetDirectories(Path.Combine(flow.Temp.Root, "runs"))[0]
            Check.Contains(flow.Call([]string{"work", "--run", run, "--yes"}, 1).Error, "Codex failed")
            flow.Reload()
            Check.That(
                Check.Text(flow.State["exec_count"]) == "1",
                "Confirmed terminal work retried or did not execute"
            )
            Check.That(
                Check.Text(flow.State["requested_model"]) == "gpt-6.1-sol" && Check.Text(
                    flow.State["requested_effort"]
                ) == "model_reasoning_effort=\"high\"",
                "Confirmation forwarded the wrong tuple"
            )
        }

        private func VersionTwo(binary string, unrestricted bool = false) {
            using let coordination = CoordinationFlow(binary)
            coordination.Initialize()
            if unrestricted {
                let path = Path.Combine(coordination.Flow.Upstream, ".github/tokate.json")
                let policy = Check.Json(File.ReadAllText(path))
                policy["model_policy"] = JsonValue.Create("unrestricted")
                policy.AsObject().Remove("models")
                File.WriteAllText(path, policy.ToJsonString())
                coordination.Flow.Commit("Unrestricted managed selection")
                coordination.Flow.Approve()
            }
            coordination.Claim()
            let flow = coordination.Flow
            Set(flow)
            let state = coordination.State()
            let args = List[string]{
                "prepare",
                "--repo",
                "owner/project",
                "--issue",
                "1",
                "--state",
                Check.Text(state["sha"]),
                "--source",
                "tokate",
                "--runs",
                Path.Combine(flow.Temp.Root, "runs"),
                "--non-interactive"
            }
            let declared = Path.Combine(flow.Temp.Root, "managed-tools.json")
            File.WriteAllText(
                declared,
                "[{\"harness\":\"codex\",\"provider\":\"openai\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\"}]"
            )
            let conflict = List[string](args)
            conflict.AddRange([]string{"--tools", declared, "--effort", "xhigh"})
            Check.Contains(flow.Call(conflict.ToArray(), 1).Error, "no model substitution")
            let prepared = flow.Call(args.ToArray())
            let run = prepared.Output.Substring(prepared.Output.LastIndexOf("Run: ") + 5).Trim()
            let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
            Check.That(
                Check.Text(saved["selection"]?["source"]) == "saved donor default",
                "V2 preparation did not use default"
            )
            Check.That(saved["tools"]?.AsArray().Count == 1, "V2 default invented tool declarations")
            flow.Mode("model_failure")
            let result = TestProcess.Run(binary, []string{"work", "--run", run, "--non-interactive"}, flow.Temp.Env)
            Check.That(result.Code == 1, "Synthetic model failure succeeded")
            Check.Contains(result.Error, "Codex failed")
            flow.Reload()
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "V2 saved default required extra consent")
            flow.NoPr()
            let policyPath = Path.Combine(flow.Upstream, ".github/tokate.json")
            let policy = Check.Json(File.ReadAllText(policyPath))
            policy["allowed_tools"] = Check.Json("[{\"harness\":\"claude\",\"provider\":\"anthropic\"}]")
            File.WriteAllText(policyPath, policy.ToJsonString())
            flow.Commit("Owner rejects managed provider")
            Check.Contains(
                flow.Call([]string{"select", "--repo", "owner/project", "--non-interactive"}, 1).Error,
                "exact owner tool restrictions"
            )
            flow.Reload()
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "Rejected tool policy spent extra inference")
        }

        private func ModelPolicy(binary string) {
            for omitted in[]bool{true, false} {
                using let flow = NativeFixture(binary)
                flow.Initialize()
                let path = Path.Combine(flow.Upstream, ".github/tokate.json")
                let policy = Check.Json(File.ReadAllText(path))
                policy["model_policy"] = JsonValue.Create("unrestricted")
                if omitted {
                    policy.AsObject().Remove("models")
                } else {
                    policy["models"] = Check.Map()
                }
                File.WriteAllText(path, policy.ToJsonString())
                flow.Commit("Unrestricted model policy")
                Select(flow, []string{}, 1)
                let explicitChoice = Select(flow, []string{"--model", "gpt-6.1-sol", "--effort", "xhigh"})
                Check.That(Check.Text(explicitChoice["effort"]) == "xhigh", "Unrestricted explicit effort changed")
                Set(flow)
                let saved = Select(flow, []string{})
                Check.That(Check.Text(saved["source"]) == "saved donor default", "Unrestricted default rejected")
                Select(flow, []string{"--effort", "xhigh"})
                let unavailable = Select(flow, []string{"--availability", "unavailable"}, 1)
                Check.Contains(Check.Text(unavailable["error"]), "donor-reported unavailable")
                let unsupported = Select(flow, []string{"--model", "outside-catalog", "--effort", "high"}, 1)
                Check.Contains(Check.Text(unsupported["error"]), "offline native Codex catalog")
                for effort in[]string{"absent", "unknown"} {
                    let settings = Check.Json(File.ReadAllText(Settings(flow)))
                    settings["effort"] = JsonValue.Create(effort)
                    File.WriteAllText(Settings(flow), settings.ToJsonString())
                    let rejected = Select(flow, []string{}, 1)
                    Check.Contains(Check.Text(rejected["error"]), "known model")
                }
                flow.Call([]string{"defaults", "remove"})
                let command = "'" + binary + "' select --repo owner/project --plain"
                let chosen = TestProcess.Run(
                    "/usr/bin/script",
                    []string{"-q", "-e", "-c", command, "/dev/null"},
                    flow.Temp.Env,
                    "1\n"
                )
                Check.Success(chosen)
                Check.Contains(chosen.Output, "Model: gpt-6-sol\r\n")
                Check.Contains(chosen.Output, "Effort: high\r\n")
                Check.Contains(chosen.Output, "Source: interactive donor choice\r\n")
                let cancelled = TestProcess.Run(
                    "/usr/bin/script",
                    []string{"-q", "-e", "-c", command, "/dev/null"},
                    flow.Temp.Env,
                    "\n"
                )
                Check.That(cancelled.Code == 1, "Unrestricted terminal selection chose a fallback")
                flow.NoInference()
                flow.NoPr()
            }
            VersionTwo(binary, unrestricted: true)
        }

        private func Structured(binary string) {
            using let flow = NativeFixture(binary)
            let path = flow.Temp.Env["PATH"]
            flow.Temp.Env["PATH"] = "/empty"
            let missing = Check.Envelope(flow.Call([]string{"defaults", "read", "--json"}), "defaults", "ok")
            Check.That(missing["data"]?["default"] == nil, "Missing JSON defaults fabricated")
            let saved = Check.Envelope(
                flow.Call([]string{"defaults", "set", "--model", "gpt-6.1-sol", "--effort", "high", "--json"}),
                "defaults",
                "ok"
            )
            Check.That(
                Check.Text(saved["data"]?["default"]?["harness"]) == "codex" && Check.Text(
                    saved["data"]?["default"]?["provider"]
                ) == "openai" &&
                    Check.Text(saved["data"]?["default"]?["model"]) == "gpt-6.1-sol" && Check.Text(
                    saved["data"]?["default"]?["effort"]
                ) == "high",
                "Shorthand JSON defaults dropped the Codex tuple"
            )
            for pair in[][]string{
                []string{"--harness=codex", "codex", "openai"},
                []string{"--provider=openai", "codex", "openai"},
                []string{"--harness=pi", "pi", "local-chat-completions"},
                []string{"--provider=local-chat-completions", "pi", "local-chat-completions"}
            } {
                let args = List[string]{
                    "defaults",
                    "set",
                    "--profile=inferred",
                    pair[0],
                    "--model=gpt-6.1-sol",
                    pair[1] == "pi" ? "--effort=absent": "--effort=high",
                    "--json"
                }
                if pair[1] == "pi" {
                    args.Add("--endpoint=http://127.0.0.1:12345/v1")
                }
                let inferred = flow.Call(args.ToArray())
                let choice = Check.Envelope(inferred, "defaults", "ok")["data"]?["default"]
                Check.That(
                    Check.Text(choice?["harness"]) == pair[1] && Check.Text(choice?["provider"]) == pair[2],
                    "Defaults did not infer the missing known counterpart"
                )
                Check.That(!inferred.Output.Contains("127.0.0.1"), "Inferred Pi defaults exposed the endpoint")
            }
            let explicitPair = Check
                .Envelope(
                flow.Call(
                    []string{
                        "defaults",
                        "set",
                        "--profile=explicit",
                        "--harness=codex",
                        "--provider=local-chat-completions",
                        "--model=gpt-6.1-sol",
                        "--effort=high",
                        "--json"
                    }
                ),
                "defaults",
                "ok"
            )["data"]?["default"]
            Check.That(
                Check.Text(explicitPair?["harness"]) == "codex" && Check.Text(
                    explicitPair?["provider"]
                ) == "local-chat-completions",
                "Defaults replaced an explicit harness/provider pair"
            )
            let original = File.ReadAllText(Settings(flow))
            for rejected in[][]string{
                []string{"--harness=claude", "--model=gpt-6.1-sol", "--effort=high"},
                []string{"--provider=anthropic", "--model=gpt-6.1-sol", "--effort=high"},
                []string{"--harness=pi", "--model=gpt-6.1-sol", "--effort=absent"},
                []string{
                    "--harness=codex",
                    "--provider=local-chat-completions",
                    "--model=gpt-6.1-sol",
                    "--effort=high",
                    "--endpoint=http://127.0.0.1:12345/v1"
                }
            } {
                let args = List[string]{"defaults", "set", "--json"}
                args.AddRange(rejected)
                flow.Call(args.ToArray(), 1)
                Check.That(File.ReadAllText(Settings(flow)) == original, "Rejected defaults changed saved preferences")
            }
            flow.Temp.Env["PATH"] = path
            flow.Initialize()
            ExpandPolicy(flow)
            Set(flow, profile: "cloud")
            let profilePath = Path.Combine(flow.Temp.Env["HOME"], ".local/state/tokate/donor-profiles/cloud.json")
            let originalProfile = File.ReadAllText(profilePath)
            let profiled = Check.Envelope(
                flow.Call([]string{"select", "--repo", "owner/project", "--profile", "cloud", "--json"}),
                "select",
                "ok"
            )
            Check.That(
                Check.Text(profiled["data"]?["source"]) == "saved donor profile cloud",
                "Named selection lost its source"
            )
            let overridden = Check.Envelope(
                flow.Call(
                    []string{"select", "--repo", "owner/project", "--profile", "cloud", "--effort", "xhigh", "--json"}
                ),
                "select",
                "ok"
            )
            Check.That(
                Check.Text(overridden["data"]?["effort"]) == "xhigh" && Check.Text(overridden["data"]?["source"]) ==
                "saved donor profile cloud with explicit overrides" && File.ReadAllText(profilePath) == originalProfile,
                "Named profile override changed saved preferences or source"
            )
            flow.Reload()
            let calls = flow.State["api_calls"]?.DeepClone()
            for rejected in[]string{"--profile=missing", "--harness=pi", "--provider=local-chat-completions"} {
                let args = List[string]{"select", "--repo", "owner/project", "--json"}
                if rejected != "--profile=missing" {
                    args.AddRange([]string{"--profile", "cloud"})
                }
                args.Add(rejected)
                Check.Envelope(flow.Call(args.ToArray(), 1), "select", "error", "command_failed")
            }
            flow.Reload()
            Check.That(JsonNode.DeepEquals(calls, flow.State["api_calls"]), "Rejected profile reached GitHub")
            for args in[][]string{
                []string{"work", "--run", "unused", "--profile", "cloud", "--json"},
                []string{
                    "prepare",
                    "--repo",
                    "owner/project",
                    "--issue",
                    "1",
                    "--state",
                    String('a', 40),
                    "--source",
                    "external",
                    "--tools",
                    "unused",
                    "--profile",
                    "cloud",
                    "--json"
                }
            } {
                Check.Envelope(flow.Call(args, 1), args[0], "error", "invalid_arguments")
            }
            for availability in[]string{"unknown", "available"} {
                let selected = Check.Envelope(
                    flow.Call([]string{"select", "--repo", "owner/project", "--availability", availability, "--json"}),
                    "select",
                    "ok"
                )
                Check.That(
                    Check.Text(selected["data"]?["model"]) == "gpt-6.1-sol" && Check.Text(
                        selected["data"]?["policy_eligible"]
                    ) == "true",
                    "JSON selection dropped evidence"
                )
            }
            Check.Envelope(
                flow.Call(
                    []string{
                        "select",
                        "--repo",
                        "owner/project",
                        "--model",
                        "gpt-6.1-sol",
                        "--effort",
                        "high",
                        "--availability",
                        "unavailable",
                        "--json"
                    },
                    1
                ),
                "select",
                "error",
                "command_failed"
            )
            let removed = Check.Envelope(flow.Call([]string{"defaults", "remove", "--json"}), "defaults", "ok")
            Check.That(Check.Text(removed["data"]?["removed"]) == "true", "JSON defaults removal missing")
            let command = "'" + binary + "' select --repo owner/project --json 2> '" + Path.Combine(
                flow.Temp.Root,
                "diagnostics"
            ) +
                "'"
            let terminal = TestProcess.Run(
                "/usr/bin/script",
                []string{"-q", "-e", "-c", command, "/dev/null"},
                flow.Temp.Env
            )
            Check.Envelope(terminal, "select", "error", "command_failed")
            Check.That(!terminal.Output.Contains("Choice number"), "JSON terminal selection prompted")
            flow.NoInference()
        }

        private func StateLocation(binary string) {
            using let temp = Temp()
            temp.Env["PATH"] = "/empty"
            for profile in[]string{"", "shared"} {
                let args = List[string]{"defaults", "set", "--model", "gpt-6.1-sol", "--effort", "high"}
                if profile != "" {
                    args.AddRange([]string{"--profile", profile})
                }
                CliDiscovery.Call(binary, args.ToArray(), temp)
            }
            let previous = Path.Combine(temp.Env["HOME"], ".local/state/tokate")
            let oldHash = Check.Hash(Path.Combine(previous, "donor-defaults.json"))
            let stateHome = Path.Combine(temp.Root, "new state")
            temp.Env["XDG_STATE_HOME"] = stateHome
            Check.Contains(
                CliDiscovery.Call(binary, []string{"defaults", "read", "--profile", "shared"}, temp).Output,
                "high"
            )
            for profile in[]string{"", "shared"} {
                let args = List[string]{"defaults", "set", "--model", "gpt-6.1-sol", "--effort", "xhigh"}
                if profile != "" {
                    args.AddRange([]string{"--profile", profile})
                }
                CliDiscovery.Call(binary, args.ToArray(), temp)
            }
            let current = Path.Combine(stateHome, "tokate")
            Check.That(File.Exists(Path.Combine(current, "donor-defaults.json")), "State override was ignored")
            Check.That(
                Check.Hash(Path.Combine(previous, "donor-defaults.json")) == oldHash,
                "Old defaults were migrated"
            )
            let listed = Check.Json(CliDiscovery.Call(binary, []string{"defaults", "list"}, temp).Output)
            Check.That(listed["profiles"]?.AsObject().Count == 1, "Duplicate profile names were listed")
            Check.That(
                Check.Text(listed["profiles"]?["shared"]?["effort"]) == "xhigh",
                "Old profile overrode current choice"
            )
            for invalid in[]string{"", "relative-state"} {
                temp.Env["XDG_STATE_HOME"] = invalid
                let read = Check.Json(CliDiscovery.Call(binary, []string{"defaults", "read"}, temp).Output)
                Check.That(
                    Check.Text(read["default"]?["effort"]) == "high",
                    "Empty or relative state override changed lookup"
                )
            }
            temp.Env["XDG_STATE_HOME"] = stateHome
            CliDiscovery.Call(binary, []string{"defaults", "remove", "--profile", "shared"}, temp)
            Check.That(
                !File.Exists(Path.Combine(current, "donor-profiles/shared.json")) && !File.Exists(
                    Path.Combine(previous, "donor-profiles/shared.json")
                ),
                "Removed profile reappeared from previous storage"
            )
            let path = Path.Combine(current, "donor-defaults.json")
            File.Delete(path)
            File.CreateSymbolicLink(path, Path.Combine(previous, "donor-defaults.json"))
            CliDiscovery.Call(binary, []string{"defaults", "read"}, temp, 1)
            Check.That(
                Check.Hash(Path.Combine(previous, "donor-defaults.json")) == oldHash,
                "Linked defaults were changed"
            )
            Console.WriteLine(
                "PASS state directory override, previous profile lookup, precedence, explicit removal and link refusal"
            )
        }

        internal func All(binary string, selected string = "") {
            if selected != "" {
                if selected == "StateLocation" {
                    StateLocation(binary)
                } else if selected == "Structured" {
                    Structured(binary)
                    Console.WriteLine(
                        "PASS structured defaults/selection, availability and terminal no-prompt contract"
                    )
                } else if selected == "ModelPolicy" {
                    ModelPolicy(binary)
                    Console.WriteLine(
                        "PASS unrestricted explicit/default/terminal selection, known controls and no fallback"
                    )
                } else if selected == "InteractiveChoices" {
                    InteractiveChoices(binary)
                    Console.WriteLine("PASS actual terminal selection and confirmation; zero inference before consent")
                } else {
                    throw Exception("Unknown selection test group")
                }
                return
            }

            Structured(binary)
            StateLocation(binary)
            Console.WriteLine("PASS structured defaults/selection, availability and terminal no-prompt contract")
            LocalSettings(binary)
            Console.WriteLine("PASS donor defaults set/read/remove and nonsecret storage")
            Choices(binary)
            Console.WriteLine("PASS default/override/refusal, capabilities and availability; zero inference")
            AuthorizedChoices(binary)
            Console.WriteLine("PASS explicit and saved default work without repeated confirmation")
            ConfirmationAndRuns(binary)
            Console.WriteLine("PASS pinned runs, capability revalidation and no model fallback")
            MissingSelection(binary)
            Console.WriteLine("PASS missing saved selection is refused before inference")
            InteractiveChoices(binary)
            Console.WriteLine("PASS actual terminal selection and confirmation; zero inference before consent")
            VersionTwo(binary)
            ModelPolicy(binary)
            Console.WriteLine("PASS unrestricted explicit/default/terminal selection, known controls and no fallback")
            Console.WriteLine("PASS V2 authorized defaults, exact tool policy and declaration conflicts")
        }
    }
}
