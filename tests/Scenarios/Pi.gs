package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Text.Json.Nodes

internal class PiChecks {
    shared {
        internal func Run(binary string, root string, node string, directory string, endpoint string, mode string) {
            let flow = CoordinationFixture(binary)
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
            policy["models"] = Check.Json("{\"synthetic/model:exact\":[\"absent\"]}")
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
            flow.Claim()
            let agentDir = Path.Combine(flow.Flow.Temp.Root, "pi-agent")
            Directory.CreateDirectory(agentDir)
            flow.Flow.Temp.Env["PI_CODING_AGENT_DIR"] = agentDir
            let models = Check.Json(
                "{\"providers\":{\"synthetic\":{\"api\":\"openai-completions\",\"authHeader\":false,\"apiKey\":\"PRIVATE_CREDENTIAL_SENTINEL\",\"models\":[{\"id\":\"synthetic/model:exact\",\"name\":\"Synthetic\",\"contextWindow\":65536,\"maxTokens\":4096,\"reasoning\":false,\"input\":[\"text\"]}]}}}"
            )
            let provider = models["providers"]?["synthetic"] ?? throw Exception("Missing synthetic provider")
            provider["baseUrl"] = JsonValue.Create(endpoint)
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
                "absent",
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
            let success = mode == "off" || mode == "on" || mode == "compact" || mode == "continued"
            let work = List[string]{"work", "--run", run, "--non-interactive"}
            if mode != "off" {
                work.Add("--yes")
            }
            if continuation {
                work.Add("--continue-truncated")
            }
            flow.Flow.Call(work.ToArray(), success ? 0: 1)
            let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
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
    }
}
