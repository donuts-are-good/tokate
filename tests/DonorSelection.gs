package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Text.Json.Nodes

internal class DonorSelectionChecks {
    shared {
        private func Set(
            flow NativeFlow,
            model string = "gpt-6.1-sol",
            effort string = "high",
            harness string = "codex",
            provider string = "openai"
        ) {
            flow.Call(
                []string{
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
            )
        }

        private func Select(flow NativeFlow, extra[]string, code int32 = 0) JsonNode {
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

        private func Settings(flow NativeFlow) string -> Path.Combine(
            flow.Temp.Env["HOME"],
            ".local/state/tokate/donor-defaults.json"
        )

        private func ExpandPolicy(flow NativeFlow, alternative bool = false) {
            let path = Path.Combine(flow.Upstream, ".github/tokate.json")
            let policy = Check.Json(File.ReadAllText(path))
            policy["models"] = Check.Json(
                alternative ?
                "{\"gpt-6.1-sol\":[\"high\",\"xhigh\",\"minimal\"],\"gpt-6-sol\":[\"high\"]}":
                "{\"gpt-6.1-sol\":[\"high\",\"xhigh\",\"minimal\"]}"
            )
            File.WriteAllText(path, policy.ToJsonString())
            flow.Commit("Selection fixture policy")
            // GitHub's fork network shares upstream objects; this local bare
            // fork needs an explicit fetch after the fixture policy commit.
            flow.Git("-C", Path.Combine(flow.Bin, "fork"), "fetch", flow.Upstream, "main")
        }

        private func LocalSettings(binary string) {
            using let flow = NativeFlow(binary)
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
            using let flow = NativeFlow(binary)
            flow.Initialize()
            ExpandPolicy(flow, true)
            Select(flow, []string{}, 1)
            Set(flow)
            let original = File.ReadAllText(Settings(flow))
            let chosen = Select(flow, []string{})
            Check.That(Check.Text(chosen["source"]) == "saved donor default", "Eligible default did not win")
            Check.That(Check.Text(chosen["availability"]) == "unknown", "Catalog presence proved availability")
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

        private func ConfirmationAndRuns(binary string) {
            using let flow = NativeFlow(binary)
            flow.Initialize()
            flow.Approve()
            Set(flow)
            let noConsent = Check.Run(
                binary,
                []string{
                    "work",
                    "--repo",
                    "owner/project",
                    "--issue",
                    "1",
                    "--runs",
                    Path.Combine(flow.Temp.Root, "runs"),
                    "--non-interactive"
                },
                flow.Temp.Env
            )
            Check.That(noConsent.Code == 1, "Work accepted missing confirmation")
            Check.Contains(noConsent.Error, "confirmation required")
            flow.NoInference()
            Check.That(!Directory.Exists(Path.Combine(flow.Temp.Root, "runs")), "Outstanding consent reserved work")
            let claimed = flow.Call(
                []string{
                    "claim",
                    "--repo",
                    "owner/project",
                    "--issue",
                    "1",
                    "--runs",
                    Path.Combine(flow.Temp.Root, "runs")
                }
            )
            let run = claimed.Output.Substring(claimed.Output.LastIndexOf("Run: ") + 5).Trim()
            let path = Path.Combine(run, "run.json")
            let original = File.ReadAllText(path)
            Set(flow, effort: "xhigh")
            let pending = Check.Run(binary, []string{"work", "--run", run, "--non-interactive"}, flow.Temp.Env)
            Check.That(pending.Code == 1, "Saved work accepted missing confirmation")
            flow.NoInference()
            Check.That(File.ReadAllText(path) == original, "Confirmation changed saved work")
            flow.Mode("capability_changed")
            Check.Contains(flow.Call([]string{"work", "--run", run}, 1).Error, "no longer compatible")
            flow.NoInference()
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

        private func LegacyRun(binary string) {
            using let flow = NativeFlow(binary)
            flow.Initialize()
            flow.Approve()
            let run = flow.Claim()
            let path = Path.Combine(run, "run.json")
            let saved = Check.Json(File.ReadAllText(path))
            saved.AsObject().Remove("selection")
            saved.AsObject().Remove("harness")
            saved.AsObject().Remove("provider")
            File.WriteAllText(path, saved.ToJsonString())
            Set(flow, effort: "xhigh")
            flow.Mode("model_failure")
            let result = Check.Run(binary, []string{"work", "--run", run}, flow.Temp.Env)
            Check.That(result.Code == 1, "Synthetic model failure succeeded")
            Check.Contains(result.Error, "Codex failed")
            flow.Reload()
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "Legacy run changed confirmation behavior")
            Check.That(
                Check.Text(Check.Json(File.ReadAllText(path))["effort"]) == "high",
                "Legacy run used new preferences"
            )
        }

        private func InteractiveChoices(binary string) {
            using let flow = NativeFlow(binary)
            flow.Initialize()
            ExpandPolicy(flow)
            let command = "'" + binary + "' select --repo owner/project"
            let result = Check.Run(
                "/usr/bin/script",
                []string{"-q", "-e", "-c", command, "/dev/null"},
                flow.Temp.Env,
                "2\n"
            )
            Check.Success(result)
            Check.Contains(result.Output, "Choice number")
            Check.Contains(result.Output, "interactive donor choice")
            Check.Contains(result.Output, "xhigh")
            Check.That(!File.Exists(Settings(flow)), "Interactive choice saved preferences implicitly")
            let refused = Check.Run(
                "/usr/bin/script",
                []string{"-q", "-e", "-c", command, "/dev/null"},
                flow.Temp.Env,
                "\n"
            )
            Check.That(refused.Code == 1, "Blank input accepted the first eligible pair")
            Check.Contains(refused.Output, "No inference started")
            // --non-interactive wins even when a terminal is attached.
            let noninteractive = Check.Run(
                "/usr/bin/script",
                []string{"-q", "-e", "-c", command + " --non-interactive", "/dev/null"},
                flow.Temp.Env,
                "1\n"
            )
            Check.That(
                noninteractive.Code == 1 && !noninteractive.Output.Contains("Choice number"),
                "Noninteractive selection hid a prompt"
            )
            flow.Approve()
            Set(flow)
            let work = "'" + binary + "' work --repo owner/project --issue 1 --runs '" + Path.Combine(
                flow.Temp.Root,
                "runs"
            ) +
                "'"
            let declined = Check.Run(
                "/usr/bin/script",
                []string{"-q", "-e", "-c", work, "/dev/null"},
                flow.Temp.Env,
                "n\n"
            )
            Check.That(declined.Code == 1, "Declined confirmation launched work")
            Check.Contains(declined.Output, "[y/N]")
            flow.NoInference()
            flow.NoPr()
            flow.Mode("model_failure")
            let confirmed = Check.Run(
                "/usr/bin/script",
                []string{"-q", "-e", "-c", work, "/dev/null"},
                flow.Temp.Env,
                "y\n"
            )
            Check.That(confirmed.Code == 1, "Synthetic model failure succeeded")
            Check.Contains(confirmed.Output, "Codex failed")
            flow.Reload()
            Check.That(
                Check.Text(flow.State["exec_count"]) == "1",
                "Confirmed terminal work retried or did not execute"
            )
        }

        private func VersionTwo(binary string) {
            using let coordination = CoordinationFlow(binary)
            coordination.Initialize()
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
            let pending = Check.Run(binary, []string{"work", "--run", run, "--non-interactive"}, flow.Temp.Env)
            Check.That(pending.Code == 1, "V2 work accepted missing confirmation")
            flow.NoInference()
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
            flow.NoInference()
        }

        internal func All(binary string) {
            LocalSettings(binary)
            Console.WriteLine("PASS donor defaults set/read/remove and nonsecret storage")
            Choices(binary)
            Console.WriteLine("PASS default/override/refusal, capabilities and availability; zero inference")
            ConfirmationAndRuns(binary)
            Console.WriteLine("PASS confirmation, pinned runs, capability revalidation and no model fallback")
            LegacyRun(binary)
            Console.WriteLine("PASS legacy saved-run pair and behavior")
            InteractiveChoices(binary)
            Console.WriteLine("PASS actual terminal selection and confirmation; zero inference before consent")
            VersionTwo(binary)
            Console.WriteLine("PASS V2 defaults, exact tool policy and declaration conflicts; zero inference")
        }
    }
}
