package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Text.Json.Nodes

internal class PiChecks {
    shared {
        internal func Run(binary string, root string, node string, directory string, endpoint string, mode string) {
            let flow = CoordinationFixture(binary)
            using let cleanup = mode == "cancel" ? nil: flow
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
                "90",
                "--verification-reserve",
                "30",
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
            File.Delete(Path.Combine(flow.Flow.Bin, "codex"))
            File.Delete(Path.Combine(flow.Flow.Bin, "codex-impl"))
            let prepared = flow.Flow.Call(args.ToArray())
            let index = prepared.Output.LastIndexOf("Run: ")
            Check.That(index >= 0, "Pi preparation did not return a run")
            let run = prepared.Output.Substring(index + 5).Trim()
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
            let success = mode == "off" || mode == "on"
            flow.Flow.Call([]string{"work", "--run", run, "--yes", "--non-interactive"}, success ? 0: 1)
            let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
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
                flow.Flow.Call([]string{"submit", "--run", run})
                flow.Flow.Reload()
                flow.Coordinate(flow.Event(Check.PostedRequest(flow.Flow.State)))
                flow.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
                flow.Flow.Reload()
                Check.That(flow.Flow.State["pulls"]?.AsArray().Count == 1, "Pi did not produce one draft PR")
            } else {
                Check.That(saved["turn_completed"] == nil, "Failed Pi response fabricated completion")
                Check.That(
                    saved["commit"] == nil && saved["verification"] == nil,
                    "Failed Pi inference reached verification or publication"
                )
            }
            Check.Success(TestProcess.Run("/bin/sleep", []string{"3"}, flow.Flow.Temp.Env))
            Check.That(
                !File.Exists(Path.Combine(checkout, "timeout-escaped")),
                "Pi tool timeout left a live descendant"
            )
            Check.That(File.ReadAllText(secret) == "PRIVATE_CREDENTIAL_SENTINEL", "Pi changed private data")
            Check.That(!File.Exists(Path.Combine(flow.Flow.Temp.Root, "denied-write")), "Pi wrote outside the checkout")
            Check.That(File.ReadAllText(gitPath) == git, "Pi changed Git metadata")
            flow.Flow.NoInference()
            Console.WriteLine("PASS native Pi workflow " + mode)
        }
    }
}
