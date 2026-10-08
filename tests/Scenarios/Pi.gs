package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Text.Json.Nodes

internal class PiChecks {
    shared {
        internal func Runtime(binary string, sdk string = "") {
            using let test = CoordinationFixture(binary)
            using let catalog = PiCatalog()
            test.Initialize(approve: false)
            let flow = test.Flow
            let policyPath = Path.Combine(flow.Upstream, ".github/tokate.json")
            let policy = Check.Json(File.ReadAllText(policyPath))
            policy["model_policy"] = JsonValue.Create("whitelist")
            policy["models"] = Check.Json("{\"fixture-model\":[\"absent\"]}")
            policy["allowed_tools"] = Check.Json("[{\"harness\":\"pi\",\"provider\":\"local-chat-completions\"}]")
            File.WriteAllText(policyPath, policy.ToJsonString())
            flow.Commit("Pi runtime selection fixture")
            let agent = Path.Combine(flow.Temp.Root, "agent")
            let launcher = Path.Combine(agent, "bin/pi")
            let root = Path.Combine(agent, "install/releases/1.1.0/node_modules")
            let installed = Path.Combine(root, "@earendil-works/pi-coding-agent")
            Directory.CreateDirectory(Path.Combine(installed, "dist/bundle"))
            Directory.CreateDirectory(Path.GetDirectoryName(launcher) ?? "")
            File.WriteAllText(launcher, "#!/bin/sh\nexit 77\n")
            File.SetUnixFileMode(launcher, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
            File.CreateSymbolicLink(Path.Combine(flow.Bin, "pi"), launcher)
            if sdk == "" {
                File.WriteAllText(
                    Path.Combine(installed, "package.json"),
                    "{\"name\":\"@earendil-works/pi-coding-agent\",\"version\":\"fixture-runtime\",\"type\":\"module\"}"
                )
                File.WriteAllText(
                    Path.Combine(installed, "dist/index.js"),
                    NativeFixture.Template("PiContinuation.mjs")
                )
                File.WriteAllText(
                    Path.Combine(installed, "dist/bundle/cli.js"),
                    "throw Error('launcher must not run');\n"
                )
            } else {
                Check.Success(
                    TestProcess.Run(
                        "/usr/bin/cp",
                        []string{"-a", "--reflink=auto", "--", Path.GetFullPath(sdk) + "/.", root},
                        flow.Temp.Env
                    )
                )
            }
            let versionPath = Path.Combine(agent, "install/current-version")
            File.WriteAllText(versionPath, "1.1.0\n")
            let markerPath = Path.Combine(agent, "install/managed-install.json")
            let marker = Check.Map(
                "kind",
                "pi-managed-install",
                "schemaVersion",
                1,
                "layout",
                "releases-v1",
                "entrypoint",
                Check.Map("type", "symlink", "path", Path.Combine(flow.Bin, "pi"))
            )
            File.WriteAllText(markerPath, marker.ToJsonString())
            flow.Temp.Env["PI_CODING_AGENT_DIR"] = agent
            File.WriteAllText(
                Path.Combine(agent, "models.json"),
                "{\"providers\":{\"local\":{\"baseUrl\":\"" +
                    catalog.Endpoint +
                    "\",\"api\":\"openai-completions\",\"models\":[{\"id\":\"fixture-model\",\"reasoning\":false,\"contextWindow\":32768,\"maxTokens\":4096}]}}}"
            )
            let data = Path.Combine(flow.Temp.Root, "data")
            flow.Temp.Env["XDG_DATA_HOME"] = data
            let node = Path.Combine(data, "pi-node/current/bin/node")
            Directory.CreateDirectory(Path.GetDirectoryName(node) ?? "")
            let actualNode = TestProcess.Node()
            File.Copy(actualNode, node)
            let pathNode = Path.Combine(flow.Bin, "node")
            File.WriteAllText(pathNode, "#!/bin/sh\nexit 88\n")
            File.SetUnixFileMode(pathNode, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
            let args = List[string]{
                "select",
                "--repo",
                "owner/project",
                "--harness",
                "pi",
                "--provider",
                "local-chat-completions",
                "--model",
                "fixture-model",
                "--effort",
                "absent",
                "--endpoint",
                catalog.Endpoint,
                "--non-interactive"
            }
            let explicitSelection = Check.Json(flow.Call(args.ToArray()).Output)
            let providerIndex = args.IndexOf("--provider")
            args.RemoveRange(providerIndex, 2)
            let inferredSelection = Check.Json(flow.Call(args.ToArray()).Output)
            Check.That(
                JsonNode.DeepEquals(explicitSelection, inferredSelection),
                "Omitted Pi provider changed the explicit selection"
            )
            args.AddRange([]string{"--provider", "openai"})
            Check.Contains(flow.Call(args.ToArray(), 1).Error, "Unsupported pi provider")
            args.RemoveRange(args.Count - 2, 2)
            flow.Call(
                []string{
                    "defaults",
                    "set",
                    "--profile",
                    "local",
                    "--harness",
                    "pi",
                    "--model",
                    "fixture-model",
                    "--effort",
                    "absent",
                    "--endpoint",
                    catalog.Endpoint
                }
            )
            let profiled = Check.Json(
                flow.Call([]string{"select", "--repo", "owner/project", "--profile", "local", "--non-interactive"})
                    .Output
            )
            let expectedProfile = explicitSelection.DeepClone()
            expectedProfile["source"] = JsonValue.Create("saved donor profile local")
            Check.That(JsonNode.DeepEquals(expectedProfile, profiled), "Saved Pi profile lost selection precedence")
            args.AddRange([]string{"--profile", "local", "--provider", "openai"})
            Check.Contains(flow.Call(args.ToArray(), 1).Error, "Named donor profile conflicts")
            args.RemoveRange(args.Count - 4, 4)
            args.AddRange([]string{"--node", pathNode})
            flow.Call(args.ToArray(), 1)
            args[args.Count - 1] = actualNode
            Check.Contains(flow.Call(args.ToArray()).Output, "advertised")
            args.RemoveRange(args.Count - 2, 2)
            for version in[]string{"../escape\n", ".\n", "1.1.0\nother\n"} {
                File.WriteAllText(versionPath, version)
                flow.Call(args.ToArray(), 1)
            }
            File.WriteAllText(versionPath, "1.1.0\n")
            marker["layout"] = JsonValue.Create("unknown")
            File.WriteAllText(markerPath, marker.ToJsonString())
            flow.Call(args.ToArray(), 1)
            marker["layout"] = JsonValue.Create("releases-v1")
            File.WriteAllText(markerPath, marker.ToJsonString())
            File.Delete(node)
            File.Copy(actualNode, pathNode, true)
            Check.Contains(flow.Call(args.ToArray()).Output, "advertised")
            File.Delete(Path.Combine(flow.Bin, "pi"))
            File.CreateSymbolicLink(Path.Combine(flow.Bin, "pi"), Path.Combine(installed, "dist/bundle/cli.js"))
            File.SetUnixFileMode(
                Path.Combine(installed, "dist/bundle/cli.js"),
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            Check.Contains(flow.Call(args.ToArray()).Output, "advertised")
            File.Delete(Path.Combine(flow.Bin, "pi"))
            File.WriteAllText(Path.Combine(flow.Bin, "pi"), "#!/bin/sh\nexit 77\n")
            File.SetUnixFileMode(
                Path.Combine(flow.Bin, "pi"),
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            let npm = Path.Combine(flow.Bin, "npm")
            File.WriteAllText(
                npm,
                "#!/bin/sh\n[ \"$$1\" = root ] && [ \"$$2\" = --global ] || exit 78\nprintf '%s\\n' '" + root + "'\n"
            )
            File.SetUnixFileMode(npm, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
            Check.Contains(flow.Call(args.ToArray()).Output, "advertised")
            File.WriteAllText(npm, "#!/bin/sh\nexit 79\n")
            Check.Contains(flow.Call(args.ToArray(), 1).Error, "Cannot locate the Pi SDK")
            flow.NoInference()
            flow.NoPr()
            Check.That(flow.State["posted_request"] == nil, "Pi selection posted a claim request")
            Console.WriteLine(
                "PASS Pi provider inference, profile precedence, conflict refusal and runtime discovery without claims or inference"
            )
        }

        internal func Run(binary string, root string, node string, directory string, endpoint string, mode string) {
            let flow = CoordinationFixture(binary)
            let catalogRejected = mode.StartsWith("catalog-") && mode != "catalog-metadata" && !mode.StartsWith(
                "catalog-recheck-"
            )
            let interrupted = mode == "cancel" || mode == "length-cancel"
            let continuation = mode == "continued" ||
                mode == "repeated" ||
                mode == "identity" ||
                mode == "usage" ||
                mode == "length-cancel" ||
                mode == "length-timeout"
            using let cleanup = interrupted ? nil: flow
            flow.Initialize(approve: false)
            let policyPath = Path.Combine(flow.Flow.Upstream, ".github/tokate.json")
            let policy = Check.Json(File.ReadAllText(policyPath))
            policy["model_policy"] = JsonValue.Create("whitelist")
            policy["models"] = Check.Json("{\"synthetic/model:exact\":[\"absent\",\"minimal\",\"high\",\"xhigh\"]}")
            policy["allowed_tools"] = Check.Json("[{\"harness\":\"pi\",\"provider\":\"local-chat-completions\"}]")
            policy["allow_network"] = JsonValue.Create(true)
            policy["verification"] = Check.Json("[[\"/bin/sh\",\"-c\",\"test \\\"$$(cat result.txt)\\\" = final\"]]")
            File.WriteAllText(policyPath, policy.ToJsonString())
            let custom = Path.Combine(flow.Flow.Upstream, ".pi")
            Directory.CreateDirectory(Path.Combine(custom, "extensions"))
            File.WriteAllText(Path.Combine(custom, "SYSTEM.md"), "HOSTILE_CONTEXT_SENTINEL")
            File.WriteAllText(
                Path.Combine(custom, "settings.json"),
                "{\"extensions\":[\"./extensions/hostile.js\"],\"retry\":{\"enabled\":true}}"
            )
            File.WriteAllText(
                Path.Combine(custom, "extensions/hostile.js"),
                "throw new Error('HOSTILE_EXTENSION_LOADED');"
            )
            flow.Flow.Commit("Pi policy and untrusted customization fixture")
            flow.Flow.Approve()
            if !catalogRejected {
                flow.Claim()
            }
            let agentDir = Path.Combine(flow.Flow.Temp.Root, "pi-agent")
            Directory.CreateDirectory(agentDir)
            flow.Flow.Temp.Env["PI_CODING_AGENT_DIR"] = agentDir
            let models = Check.Json(
                "{\"providers\":{\"synthetic\":{\"api\":\"openai-completions\",\"authHeader\":false,\"apiKey\":\"PRIVATE_CREDENTIAL_SENTINEL\",\"models\":[{\"id\":\"synthetic/model:exact\",\"name\":\"Synthetic\",\"contextWindow\":65536,\"maxTokens\":4096,\"reasoning\":false,\"input\":[\"text\"]}]}}}"
            )
            let provider = models["providers"]?["synthetic"] ?? throw Exception("Missing synthetic provider")
            provider["baseUrl"] = JsonValue.Create(endpoint)
            if mode == "reasoning" {
                let model = provider["models"]?[0] ?? throw Exception("Missing reasoning model")
                model["reasoning"] = JsonValue.Create(true)
                model["thinkingLevelMap"] = Check.Json("{\"minimal\":null,\"high\":\"medium\",\"xhigh\":null}")
                model["compat"] = Check.Json("{\"thinkingFormat\":\"openai\",\"supportsReasoningEffort\":true}")
            }
            let modelsPath = Path.Combine(agentDir, "models.json")
            File.WriteAllText(modelsPath, models.ToJsonString())
            File.CreateSymbolicLink(
                Path.Combine(flow.Flow.Bin, "pi"),
                Path.Combine(root, "@earendil-works/pi-coding-agent/dist/bundle/cli.js")
            )
            let args = List[string]{
                "prepare",
                "--repo",
                "owner/project",
                "--issue",
                "1",
                "--state",
                Check.Text(flow.State()["sha"]),
                "--source",
                "tokate",
                "--harness",
                "pi",
                "--provider",
                "local-chat-completions",
                "--model",
                "synthetic/model:exact",
                "--effort",
                mode == "reasoning" ? "high": "absent",
                "--node",
                node,
                "--endpoint",
                endpoint,
                "--seconds",
                mode == "length-timeout" ? "20": "90",
                "--verification-reserve",
                mode == "length-timeout" ? "5": "30",
                "--runs",
                Path.Combine(flow.Flow.Temp.Root, "runs"),
                "--non-interactive"
            }
            if mode == "on" {
                args.Add("--allow-network")
            }
            if mode != "off" {
                args.AddRange([]string{"--pi-root", root})
            }
            if catalogRejected {
                args[0] = "claim"
                for option in[]string{"--state", "--source"} {
                    let position = args.IndexOf(option)
                    args.RemoveAt(position + 1)
                    args.RemoveAt(position)
                }
                args.Add("--json")
                let rejected = flow.Flow.Call(args.ToArray(), 1)
                Check.Envelope(rejected, "claim", "error", "endpoint_unavailable")
                PrivateCatalog(rejected.Output + rejected.Error, endpoint)
                flow.Flow.Reload()
                Check.That(flow.Flow.State["posted_request"] == nil, "Unavailable model posted a claim request")
                Check.That(
                    !Directory.Exists(Path.Combine(flow.Flow.Temp.Root, "runs")),
                    "Unavailable model created a run"
                )
                flow.Flow.NoInference()
                Console.WriteLine("PASS native Pi workflow " + mode)
                return
            }
            if mode == "reasoning" {
                for effort in[]string{"absent", "minimal", "xhigh"} {
                    let rejected = args.ToArray()
                    rejected[Array.IndexOf(rejected, "--effort") + 1] = effort
                    Check.Contains(flow.Flow.Call(rejected, 1).Error, "does not support the selected reasoning effort")
                }
                flow.Flow.Temp.Env["TERM"] = "dumb"
                flow.Flow.Temp.Env["NO_COLOR"] = "1"
                let guided = TerminalOutput.Pty(
                    binary,
                    []string{"work", "owner/project"},
                    flow.Flow.Temp,
                    80,
                    "1\n1\n1\n1\n" + endpoint + "\nsynthetic/model:exact\n1\n1\nq\n"
                )
                Check.That(guided.Code == 1, guided.Output + guided.Error)
                Check.Contains(guided.Output, "Reasoning effort")
                Check.Contains(guided.Output, "Review donation")
                Check.Contains(guided.Output, "synthetic/model:exact / high")
                flow.Flow.NoInference()
                flow.Flow.Call(
                    []string{
                        "defaults",
                        "set",
                        "--profile",
                        "reasoning",
                        "--harness",
                        "pi",
                        "--provider",
                        "local-chat-completions",
                        "--model",
                        "synthetic/model:exact",
                        "--effort",
                        "high",
                        "--endpoint",
                        endpoint
                    }
                )
                Check.Contains(flow.Flow.Call([]string{"defaults", "read", "--profile", "reasoning"}).Output, "high")
            }
            if mode == "off" {
                for option in[]string{"--effort", "--model", "--endpoint"} {
                    let rejected = args.ToArray()
                    rejected[Array.IndexOf(rejected, option) + 1] = "unsupported"
                    flow.Flow.Call(rejected, 1)
                }
            }
            if mode == "off" {
                provider["baseUrl"] = JsonValue.Create("http://127.0.0.1:1/v1")
                File.WriteAllText(modelsPath, models.ToJsonString())
                flow.Flow.Call(args.ToArray(), 1)
                provider["baseUrl"] = JsonValue.Create(endpoint)
                let providers = models["providers"] ?? throw Exception("Missing providers")
                providers["duplicate"] = provider.DeepClone()
                File.WriteAllText(modelsPath, models.ToJsonString())
                flow.Flow.Call(args.ToArray(), 1)
                providers.AsObject().Remove("duplicate")
                File.WriteAllText(modelsPath, models.ToJsonString())
            }
            File.Delete(Path.Combine(flow.Flow.Bin, "codex"))
            File.Delete(Path.Combine(flow.Flow.Bin, "codex-impl"))
            let profilePath = Path.Combine(flow.Flow.Temp.Env["HOME"], ".local/state/tokate/donor-profiles/local.json")
            var originalProfile = ""
            if mode == "off" {
                let stored = flow.Flow.Call(
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
                        endpoint,
                        "--pi-root",
                        root,
                        "--node",
                        node,
                        "--json"
                    }
                )
                Check.Envelope(stored, "defaults", "ok")
                originalProfile = File.ReadAllText(profilePath)
                File.Delete(Path.Combine(flow.Flow.Bin, "pi"))
                let defaultPath = Path.Combine(flow.Flow.Temp.Env["HOME"], ".local/state/tokate/donor-defaults.json")
                File.Copy(profilePath, defaultPath)
                let unnamed = Check.Envelope(
                    flow.Flow.Call(
                        []string{"select", "--repo", "owner/project", "--model", "synthetic/model:exact", "--json"}
                    ),
                    "select",
                    "ok"
                )
                Check.That(
                    Check.Text(unnamed["data"]?["harness"]) == "pi",
                    "Unnamed Pi default rejected a compatible exact override"
                )
                File.Delete(defaultPath)
                for option in[]string{"--harness", "--provider", "--effort", "--endpoint", "--node"} {
                    let position = args.IndexOf(option)
                    args.RemoveAt(position + 1)
                    args.RemoveAt(position)
                }
                args.AddRange([]string{"--profile", "local"})
            }
            let prepared = flow.Flow.Call(args.ToArray())
            let selected = provider["models"]?[0] ?? throw Exception("Missing model")
            selected["maxTokens"] = JsonValue.Create(8192)
            File.WriteAllText(modelsPath, models.ToJsonString())
            let index = prepared.Output.LastIndexOf("Run: ")
            Check.That(index >= 0, "Pi preparation did not return a run")
            let run = prepared.Output.Substring(index + 5).Trim()
            if mode == "off" {
                let state = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
                Check.That(
                    Check.Text(state["selection"]?["source"]) == "saved donor profile local with explicit overrides" &&
                        Check.Text(state["pi_root"]) == root && Check.Text(state["pi_node"]) == node,
                    "Profile preparation lost private runtime overrides or source"
                )
                Check.That(File.ReadAllText(profilePath) == originalProfile, "Pi preparation rewrote its profile")
                flow.Flow.Call([]string{"defaults", "remove", "--profile", "local"})
            }
            let checkout = Path.Combine(run, "checkout")
            let gitPath = Path.Combine(checkout, ".git/config")
            let git = File.ReadAllText(gitPath)
            let secret = Path.Combine(flow.Flow.Temp.Root, "private-credential")
            File.WriteAllText(secret, "PRIVATE_CREDENTIAL_SENTINEL")
            File.WriteAllText(
                Path.Combine(directory, "fixture.json"),
                Check.Map(
                    "checkout",
                    checkout,
                    "run",
                    run,
                    "private",
                    secret,
                    "outside",
                    Path.Combine(flow.Flow.Temp.Root, "denied-write")
                )
                    .ToJsonString()
            )
            let success = mode == "reasoning" ||
                mode == "off" ||
                mode == "on" ||
                mode == "compact" ||
                mode == "continued" ||
                mode == "catalog-metadata"
            let work = List[string]{"work", "--run", run, "--non-interactive"}
            if mode != "off" {
                work.Add("--yes")
            }
            if continuation {
                work.Add("--continue-truncated")
            }
            var worked Result
            if mode == "on" {
                flow.Flow.Temp.Env["TERM"] = "xterm-256color"
                worked = TerminalOutput.Pty(binary, work.ToArray(), flow.Flow.Temp, 100)
                Check.Success(worked)
                Check.Contains(worked.Output, "tokate / Donation")
                Check.Contains(worked.Output, "bash: setsid sh")
                Check.Contains(worked.Output, "Assistant: Changes: synthetic edits.")
                Check.Contains(worked.Output, "Verification 1:")
                Check.Contains(worked.Output, "\x1b[?1049l")
            } else {
                worked = flow.Flow.Call(work.ToArray(), success ? 0: 1)
            }
            let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
            if mode.StartsWith("catalog-recheck-") {
                PrivateCatalog(worked.Output + worked.Error + Check.Text(saved["error"]), endpoint)
                Check.That(
                    Check.Text(saved["state"]) == "failed" && Check.Text(
                        saved["failure_reason"]
                    ) == "endpoint_unavailable",
                    "Changed endpoint did not fail before inference"
                )
                Check.That(
                    saved["turn_completed"] == nil &&
                        saved["observed_invocation"] == nil &&
                        saved["verification"] == nil &&
                        saved["commit"] == nil &&
                        !File.Exists(Path.Combine(run, "events.jsonl")),
                    "Changed endpoint reached inference or verification"
                )
                let status = Check.Envelope(flow.Flow.Call([]string{"status", "--run", run, "--json"}), "status", "ok")
                Check.That(
                    Check.Text(status["data"]?["error"]?["code"]) == "endpoint_unavailable",
                    "Endpoint failure status lost its safe diagnostic"
                )
                flow.Flow.NoInference()
                Console.WriteLine("PASS native Pi workflow " + mode)
                return
            }
            Check.That(
                Check.Text(saved["selection"]?["endpoint_catalog"]?["advertised_model"]) == "synthetic/model:exact" &&
                    Check.Text(saved["endpoint_catalog"]?["advertised_model"]) == "synthetic/model:exact",
                "Pi did not record exact endpoint selection and launch evidence"
            )
            let metadata = Check.Json(
                "{\"runtime_version\":\"1.2.3\",\"digest\":\"sha256:abc123\",\"quantization\":\"Q4_K_M\",\"context_window\":7,\"supports_tools\":false}"
            )
            for name in[]string{"runtime_version", "digest", "quantization", "context_window", "supports_tools"} {
                let expected = mode == "catalog-metadata" ? Check.Text(metadata[name]): "unknown"
                Check.That(
                    Check.Text(saved["endpoint_catalog"]?[name]) == expected,
                    "Pi lost optional metadata or invented absent identity"
                )
            }
            Check.That(
                !saved.ToJsonString().Contains("PRIVATE_CATALOG_SENTINEL"),
                "Pi retained unsupported raw endpoint metadata"
            )
            File.WriteAllText(
                Path.Combine(directory, "result.json"),
                Check.Map(
                    "usage",
                    saved["usage"],
                    "error",
                    Check.Text(saved["error"]),
                    "state",
                    saved["state"],
                    "failure_reason",
                    saved["failure_reason"],
                    "events",
                    File.ReadAllText(Path.Combine(run, "events.jsonl"))
                )
                    .ToJsonString()
            )
            Check.That(
                Check.Text(saved["effort"]) == (mode == "reasoning" ? "high": "absent") && Check.Text(
                    saved["observed_invocation"]?["effort"]
                ) == Check.Text(saved["effort"]),
                "Pi lost selected effort"
            )
            Check.That(
                Check.Text(saved["observed_invocation"]?["length_continuation_limit"]) == (continuation ? "1": "0"),
                "Pi did not record the work invocation's continuation allowance"
            )
            Check.That(
                Check.Text(saved["observed_invocation"]?["context_window"]) == "65536" && Check.Text(
                    saved["observed_invocation"]?["max_tokens"]
                ) == "8192",
                "Pi ignored configured model limits"
            )
            Check.That(
                Check.Text(saved["state"]) == (success ? "generated": "failed"),
                "Pi run reported the wrong final state"
            )
            if success {
                Check.That(Check.Text(saved["turn_completed"]) == "true", "Pi completion was not recorded")
                Check.That(
                    Check.Text(saved["verification"]?[0]?["exit_code"]) == "0",
                    "Independent Pi verification did not pass"
                )
                Check.That(
                    File.ReadAllText(Path.Combine(checkout, "result.txt")) == "final",
                    "Pi tool changes were lost"
                )
                if mode == "continued" {
                    let report = File.ReadAllText(Path.Combine(run, "report.md"))
                    Check.Contains(report, "Changes: synthetic edits.")
                    Check.Contains(report, "Verification: constrained tools.")
                    Check.Contains(report, "Limitations: no inference.")
                    Check.That(
                        !report.Contains("PRIVATE_PARTIAL_LENGTH_SENTINEL"),
                        "Partial output became the final report"
                    )
                }
                flow.Flow.Call([]string{"submit", "--run", run})
                flow.Flow.Reload()
                flow.Coordinate(flow.Event(Check.PostedRequest(flow.Flow.State)))
                flow.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
                flow.Flow.Reload()
                Check.That(flow.Flow.State["pulls"]?.AsArray().Count == 1, "Pi did not produce one draft PR")
                if mode == "continued" {
                    Check.That(
                        !Check.Text(flow.Flow.State["pulls"]?[0]?["body"]).Contains("PRIVATE_PARTIAL_LENGTH_SENTINEL"),
                        "Private partial output escaped into the draft PR"
                    )
                }
            } else {
                Check.That(saved["turn_completed"] == nil, "Failed Pi response fabricated completion")
                Check.That(
                    saved["commit"] == nil && saved["verification"] == nil,
                    "Failed Pi inference reached verification or publication"
                )
                if mode == "repeated" {
                    Check.That(
                        File.ReadAllText(Path.Combine(checkout, "result.txt")) == "final",
                        "Exhausted continuation discarded the prior tool edit"
                    )
                }
            }
            Check.Success(TestProcess.Run("/bin/sleep", []string{"3"}, flow.Flow.Temp.Env))
            Check.That(
                !File.Exists(Path.Combine(checkout, "timeout-escaped")),
                "Pi tool timeout left a live descendant"
            )
            Check.That(File.ReadAllText(secret) == "PRIVATE_CREDENTIAL_SENTINEL", "Pi changed private data")
            Check.That(!File.Exists(Path.Combine(flow.Flow.Temp.Root, "denied-write")), "Pi wrote outside the checkout")
            Check.That(!File.Exists(Path.Combine(checkout, "truncated-executed")), "Pi executed a truncated tool call")
            Check.That(File.ReadAllText(gitPath) == git, "Pi changed Git metadata")
            flow.Flow.NoInference()
            Console.WriteLine("PASS native Pi workflow " + mode)
        }

        private func PrivateCatalog(output string, endpoint string) {
            Check.That(
                !output.Contains(endpoint) && !output.Contains("PRIVATE_CATALOG_SENTINEL"),
                "Pi endpoint diagnostic exposed private data"
            )
        }
    }
}
